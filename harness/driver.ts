// Copyright 2026 The VeriHarness Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * VeriHarness driver: run one verification task through an agent runtime: pi (the default, with the
 * local and cloud providers) or Claude Code (`--provider claude-code`, see docs/claude-code.md).
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import * as config from "./config.js";
import {
  copyFile,
  ensureDir,
  fileSize,
  isDir,
  isFile,
  posixRel,
  readJson as readJsonFs,
  walkFiles,
  writeJson as writeJsonFs,
} from "./fsutil.js";
import {
  CLAUDE_CODE_PROVIDER,
  ClaudeRuntime,
  UNSUPPORTED_WITH_CLAUDE_CODE,
  USAGE_LIMIT_EXIT,
  claudeCommand,
  claudeTools,
  isClaudeCodeProvider,
  startCheck,
  claudeSessionEnv,
} from "./claude/index.js";
import { Native, imageFor } from "./env/index.js";
import { canonicalLocalProvider, materializePiHome, prepareLocalProvider, resolveLocalConfig, secondsToMs } from "./model/index.js";
import { isBun, isMain, runWithBudget } from "./runtime.js";
import { isView } from "./views.js";

export { readJsonFs as readJson, writeJsonFs as writeJson };

const JAIL = join(config.SCRIPTS_DIR, "jail_run.sh");

/**
 * The command chain of scripts/jail_run.sh as `unshare` arguments: the namespace flags, then `setpriv`
 * with the flags that drop every capability, then a no-op. The availability probe runs exactly this, so
 * a host whose util-linux lacks `--kill-child` or `setpriv` is refused up front instead of failing
 * every turn. A test keeps it equal to the flags in the script.
 */
export const JAIL_PROBE: readonly string[] = [
  "-r", "-m", "-p", "-f", "--mount-proc", "--kill-child",
  "setpriv", "--bounding-set=-all", "--inh-caps=-all", "--no-new-privs", "--",
  "true",
];

/** Why the mount-namespace jail cannot run on this host, or "" when it can. */
export function jailUnavailable(): string {
  if (!isFile(JAIL)) {
    return `${JAIL} missing`;
  }
  try {
    const p = spawnSync("unshare", [...JAIL_PROBE], {
      encoding: "utf8",
      timeout: 20_000,
    });
    if (p.error) {
      return `unshare: ${p.error.name}`;
    }
    return p.status === 0 ? "" : `unshare/setpriv failed: ${(p.stderr || "").trim().slice(0, 120)}`;
  } catch (e) {
    return `unshare: ${e instanceof Error ? e.name : "Error"}`;
  }
}

const DEFAULT_SKILLS = [
  "evidence-xlsx",
  "evidence-pdf",
  "evidence-docx",
  "evidence-pptx",
  "evidence-patch",
  "evidence-bundle",
  "resolve-answer",
  "resolve-workbook",
  "resolve-bundle",
  "resolve-patch",
  "falsify-answer",
  "falsify-workbook",
  "falsify-bundle",
  "repair-xlsx",
  "repair-prose",
  "repair-bundle",
  "repair-record",
  "repair-patch",
];

const CONTRACTS: Record<string, string> = {
  "pick-only":
    "pick-only. The result for this task is one of the N rollouts, chosen " +
    "as-is by the adjudication that follows the investigations; no new " +
    "artifacts are produced.",
  artifact:
    "artifact. The result delivered for this task is one rollout's bundle, corrected and completed " +
    "in out/ by a later phase from the records this one leaves. Nothing you write is the deliverable.",
};

const TOOLS: Record<string, string> = {
  "pick-only": "read,bash,grep,find,ls",
  artifact: "read,bash,grep,find,ls,edit,write",
};

const INVESTIGATIONS: [string, string, string, string][] = [
  ["elim", "INVESTIGATE_ELIM.md", "LEDGER_ELIM.md", "ledger_elim.json"],
  ["fals", "INVESTIGATE_FALS.md", "LEDGER_FALS.md", "ledger_fals.json"],
];

const NUDGE_LEDGER =
  "You have not written {record} yet. Please write it now, in the LEDGER.md format, " +
  "with what you have; then stop.";
const NUDGE_FINISH =
  "You have not written finish.json yet. Please finish now: write finish.json " + "as instructed.";
const NUDGE_REPAIR =
  "You have not written repair.json yet. Please finish the repair phase now: make sure " +
  "out/deliverables/ holds the bundle you are delivering, then write repair.json as instructed.";

const TRANSIENT = [
  "429",
  "Resource exhausted",
  "RESOURCE_EXHAUSTED",
  "overloaded",
  "529",
  "503",
  "UNAVAILABLE",
  "ECONNRESET",
  "ETIMEDOUT",
  "socket hang up",
];
const RETRY_BACKOFF = [30, 90, 180];

/**
 * True when a failed turn's stderr names a provider or transport fault worth a retry. A status
 * code only counts as a whole number: "41503 tokens" and "0.429" are not a 503 or a 429.
 */
export function isTransient(stderr: string): boolean {
  return TRANSIENT.some((sig) =>
    /^\d+$/.test(sig) ? new RegExp(`(?<![\\d.])${sig}(?!\\d)`).test(stderr) : stderr.includes(sig),
  );
}

/**
 * Variables only the graders read: judge endpoints and keys, and the location of the benchmark
 * checkouts that hold the answer keys. The jail hides the filesystem but a child inherits the
 * environment whole, so a verifier could print these. Matched in any case: Windows ignores case in names.
 */
const GRADER_ONLY_ENV = /^(JB_JUDGE_|APEX_|JUDGE_|WB_LITELLM_|VERIHARNESS_(BENCH_ROOT|WB_INDEX|IMAGE_))/i;

/**
 * The environment for a verifier session: the host's, minus what only a grader may see, plus
 * `VERIHARNESS_JAIL_HIDE`. The jail hides the repo, the data root and `$HOME` by itself; this lists
 * the other places a session must not read, one absolute path per line: the directories the caller
 * already named, the run outputs (sibling runs, archived grades) and the benchmark checkout (answer
 * keys). The checkout's path is read from `host` here because the filter above drops it from the result.
 */
export function agentEnv(host: NodeJS.ProcessEnv, runs: string = config.RUNS): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(host).filter(([name]) => !GRADER_ONLY_ENV.test(name)));
  const bench = host.VERIHARNESS_BENCH_ROOT;
  const hide = [
    ...(host.VERIHARNESS_JAIL_HIDE ?? "").split("\n"),
    runs,
    ...(bench ? [resolve(bench.startsWith("~") ? join(homedir(), bench.slice(1)) : bench)] : []),
  ].filter((p) => p !== "");
  env.VERIHARNESS_JAIL_HIDE = [...new Set(hide)].join("\n");
  return env;
}

/** True when pi has left a session file in `dir`; false when it left none or the dir does not exist. */
export function hasSessionFile(dir: string): boolean {
  if (!isDir(dir)) return false;
  return readdirSync(dir, { withFileTypes: true }).some((e) => e.isFile() && e.name.endsWith(".jsonl"));
}

let logLock = false;

/** Append one timestamped line to the task's `driver.log`. */
export function log(ws: string, msg: string): void {
  const line = `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${msg}`;
  while (logLock) {
    /* spin */
  }
  logLock = true;
  try {
    console.log(line);
    appendFileSync(join(ws, "driver.log"), line + "\n", "utf8");
  } finally {
    logLock = false;
  }
}

/** The name of the rollout that `finish.json` picked as the base; "none" when it picked no rollout. */
export function baseOf(finish: Record<string, unknown>): string {
  const raw = finish.base ?? finish.pick ?? "";
  const name = String(raw || "")
    .trim()
    .replace(/\/$/, "")
    .split("/")
    .pop()!;
  return name.toLowerCase() === "" || ["none", "null"].includes(name.toLowerCase()) ? "none" : name;
}

/**
 * `<ws>/rollouts/<base>` when `base` names one real rollout directory, else null. The base comes
 * from finish.json, which a model wrote, so it must be a single path segment: "..", "r1/.." and
 * "a/b" would otherwise point a read, a copy or a comparison at something that is not a rollout.
 */
export function rolloutDir(ws: string, base: string): string | null {
  if (base === "" || base === "." || base === ".." || basename(base) !== base) return null;
  const dir = join(ws, "rollouts", base);
  return isDir(dir) ? dir : null;
}

/** What a runtime offers the phases of a task: sessions, turns, and the record a session wrote itself. */
export interface Agent {
  readonly ws: string;
  /** A fresh lineage of sessions whose transcripts live under `<ws>/session/<name>`. */
  withSession(name: string): Agent;
  /** Run one turn; true when the runtime says it succeeded. The caller judges the turn by the records it left. */
  turn(message: string, timeout: number, continueSession: boolean, tag?: string): Promise<boolean>;
  /** The text of the record file this session wrote itself (not a file another session left), or null. */
  ownRecord(record: string): string | null;
}

/**
 * Run a turn, and when `output` still does not parse, one nudge turn that continues the session.
 * Resolves to the parsed JSON of `output`, or null.
 */
export async function turnUntil(
  agent: Agent,
  message: string,
  nudge: string,
  output: string,
  timeouts: [number, number],
  continueSession: boolean,
  tag = "",
): Promise<Record<string, unknown> | null> {
  await agent.turn(message, timeouts[0], continueSession, tag);
  let result = readJsonFs<Record<string, unknown>>(output);
  if (result === null) {
    await agent.turn(nudge, timeouts[1], true, tag);
    result = readJsonFs<Record<string, unknown>>(output);
  }
  return result;
}

/** Windows hands a process one command line of at most 32,767 characters (CreateProcess). */
export const WINDOWS_COMMAND_LINE_LIMIT = 32_767;
/** Linux caps a single argument at 131,072 bytes (MAX_ARG_STRLEN) and the list at a few MB. */
export const POSIX_ARG_LIMIT = 131_072;
/** Room kept under the Windows limit: the executable's quoting is not counted exactly. */
const WINDOWS_MARGIN = 767;

/**
 * An upper bound on the characters the command line `cmd` takes on Windows: Node quotes an argument
 * that holds a space, a tab or a quote, and escapes each quote and each backslash it can double.
 */
export function windowsCommandLineLength(cmd: readonly string[]): number {
  let n = Math.max(0, cmd.length - 1);
  for (const arg of cmd) n += arg.length + 2 + (arg.match(/["\\]/g)?.length ?? 0);
  return n;
}

/** True when `cmd` can start as one process on `platform`. */
export function fitsCommandLine(cmd: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return windowsCommandLineLength(cmd) <= WINDOWS_COMMAND_LINE_LIMIT - WINDOWS_MARGIN;
  const bytes = cmd.map((a) => Buffer.byteLength(a));
  return bytes.every((b) => b < POSIX_ARG_LIMIT) && bytes.reduce((a, b) => a + b, 0) < 1_000_000;
}

/** The plan of one pi turn. */
export interface PiTurnPlan {
  /** The command, before a jail or container wraps it. */
  cmd: string[];
  /** Written to the process's stdin when set. */
  input?: string;
  /** Where the message travels: the command line, stdin, or an `@file` argument. */
  via: "argv" | "stdin" | "file";
}

/** The inputs of one pi turn. */
export interface PiTurnInput {
  piCommand: readonly string[];
  flags: readonly string[];
  message: string;
  continueSession: boolean;
  /** True when the process's stdin reaches pi: not through the jail, whose script reads its own stdin, and not through `docker run` without `-i`. */
  canPipe: boolean;
  /** Write `text` to a file pi can read, in the workspace, and return its absolute path. */
  writeFile: (name: string, text: string) => string;
  platform?: NodeJS.Platform;
}

/**
 * The command for one pi turn. The message goes on the command line, as `pi -p ... -- <message>`, when
 * it fits. Mounted skills alone are about 75 KB, so on Windows it often does not; then it travels on
 * stdin (pi 0.84 reads piped stdin as the start of the message in print mode, `readPipedStdin` in
 * main.js) or, where stdin does not reach pi, as an `@file` argument (`buildInitialMessage` in
 * cli/initial-message.js; pi wraps the file's text in a `<file>` tag). If the flags alone are still too long, the
 * charter goes to a file as well: pi reads `--system-prompt` as a path when the path exists
 * (`resolvePromptInput` in core/resource-loader.js). Failing all of that, it throws, with the sizes.
 */
export function planPiCommand(input: PiTurnInput): PiTurnPlan {
  const platform = input.platform ?? process.platform;
  const head = (flags: readonly string[]): string[] => [
    ...input.piCommand,
    "-p",
    ...flags,
    ...(input.continueSession ? ["-c"] : []),
  ];
  const inline = [...head(input.flags), "--", input.message];
  if (fitsCommandLine(inline, platform)) return { cmd: inline, via: "argv" };

  let messageArg: string | undefined;
  const carry = (flags: readonly string[]): PiTurnPlan =>
    input.canPipe
      ? { cmd: head(flags), input: input.message, via: "stdin" }
      : {
          cmd: [...head(flags), "--", (messageArg ??= `@${input.writeFile("turn-message.md", input.message)}`)],
          via: "file",
        };
  let plan = carry(input.flags);
  if (fitsCommandLine(plan.cmd, platform)) return plan;

  const at = input.flags.indexOf("--system-prompt");
  if (at >= 0 && at + 1 < input.flags.length) {
    const flags = [...input.flags];
    flags[at + 1] = input.writeFile("system-prompt.md", flags[at + 1]!);
    plan = carry(flags);
    if (fitsCommandLine(plan.cmd, platform)) return plan;
  }
  const limit = platform === "win32" ? WINDOWS_COMMAND_LINE_LIMIT : POSIX_ARG_LIMIT;
  throw new Error(
    `the pi command line is too long to start (${windowsCommandLineLength(plan.cmd)} characters; ${platform} allows ` +
      `${limit}) even with the message and the charter in files: shorten the --skill list or the --pi-bin path`,
  );
}

/** The command that starts pi: on Windows the default install's `.bin/pi` is a shell script, so run its entry script with Node. */
export function piCommandFor(piBin: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32" && piBin === config.PI_BIN && isFile(config.PI_CLI_JS)) {
    return [isBun ? "node" : process.execPath, config.PI_CLI_JS];
  }
  return [piBin];
}

class Pi implements Agent {
  ws: string;
  piCommand: readonly string[];
  flags: string[];
  useJail: boolean;
  deadline: number;
  native: Native | null;
  piHome: string | null;
  backoff: readonly number[];

  constructor(
    ws: string,
    piCommand: readonly string[],
    flags: string[],
    useJail: boolean,
    deadline: number,
    native: Native | null = null,
    piHome: string | null = null,
    backoff: readonly number[] = RETRY_BACKOFF,
  ) {
    this.ws = ws;
    this.piCommand = piCommand;
    this.flags = flags;
    this.useJail = useJail;
    this.deadline = deadline;
    this.native = native;
    this.piHome = piHome;
    this.backoff = backoff;
  }

  withSession(name: string): Pi {
    const sessionDir = join(this.ws, "session", name);
    ensureDir(sessionDir);
    const flags = [...this.flags];
    const idx = flags.indexOf("--session-dir");
    flags[idx + 1] = sessionDir;
    return new Pi(this.ws, this.piCommand, flags, this.useJail, this.deadline, this.native, this.piHome, this.backoff);
  }

  get sessionDir(): string {
    const idx = this.flags.indexOf("--session-dir");
    return this.flags[idx + 1]!;
  }

  inNative(native: Native): Pi {
    return new Pi(this.ws, this.piCommand, this.flags, this.useJail, this.deadline, native, this.piHome, this.backoff);
  }

  ownRecord(record: string): string | null {
    return ownRecord(this.sessionDir, record);
  }

  /** The command for one turn, and what goes to its stdin. See `planPiCommand`. */
  _cmd(message: string, continueSession: boolean, env: NodeJS.ProcessEnv): [string[], string | null, string | undefined] {
    const plan = planPiCommand({
      piCommand: this.piCommand,
      flags: this.flags,
      message,
      continueSession,
      canPipe: this.native === null && !this.useJail,
      writeFile: (name, text) => {
        ensureDir(this.sessionDir);
        const path = join(this.sessionDir, name);
        writeFileSync(path, text, "utf8");
        return path;
      },
    });
    if (this.native !== null) {
      const [wrapped, name] = this.native.wrap(plan.cmd, env as Record<string, string>);
      return [wrapped, name, plan.input];
    }
    return [this.useJail ? [JAIL, this.ws, ...plan.cmd] : plan.cmd, null, plan.input];
  }

  async turn(message: string, timeout: number, continueSession: boolean, tag = ""): Promise<boolean> {
    const env = agentEnv(process.env);
    if (this.piHome) env.PI_CODING_AGENT_DIR = this.piHome;
    else env.PI_CODING_AGENT_DIR ??= config.PI_HOME;
    env.GOOGLE_CLOUD_LOCATION ??= "global";
    env.PI_SKIP_VERSION_CHECK ??= "1";
    env.VERIHARNESS_DATA = config.DATA;

    for (let attempt = 0; attempt < this.backoff.length + 1; attempt++) {
      const budget = Math.min(timeout, this.deadline - Date.now() / 1000);
      if (!(budget > 0)) {
        log(this.ws, `${tag}task deadline reached before turn start; skipping turn`);
        return false;
      }
      log(
        this.ws,
        `${tag}pi turn (continue=${continueSession}, attempt=${attempt + 1}, budget=${Math.floor(budget)}s` +
          `${this.native ? ", native " + this.native.image : ""})`,
      );
      let cmd: string[];
      let container: string | null;
      let input: string | undefined;
      try {
        [cmd, container, input] = this._cmd(message, continueSession, env);
      } catch (e) {
        log(this.ws, `${tag}pi did not start: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
      const run = await runWithBudget(cmd, {
        cwd: this.ws,
        env,
        budgetMs: budget * 1000,
        input,
        onKill: container && this.native ? () => this.native!.kill(container) : undefined,
      });

      if (run.spawnError !== undefined) {
        log(this.ws, `${tag}pi did not start: ${run.spawnError} (command: ${cmd[0]})`);
        return false;
      }
      if (run.timedOut) {
        log(this.ws, `${tag}pi turn timed out after ${Math.floor(budget)}s (process tree killed)`);
        return false;
      }

      const rc = run.code ?? 1;
      log(this.ws, `${tag}pi exited rc=${rc}`);
      if (rc === 0) {
        return true;
      }
      log(
        this.ws,
        `${tag}pi stderr (tail${run.stderrCut ? ", the start was cut" : ""}): ${run.stderr.slice(-2000)}`,
      );
      if (!isTransient(run.stderr) || attempt === this.backoff.length) {
        return false;
      }
      log(this.ws, `${tag}transient provider error; retrying in ${this.backoff[attempt]}s`);
      await new Promise((r) => setTimeout(r, this.backoff[attempt]! * 1000));
      continueSession = hasSessionFile(this.sessionDir);
    }
    return false;
  }
}

function frontmatter(text: string): [Record<string, string>, string] {
  if (!text.startsWith("---")) return [{}, text];
  const end = text.indexOf("\n---", 3);
  if (end === -1) return [{}, text];
  const fields: Record<string, string> = {};
  const block = text.slice(3, end);
  for (const line of block.split("\n")) {
    const m = /^([\w-]+):\s*(.+?)\s*$/.exec(line);
    if (m) fields[m[1]!] = m[2]!;
  }
  return [fields, text.slice(end + 4).replace(/^\n/, "")];
}

function globs(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((g) => g.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function fnmatch(name: string, pattern: string): boolean {
  const re =
    "^" +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".") +
    "$";
  return new RegExp(re).test(name);
}

const SKILLS_MODES = ["mounted", "auto"] as const;

/** Render the skill library into the mission text, in the mode the contract asks for. */
export function renderSkills(
  skillPaths: string[],
  ws: string,
  phase: string,
  mode: string = "mounted",
  runtime: "pi" | "claude-code" = "pi",
): string {
  const rolloutsDir = join(ws, "rollouts");
  const delivered = new Set<string>();
  if (isDir(rolloutsDir)) {
    // <rollout>/deliverables/**, as the Python globbed it. Matching "/deliverables/" anywhere in the
    // absolute path never matched on Windows (backslashes) and matched EVERY file, trajectories
    // included, when the workspace itself sat under a directory called "deliverables". The harness's
    // own rendered views are not deliverables either (CHARTER.md says never to count one).
    for (const p of walkFiles(rolloutsDir)) {
      const parts = posixRel(rolloutsDir, p).split("/");
      if (parts.length >= 3 && parts[1] === "deliverables" && !isView(basename(p))) {
        delivered.add(basename(p));
      }
    }
  }
  const parts: string[] = [];
  for (const sp of skillPaths) {
    const d = sp;
    const f = isDir(d) ? join(d, "SKILL.md") : d;
    if (!isFile(f)) continue;
    const [fields, body] = frontmatter(readFileSync(f, "utf8"));
    const phases = globs(fields.phase);
    const applies = globs(fields["applies-to"]);
    if (phases.length && !phases.includes(phase)) continue;
    const name = isDir(d) ? basename(d) : basename(f, ".md");
    if (mode === "auto") {
      const desc = (fields.description || "").split(/\s+/).join(" ");
      const scope = applies.length ? ` Written for: ${applies.join(", ")}.` : "";
      parts.push(`- **${name}**: ${desc}${scope}\n  Location: ${resolve(f)}`);
      continue;
    }
    if (applies.length && !applies.some((g) => [...delivered].some((n) => fnmatch(n, g)))) {
      continue;
    }
    parts.push(`## ${name}\n\nSkill directory: ${resolve(dirname(f))}\n\n${body.trimEnd()}\n`);
  }
  if (!parts.length) return "";
  if (mode === "auto") {
    return (
      "\n\n# Evidence instruments available for this turn\n\nNone is loaded. Read a skill's file with the " +
      `${runtime === "pi" ? "read" : "Read"} tool when you judge it useful for what this task delivered; skip the ones that are not. ` +
      "Relative paths inside a skill resolve against its directory.\n\n" +
      parts.join("\n") +
      "\n"
    );
  }
  return (
    "\n\n# Evidence instruments\n\nThe skills " +
    (runtime === "pi" ? "listed in your system prompt" : "for this turn") +
    ", in full. Relative paths in them resolve against the skill directory given for each.\n\n" +
    parts.join("\n")
  );
}

function bundleFiles(root: string): Set<string> {
  const out = new Set<string>();
  if (!isDir(root)) return out;
  for (const p of walkFiles(root)) {
    if (!isView(basename(p))) {
      out.add(posixRel(root, p));
    }
  }
  return out;
}

/** Check `out/deliverables` against the chosen base; the result says whether the bundle is valid and why not. */
export function validateDelivery(ws: string, base: string): Record<string, unknown> {
  const out = join(ws, "out", "deliverables");
  if (!isDir(out)) {
    return { valid: false, reason: "out/deliverables missing" };
  }
  const have = bundleFiles(out);
  if (base === "none") {
    const nonempty = [...have].filter((f) => fileSize(join(out, f)) > 0).sort();
    if (!nonempty.length) {
      return { valid: false, reason: "base none and out/deliverables empty", n_base: 0, n_out: 0 };
    }
    return { valid: true, n_base: 0, n_out: nonempty.length, added: nonempty.slice(0, 20) };
  }
  const baseRoot = rolloutDir(ws, base);
  const baseDir = baseRoot === null ? null : join(baseRoot, "deliverables");
  if (baseDir === null || !isDir(baseDir)) {
    return {
      valid: false,
      reason: `base rollout '${base}' has no deliverables dir (base must be the name of a rollout)`,
    };
  }
  const need = bundleFiles(baseDir);
  const missing = [...need].filter((f) => !have.has(f)).sort();
  const empty = [...need]
    .filter((f) => have.has(f))
    .filter((f) => fileSize(join(out, f)) === 0 && fileSize(join(baseDir, f)) > 0)
    .sort();
  if (missing.length || empty.length) {
    return {
      valid: false,
      reason: `missing ${missing.slice(0, 5)} empty ${empty.slice(0, 5)}`,
      n_base: need.size,
      n_out: have.size,
    };
  }
  return {
    valid: true,
    n_base: need.size,
    n_out: have.size,
    added: [...have].filter((f) => !need.has(f)).sort().slice(0, 20),
  };
}

/** Remove the harness views from `out/deliverables`, then restore the base files that are missing or empty there; returns the restored paths. */
export function completeBundle(ws: string, base: string): string[] {
  const out = join(ws, "out", "deliverables");
  if (isDir(out)) {
    for (const p of walkFiles(out)) {
      if (isView(basename(p))) {
        unlinkSync(p);
      }
    }
  }
  const baseRoot = base === "none" ? null : rolloutDir(ws, base);
  const baseDir = baseRoot === null ? null : join(baseRoot, "deliverables");
  if (baseDir === null || !isDir(baseDir)) {
    return [];
  }
  const restored: string[] = [];
  for (const rel of [...bundleFiles(baseDir)].sort()) {
    const src = join(baseDir, rel);
    const dst = join(out, rel);
    if (!isFile(dst) || (fileSize(dst) === 0 && fileSize(src) > 0)) {
      ensureDir(dirname(dst));
      copyFile(src, dst);
      restored.push(rel);
    }
  }
  return restored;
}

function digestFile(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** The files of `out/deliverables` that differ from the base rollout. */
export function changedFiles(ws: string, base: string): string[] {
  const out = join(ws, "out", "deliverables");
  const baseRoot = rolloutDir(ws, base);
  if (!isDir(out)) return [];
  return [...bundleFiles(out)]
    .filter((rel) => {
      const outP = join(out, rel);
      const baseP = baseRoot === null ? null : join(baseRoot, "deliverables", rel);
      return baseP === null || !isFile(baseP) || digestFile(outP) !== digestFile(baseP);
    })
    .sort();
}

/** The parsed command line of the driver. */
export interface DriverArgs {
  contract: string;
  provider?: string;
  model?: string;
  thinking?: string;
  skill: string[];
  noSkills: boolean;
  skillsMode: string;
  piBin: string;
  /** The Claude Code executable (`--claude-bin`); unset means VERIHARNESS_CLAUDE_BIN, then `claude`. */
  claudeBin?: string;
  env: string;
  turnTimeout: number;
  nudgeTimeout: number;
  taskTimeout: number;
  baseUrl?: string;
  contextSize?: number;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  /** HTTP timeout for local-model preflight, in seconds. */
  requestTimeout?: number;
}

/** The runtime a task runs on, as `renderSkills` names it. */
function runtimeOf(args: DriverArgs): "pi" | "claude-code" {
  return args.provider === CLAUDE_CODE_PROVIDER ? "claude-code" : "pi";
}

async function investigate(
  agent: Agent,
  args: DriverArgs,
  mission: string,
  skills: string[],
  spec: [string, string, string, string],
): Promise<boolean> {
  const [name, playbook, ledgerDoc, record] = spec;
  const ws = agent.ws;
  ensureDir(join(ws, name));
  writeFileSync(
    join(ws, name, "LEDGER.md"),
    readFileSync(join(config.PROMPTS_DIR, ledgerDoc), "utf8"),
    "utf8",
  );
  const message =
    mission +
    "\n\n" +
    readFileSync(join(config.PROMPTS_DIR, playbook), "utf8") +
    renderSkills(skills, ws, name, args.skillsMode, runtimeOf(args));
  const tag = `[${name}] `;
  log(ws, `${tag}investigation: ${playbook}`);
  const session = agent.withSession(name);
  await session.turn(message, args.turnTimeout, false, tag);
  if (session.ownRecord(join(ws, record)) === null) {
    await session.turn(NUDGE_LEDGER.replace("{record}", record), args.nudgeTimeout, true, tag);
  }
  const own = session.ownRecord(join(ws, record));
  let ledger: Record<string, unknown> | null = null;
  if (own !== null) {
    try {
      ledger = JSON.parse(own) as Record<string, unknown>;
    } catch {
      ledger = null;
    }
  }
  if (ledger === null) {
    log(ws, `${tag}no ${record} of its own after nudge`);
    return false;
  }
  writeFileSync(join(ws, name, record), own!, "utf8");
  log(
    ws,
    `${tag}${record}: disagreements=${(ledger.disagreements as unknown[] | undefined)?.length ?? 0} ` +
      `challenges=${(ledger.challenges as unknown[] | undefined)?.length ?? 0}`,
  );
  return true;
}

function ownRecord(sessionDir: string, record: string): string | null {
  let last: ["write", string] | ["shell", null] | null = null;
  const recordName = basename(record);
  if (!isDir(sessionDir)) return null;
  const files = readdirSync(sessionDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  for (const fn of files) {
    const lines = readFileSync(join(sessionDir, fn), "utf8").split("\n");
    for (const line of lines) {
      if (!line.includes(recordName) || !line.includes('"toolCall"')) continue;
      let parsed: { message?: { content?: unknown[] } };
      try {
        parsed = JSON.parse(line) as { message?: { content?: unknown[] } };
      } catch {
        continue;
      }
      const parts = parsed.message?.content ?? [];
      for (const part of parts as { type?: string; name?: string; arguments?: Record<string, unknown> }[]) {
        if (part.type !== "toolCall") continue;
        const a = part.arguments ?? {};
        if (part.name === "write" && String(a.path ?? "").endsWith(recordName)) {
          last = ["write", String(a.content ?? "")];
        } else if (part.name === "bash" && JSON.stringify(a).includes(recordName)) {
          last = ["shell", null];
        }
      }
    }
  }
  if (last === null) return null;
  if (last[0] === "write") {
    try {
      JSON.parse(last[1]);
      return last[1];
    } catch {
      return null;
    }
  }
  if (readJsonFs(record) !== null && isFile(record)) {
    return readFileSync(record, "utf8");
  }
  return null;
}

function restoreRecords(ws: string): void {
  for (const [name, , , record] of INVESTIGATIONS) {
    const own = join(ws, name, record);
    const root = join(ws, record);
    if (isFile(own)) {
      if (!isFile(root) || !readFileSync(root).equals(readFileSync(own))) {
        copyFile(own, root);
        log(ws, `[${name}] ${record} restored from its own session's copy (it had been overwritten)`);
      }
    } else if (isFile(root)) {
      renameSync(root, join(ws, name, record + ".foreign"));
      log(ws, `[${name}] ${record} was written by another session; set aside`);
    }
  }
}

async function adjudicate(agent: Agent, args: DriverArgs, skills: string[]): Promise<Record<string, unknown> | null> {
  log(agent.ws, "adjudication: ADJUDICATE.md (fresh session)");
  const message =
    readFileSync(join(config.PROMPTS_DIR, "ADJUDICATE.md"), "utf8") +
    renderSkills(skills, agent.ws, "adjudicate", args.skillsMode, runtimeOf(args));
  return turnUntil(
    agent,
    message,
    NUDGE_FINISH,
    join(agent.ws, "finish.json"),
    [args.turnTimeout, args.nudgeTimeout],
    false,
  );
}

async function deliver(
  agent: Agent,
  args: DriverArgs,
  finish: Record<string, unknown>,
  skills: string[],
): Promise<void> {
  const ws = agent.ws;
  const base = baseOf(finish);
  const baseLine =
    base !== "none"
      ? `\n\nThe adjudication named \`${base}\` as the base.\n`
      : "\n\nThe adjudication found no candidate worth starting from (base none): " +
        "build the deliverable from the inputs.\n";
  const message =
    readFileSync(join(config.PROMPTS_DIR, "REPAIR.md"), "utf8") +
    baseLine +
    renderSkills(skills, ws, "repair", args.skillsMode, runtimeOf(args));
  ensureDir(join(ws, "out", "deliverables"));
  log(ws, "delivery: REPAIR.md (continuing adjudication session)");
  const repair = await turnUntil(
    agent,
    message,
    NUDGE_REPAIR,
    join(ws, "repair.json"),
    [args.turnTimeout, args.nudgeTimeout],
    true,
  );
  const restored = completeBundle(ws, base);
  const repairBlock = {
    written: repair !== null,
    ...validateDelivery(ws, base),
    restored: restored.slice(0, 20),
    changed: changedFiles(ws, base).slice(0, 50),
    applied: Boolean(repair?.applied),
    changes: repair?.changes,
  };
  finish.repair = repairBlock;
  writeJsonFs(join(ws, "finish.json"), finish);
  log(ws, `repair: ${JSON.stringify(repairBlock).slice(0, 600)}`);
}

/**
 * Skill names become absolute paths. A bare name lives under the harness skills directory; anything
 * with a separator (either kind, so a Windows path counts) is a path. It is made absolute because
 * pi runs with the workspace as its cwd, so a relative path would name a different place to pi than
 * to this process, which reads the same SKILL.md to render it.
 */
export function resolveSkills(names: string[]): string[] {
  return names.map((s) => (/[\\/]/.test(s) ? resolve(s) : resolve(join(config.SKILLS_DIR, s))));
}

function optionalNumber(name: string, raw: string | undefined): number | undefined | { error: string } {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return { error: `invalid ${name} '${raw}'` };
  return n;
}

/**
 * A timeout in seconds: finite and above zero. Number("abc") is NaN, and a NaN budget reached
 * setTimeout, which fires at once, so the turn was killed after one millisecond with nothing logged
 * to say why; 0 and negative values skipped every turn as "deadline reached".
 */
function positiveSeconds(name: string, raw: string | undefined, fallback: number): number | { error: string } {
  const text = raw ?? String(fallback);
  const n = text.trim() === "" ? Number.NaN : Number(text);
  if (!Number.isFinite(n) || n <= 0) {
    return { error: `invalid ${name} '${text}' (expected a positive number of seconds)` };
  }
  return n;
}

const ENVS = ["jail", "none", "native", "native-full"] as const;

/**
 * Why `--provider claude-code` cannot run with these options, or null. It needs `--env none`: the jail
 * replaces $HOME, so Claude Code would find no login inside it, and the container runs pi only. It needs
 * `--model`, a full model id, so a run stays reproducible when an alias moves. The options that
 * configure a local model server or pi's thinking level have no Claude Code counterpart: they are
 * refused rather than ignored, because an ignored `--temperature` reads as one that took effect.
 */
export function claudeCodeRefusal(env: string, model: string | undefined, given: Record<string, unknown>): string | null {
  if (env !== "none") {
    return (
      `--provider claude-code needs --env none (got --env ${env}): the jail replaces $HOME, so Claude Code would ` +
      "find no login in it, and containers run pi only. --env none runs the verifier's Bash tool on the host."
    );
  }
  if (model === undefined || model.trim() === "") {
    return "--model is required for --provider claude-code (a full model id, e.g. claude-haiku-4-5-20251001)";
  }
  const unsupported = UNSUPPORTED_WITH_CLAUDE_CODE.filter((name) => given[name] !== undefined);
  if (unsupported.length) {
    return `${unsupported.map((n) => "--" + n).join(", ")} not supported with --provider claude-code`;
  }
  return null;
}

/** Parse the driver command line into a workspace and its arguments, or an error message. */
export function parseDriverArgv(argv: string[]): { ws: string; args: DriverArgs } | { error: string } {
  const skillsFromArgv: string[] = [];
  const passthrough: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--skill" || a.startsWith("--skill=")) {
      const value = a === "--skill" ? argv[++i] : a.slice("--skill=".length);
      if (value === undefined || value === "" || value.startsWith("--")) {
        return { error: "--skill needs a skill name or path" };
      }
      skillsFromArgv.push(value);
    } else {
      passthrough.push(a);
    }
  }
  try {
    const { values, positionals } = parseArgs({
      args: passthrough,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h", default: false },
        contract: { type: "string", default: "artifact" },
        provider: { type: "string" },
        model: { type: "string" },
        thinking: { type: "string" },
        "no-skills": { type: "boolean", default: false },
        "skills-mode": { type: "string", default: "mounted" },
        "pi-bin": { type: "string", default: config.PI_BIN },
        "claude-bin": { type: "string" },
        env: { type: "string", default: "jail" },
        "turn-timeout": { type: "string", default: "1800" },
        "nudge-timeout": { type: "string", default: "600" },
        "task-timeout": { type: "string", default: "3600" },
        "base-url": { type: "string" },
        "context-size": { type: "string" },
        temperature: { type: "string" },
        "max-tokens": { type: "string" },
        "top-p": { type: "string" },
        "request-timeout": { type: "string" },
      },
    });
    if (values.help) {
      return { error: "HELP" };
    }
    if (!positionals.length) {
      return { error: "ws positional required" };
    }
    const skillsMode = String(values["skills-mode"] ?? "mounted");
    if (!SKILLS_MODES.includes(skillsMode as (typeof SKILLS_MODES)[number])) {
      return { error: `invalid skills-mode ${skillsMode}` };
    }
    const contract = String(values.contract ?? "artifact");
    if (!Object.hasOwn(CONTRACTS, contract)) {
      return { error: `invalid contract ${contract}` };
    }
    const env = String(values.env ?? "jail");
    if (!ENVS.includes(env as (typeof ENVS)[number])) {
      return { error: `invalid --env '${env}' (expected ${ENVS.join("|")})` };
    }
    const turnTimeout = positiveSeconds("--turn-timeout", values["turn-timeout"] as string | undefined, 1800);
    if (typeof turnTimeout === "object") return turnTimeout;
    const nudgeTimeout = positiveSeconds("--nudge-timeout", values["nudge-timeout"] as string | undefined, 600);
    if (typeof nudgeTimeout === "object") return nudgeTimeout;
    const taskTimeout = positiveSeconds("--task-timeout", values["task-timeout"] as string | undefined, 3600);
    if (typeof taskTimeout === "object") return taskTimeout;
    const contextSize = optionalNumber("context-size", values["context-size"] as string | undefined);
    if (contextSize && typeof contextSize === "object") return contextSize;
    const temperature = optionalNumber("temperature", values.temperature as string | undefined);
    if (temperature && typeof temperature === "object") return temperature;
    const maxTokens = optionalNumber("max-tokens", values["max-tokens"] as string | undefined);
    if (maxTokens && typeof maxTokens === "object") return maxTokens;
    const topP = optionalNumber("top-p", values["top-p"] as string | undefined);
    if (topP && typeof topP === "object") return topP;
    const requestTimeout = optionalNumber("request-timeout", values["request-timeout"] as string | undefined);
    if (requestTimeout && typeof requestTimeout === "object") return requestTimeout;
    const rawProvider = values.provider as string | undefined;
    const provider = isClaudeCodeProvider(rawProvider)
      ? CLAUDE_CODE_PROVIDER
      : (canonicalLocalProvider(rawProvider) ?? rawProvider);
    if (provider === CLAUDE_CODE_PROVIDER) {
      const refusal = claudeCodeRefusal(env, values.model as string | undefined, values as Record<string, unknown>);
      if (refusal !== null) return { error: refusal };
    }
    return {
      ws: positionals[0]!,
      args: {
        contract,
        provider,
        model: values.model as string | undefined,
        thinking: values.thinking as string | undefined,
        skill: skillsFromArgv,
        noSkills: Boolean(values["no-skills"]),
        skillsMode,
        piBin: String(values["pi-bin"]),
        claudeBin: values["claude-bin"] as string | undefined,
        env,
        turnTimeout,
        nudgeTimeout,
        taskTimeout,
        baseUrl: values["base-url"] as string | undefined,
        contextSize: contextSize as number | undefined,
        temperature: temperature as number | undefined,
        maxTokens: maxTokens as number | undefined,
        topP: topP as number | undefined,
        requestTimeout: requestTimeout as number | undefined,
      },
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** What `main` takes from outside the command line: tests replace the runtimes and the waits with stubs. */
export interface DriverDeps {
  /** The command that starts pi (default: `piCommandFor(--pi-bin)`). */
  piCommand?: readonly string[];
  /** The command that starts Claude Code (default: `--claude-bin`, VERIHARNESS_CLAUDE_BIN, then `claude`). */
  claudeCommand?: readonly string[];
  /** Seconds to wait before each retry of a transient failure (default `RETRY_BACKOFF`). */
  backoff?: readonly number[];
  /** Replaces the wait between Claude Code retries. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The phases every runtime shares: the two investigations in parallel, the adjudication, then, on the
 * artifact contract, the repair. `adjudicator` is called once the investigations have left their
 * records, so a runtime can change where it runs between the phases. Resolves to the exit code.
 */
async function runPhases(
  investigator: Agent,
  adjudicator: () => Agent,
  args: DriverArgs,
  mission: string,
  skills: string[],
): Promise<number> {
  const ws = investigator.ws;
  const ok = await Promise.all(
    INVESTIGATIONS.map((spec) => investigate(investigator, args, mission, skills, spec)),
  );
  restoreRecords(ws);
  if (!ok.every(Boolean)) {
    log(ws, "an investigation left no record; recording no-output");
    return 1;
  }

  const agent = adjudicator();
  const finish = await adjudicate(agent, args, skills);
  if (finish === null) {
    log(ws, "no finish.json after nudge; recording no-output");
    return 1;
  }
  log(
    ws,
    `finish: base=${baseOf(finish)} work=${(finish.work as unknown[] | undefined)?.length ?? 0} ` +
      `open=${(finish.open as unknown[] | undefined)?.length ?? 0}`,
  );

  if (args.contract === "artifact") {
    await deliver(agent, args, finish, skills);
  }
  return 0;
}

/**
 * The directories outside the workspace a Claude Code verifier is allowed to read, for `--add-dir`: the
 * harness skills directory once, and the directory of any other skill. A skill is a directory or a file.
 */
export function skillRoots(skills: readonly string[], skillsDir: string = config.SKILLS_DIR): string[] {
  const roots = new Set<string>();
  for (const skill of skills) {
    const dir = isDir(skill) ? skill : dirname(skill);
    const rel = relative(skillsDir, dir);
    const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    roots.add(inside ? skillsDir : dir);
  }
  return [...roots];
}

/** One task through Claude Code. The records, the phases and the scoring are the same as for pi. */
async function runClaudeCode(
  ws: string,
  args: DriverArgs,
  deps: DriverDeps,
  charter: string,
  mission: string,
  skills: string[],
): Promise<number> {
  // A verifier started from inside a Claude Code session must not inherit that session's identity.
  const env = claudeSessionEnv(agentEnv(process.env));
  const command = deps.claudeCommand ?? claudeCommand(args.claudeBin, process.env);
  const started = startCheck(command, env);
  if (!started.ok) {
    process.stderr.write(`error: ${started.error}\n`);
    return 2;
  }
  log(ws, "no isolation (--env none): the verifier's Bash tool runs directly on the host");
  log(
    ws,
    "WARNING: no jail for claude-code lanes: VERIHARNESS_JAIL_HIDE is not enforced, so this verifier can read " +
      "other tasks' results, archived grades and benchmark answer keys; scores from this lane are not protected against that",
  );

  // The charter goes in a file and the message on stdin: with mounted skills they are longer than the
  // 32,767 characters a Windows command line holds.
  const charterFile = join(ws, "session", "charter.md");
  ensureDir(dirname(charterFile));
  writeFileSync(charterFile, charter, "utf8");

  const runtime = new ClaudeRuntime({
    ws,
    command,
    model: args.model!,
    tools: claudeTools(TOOLS[args.contract]!),
    charterFile,
    addDirs: skillRoots(skills),
    env,
    deadline: Date.now() / 1000 + args.taskTimeout,
    backoff: deps.backoff ?? RETRY_BACKOFF,
    log: (message) => log(ws, message),
    sleep: deps.sleep,
  });
  // A driver that is killed still gives the saved copies back.
  const onExit = (): void => runtime.finish();
  process.once("exit", onExit);
  try {
    let code = await runPhases(runtime.session(""), () => runtime.session("adjudicate"), args, mission, skills);
    if (runtime.usageLimit !== null) {
      // The limit is the account's, not the task's: say so in the record, and let the runner stop the lane.
      const finish = readJsonFs<Record<string, unknown>>(join(ws, "finish.json"));
      if (finish !== null) {
        finish.repair = { ...(finish.repair as object | undefined), error: "usage-limit" };
        writeJsonFs(join(ws, "finish.json"), finish);
      }
      log(ws, `usage-limit: ${runtime.usageLimit}`);
      code = USAGE_LIMIT_EXIT;
    }
    return code;
  } finally {
    runtime.finish();
    process.removeListener("exit", onExit);
  }
}

/** Run one task workspace; returns the exit code. */
export async function main(argv: string[] = process.argv.slice(2), deps: DriverDeps = {}): Promise<number> {
  const parsed = parseDriverArgv(argv);
  if ("error" in parsed) {
    if (parsed.error === "HELP") {
      process.stdout.write(
        "usage: veriharness driver <ws> [--contract artifact|pick-only] [--provider P] [--model M] " +
          "[--thinking T] [--base-url URL] [--context-size N] [--temperature N] [--max-tokens N] [--top-p N] " +
          "[--request-timeout S] [--skill NAME]... [--no-skills] [--skills-mode mounted|auto] " +
          "[--env jail|none|native|native-full] [--turn-timeout S] [--nudge-timeout S] [--task-timeout S] " +
          "[--pi-bin PATH] [--claude-bin PATH]\n" +
          "local providers: --provider ollama (default http://127.0.0.1:11434) or --provider llamacpp " +
          "(default http://127.0.0.1:8080). Both need --model. No API key.\n" +
          "Claude Code: --provider claude-code --model <full model id> --env none. Uses the login Claude Code " +
          "holds (or ANTHROPIC_API_KEY). See docs/claude-code.md.\n",
      );
      return 0;
    }
    process.stderr.write(`error: ${parsed.error}\n`);
    return 2;
  }
  const { ws: wsArg, args } = parsed;
  const ws = resolve(wsArg);
  if (!isDir(join(ws, "rollouts"))) {
    process.stderr.write(`error: ${join(ws, "rollouts")} not found\n`);
    return 2;
  }
  let nRollouts = 0;
  for (const ent of readdirSync(join(ws, "rollouts"), { withFileTypes: true })) {
    if (ent.isDirectory()) nRollouts++;
  }
  ensureDir(join(ws, "out"));
  const skills = args.noSkills ? [] : resolveSkills(args.skill.length ? args.skill : DEFAULT_SKILLS);

  const charter = readFileSync(join(config.PROMPTS_DIR, "CHARTER.md"), "utf8");
  const mission = readFileSync(join(config.PROMPTS_DIR, "MISSION.md"), "utf8")
    .replace("{{N}}", String(nRollouts))
    .replace("{{OUTPUT_CONTRACT}}", CONTRACTS[args.contract]!);
  writeFileSync(join(ws, "MISSION.md"), mission, "utf8");

  let localPiHome: string | null = null;
  if (canonicalLocalProvider(args.provider)) {
    try {
      const prepared = await prepareLocalProvider(
        resolveLocalConfig({
          provider: args.provider,
          model: args.model,
          baseUrl: args.baseUrl,
          temperature: args.temperature,
          topP: args.topP,
          maxTokens: args.maxTokens,
          contextSize: args.contextSize,
          timeoutMs: args.requestTimeout === undefined ? undefined : secondsToMs(args.requestTimeout, "request timeout"),
        }),
      );
      args.provider = prepared.config.provider;
      args.model = prepared.model;
      localPiHome = join(ws, ".pi");
      materializePiHome(localPiHome, prepared.piProvider);
      for (const warning of prepared.warnings) log(ws, `local model: ${warning}`);
      log(
        ws,
        `local model ${prepared.config.provider} ${prepared.model} at ${prepared.config.baseUrl} ` +
          `tools=${String(prepared.probe.capabilities.tools)}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error: ${message}\n`);
      return 2;
    }
  }

  const flags = [
    "--no-context-files",
    "--no-extensions",
    "--no-prompt-templates",
    "--no-skills",
    "--tools",
    TOOLS[args.contract]!,
    "--session-dir",
    join(ws, "session"),
    "--system-prompt",
    charter,
  ];
  for (const skill of skills) {
    flags.push("--skill", skill);
  }
  for (const opt of ["provider", "model", "thinking"] as const) {
    const v = args[opt];
    if (v) flags.push(`--${opt}`, v);
  }

  log(
    ws,
    `task=${basename(ws)} N=${nRollouts} contract=${args.contract} skills=${skills.length} skills_mode=${args.skillsMode} ` +
      `timeouts(turn/nudge/task)=${args.turnTimeout}/${args.nudgeTimeout}/${args.taskTimeout}s`,
  );

  if (args.provider === CLAUDE_CODE_PROVIDER) {
    return runClaudeCode(ws, args, deps, charter, mission, skills);
  }

  const useJail = args.env !== "none";
  if (useJail) {
    const why = jailUnavailable();
    if (why) {
      process.stderr.write(
        `error: the jail cannot run here (${why}); pass --env none to run without isolation ` +
          `(the data root's archived scores are then reachable from a session)\n`,
      );
      return 2;
    }
  } else {
    log(ws, "no isolation (--env none): sessions run directly on the host");
  }

  const pi = new Pi(
    ws,
    deps.piCommand ?? piCommandFor(args.piBin),
    flags,
    useJail,
    Date.now() / 1000 + args.taskTimeout,
    null,
    localPiHome,
    deps.backoff ?? RETRY_BACKOFF,
  );

  const nativeImage =
    args.env === "native" || args.env === "native-full" ? imageFor(ws) : null;
  if ((args.env === "native" || args.env === "native-full") && !nativeImage) {
    log(ws, "no usable native image for this task (docker or image missing); every turn stays in the jail");
  }

  let investigator = pi;
  if (nativeImage && args.env === "native-full") {
    investigator = pi.inNative(new Native(ws, nativeImage));
    log(ws, `native environment for the investigations: ${nativeImage}`);
  }

  return runPhases(
    investigator,
    () => {
      if (!nativeImage) return pi;
      log(ws, `native environment for adjudication and delivery: ${nativeImage}`);
      return pi.inNative(new Native(ws, nativeImage));
    },
    args,
    mission,
    skills,
  );
}

if (isMain(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
