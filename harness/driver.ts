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
  assertNoLinkBelow,
  copyFile,
  ensureDir,
  fileSize,
  isDir,
  isFile,
  posixRel,
  readJson as readJsonFs,
  SymlinkError,
  walkFiles,
  writeJson as writeJsonFs,
} from "./fsutil.js";
import {
  CLAUDE_CODE_PROVIDER,
  ClaudeRuntime,
  type UsageLimitState,
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
import type { ContextSize } from "./model/config.js";
import type { FetchLike } from "./model/http.js";
import { ROLES, describeRoles, parseRoleOptions, resolveRoles, roleKey, sharedServerWarnings, type Role, type RoleModel } from "./roles.js";
import { isBun, isMain, progressIntervalMs, runWithBudget } from "./runtime.js";
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
/** Before a nudge that follows a message that was cut or held only thinking: more thinking would end the same way. */
const NUDGE_CUT_PREFIX =
  "Your last message was cut off or held only thinking, so no file was written. Do not think further: ";
/** The nudge for `agent`: the same text, with the warning against thinking when its last message was cut. */
export function nudgeFor(agent: Agent, nudge: string): string {
  return agent.endedCut() ? NUDGE_CUT_PREFIX + nudge.charAt(0).toLowerCase() + nudge.slice(1) : nudge;
}
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
  /**
   * The text of the record file this session wrote itself (not a file another session left), or null.
   * When the session built the file with a shell, it is read back from `record` or from one of `alsoAt`.
   */
  ownRecord(record: string, alsoAt?: readonly string[]): string | null;
  /** True when the last message of the session was cut at the output limit or held only thinking. */
  endedCut(): boolean;
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
    await agent.turn(nudgeFor(agent, nudge), timeouts[1], true, tag);
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

  ownRecord(record: string, alsoAt: readonly string[] = []): string | null {
    return ownRecord(this.sessionDir, record, alsoAt);
  }

  endedCut(): boolean {
    return lastTurnCut(this.sessionDir);
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
        heartbeatMs: progressIntervalMs(),
        onHeartbeat: (ms) =>
          log(this.ws, `${tag}pi turn running ${Math.round(ms / 1000)}s of ${Math.floor(budget)}s; ${sessionProgress(this.sessionDir)}`),
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
        // A model that spends its whole output on thought ends at the limit with no answer. Say so, or
        // the missing record looks like a model that did not try.
        if (lastStopReason(this.sessionDir) === "length") {
          log(this.ws, `${tag}the last message ended at the output limit (stopReason length): it is cut, not an answer; raise --max-tokens`);
        }
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

/**
 * Why the driver must not touch `out/deliverables`: a symlink on the way to it or under it, or a
 * check that failed. Null when there is neither.
 *
 * The verifier can write `out/` inside the jail, and the driver reads and writes the bundle on the
 * host after the turn. Through a link, the view cleanup, the restore and the file listings would
 * be a delete, a write and a listing of a host directory. The verifier can also make a directory
 * there that the host cannot list; that check error is a refusal too, so it cannot stop the task.
 */
function outRefusal(ws: string): string | null {
  try {
    assertNoLinkBelow(ws, "out/deliverables");
    return null;
  } catch (e) {
    if (e instanceof SymlinkError) return `a symlink in the delivery path: ${e.path}`;
    return `the delivery path cannot be checked: ${(e as Error).message}`;
  }
}

/** Extensions that name a text format: the file must decode as UTF-8, with no replacement of a bad byte. */
const TEXT_EXTENSIONS = new Set([".json", ".md", ".txt", ".csv", ".tsv", ".yaml", ".yml", ".xml", ".html", ".htm"]);

/**
 * The first deliverable whose content is not the format its name declares, or null. A lenient decoder
 * turns a bad byte into U+FFFD and the file still parses, so the check decodes strictly: a consumer
 * that does the same would fail on a file the harness had called valid.
 */
function formatProblem(out: string, names: Iterable<string>): string | null {
  const strict = new TextDecoder("utf-8", { fatal: true });
  for (const name of [...names].sort()) {
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) continue;
    let text: string;
    try {
      text = strict.decode(readFileSync(join(out, name)));
    } catch {
      return `${name} is not valid UTF-8`;
    }
    if (ext === ".json" && text.trim() !== "") {
      try {
        JSON.parse(text);
      } catch (e) {
        return `${name} is not valid JSON: ${(e as Error).message}`;
      }
    }
  }
  return null;
}

/** Check `out/deliverables` against the chosen base; the result says whether the bundle is valid and why not. */
export function validateDelivery(ws: string, base: string): Record<string, unknown> {
  const refusal = outRefusal(ws);
  if (refusal) {
    return { valid: false, reason: refusal };
  }
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
    const bad = formatProblem(out, nonempty);
    if (bad) return { valid: false, reason: bad, n_base: 0, n_out: nonempty.length };
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
  const bad = formatProblem(out, [...have].filter((f) => fileSize(join(out, f)) > 0));
  if (bad) return { valid: false, reason: bad, n_base: need.size, n_out: have.size };
  return {
    valid: true,
    n_base: need.size,
    n_out: have.size,
    added: [...have].filter((f) => !need.has(f)).sort().slice(0, 20),
  };
}

/** Remove the harness views from `out/deliverables`, then restore the base files that are missing or empty there; returns the restored paths. */
export function completeBundle(ws: string, base: string): string[] {
  if (outRefusal(ws)) return [];
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
  if (outRefusal(ws)) return [];
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
  /** A size, or `auto` for the server's window. Unset falls back to VERIHARNESS_CONTEXT_SIZE. */
  contextSize?: ContextSize;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  /** HTTP timeout for local-model preflight, in seconds. */
  requestTimeout?: number;
  /** The roles that `--role` gave their own model; the others use `provider` and `model`. */
  roles: Partial<Record<Role, RoleModel>>;
}

/** The runtime a role runs on, as `renderSkills` names it. */
type RuntimeKind = "pi" | "claude-code";

function kindOf(m: RoleModel): RuntimeKind {
  return m.provider === CLAUDE_CODE_PROVIDER ? "claude-code" : "pi";
}

/** The model the roles fall back to: the driver's own `--provider`, `--model`, `--base-url` and `--context-size`. */
function mainModel(args: DriverArgs): RoleModel {
  return { provider: args.provider, model: args.model, baseUrl: args.baseUrl, contextSize: args.contextSize };
}

async function investigate(
  agent: Agent,
  args: DriverArgs,
  mission: string,
  skills: string[],
  spec: [string, string, string, string],
  kind: RuntimeKind,
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
    renderSkills(skills, ws, name, args.skillsMode, kind);
  const tag = `[${name}] `;
  log(ws, `${tag}investigation: ${playbook}`);
  // driver.log changes between turns, not inside one; the session stream is what moves while a model works.
  log(ws, `${tag}live stream: session/${name}/ (driver.log is silent until this turn ends)`);
  const session = agent.withSession(name);
  await session.turn(message, args.turnTimeout, false, tag);
  // The format file the model follows lives in `<name>/`, and the driver keeps its own copy there, so a
  // record built with a shell may stand in either place.
  const places = [join(ws, name, record)];
  if (session.ownRecord(join(ws, record), places) === null) {
    await session.turn(nudgeFor(session, NUDGE_LEDGER.replace("{record}", record)), args.nudgeTimeout, true, tag);
  }
  const own = session.ownRecord(join(ws, record), places);
  let ledger: Record<string, unknown> | null = null;
  if (own !== null) {
    try {
      ledger = JSON.parse(own) as Record<string, unknown>;
    } catch {
      ledger = null;
    }
  }
  if (ledger === null) {
    // What the session did tells a model that never started from one that wrote the wrong thing.
    const seen = kind === "pi" ? ` (${sessionProgress(join(ws, "session", name))})` : "";
    log(ws, `${tag}no ${record} of its own after nudge${seen}`);
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

/**
 * What the newest session file says about a running turn: assistant messages, tool calls, the last tool
 * and the size. It is the only thing that moves during a turn, so the driver logs it as a heartbeat.
 */
export function sessionProgress(sessionDir: string): string {
  if (!isDir(sessionDir)) return "no session file yet";
  const newest = readdirSync(sessionDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .at(-1);
  if (newest === undefined) return "no session file yet";
  const text = readFileSync(join(sessionDir, newest), "utf8");
  let messages = 0;
  let calls = 0;
  let last = "";
  for (const line of text.split("\n")) {
    if (!line.includes('"assistant"')) continue;
    try {
      const m = (JSON.parse(line) as { message?: { role?: unknown; content?: unknown } }).message;
      if (m?.role !== "assistant") continue;
      messages++;
      for (const part of Array.isArray(m.content) ? (m.content as { type?: string; name?: string }[]) : []) {
        if (part.type === "toolCall") {
          calls++;
          last = String(part.name ?? "");
        }
      }
    } catch {
      // A line cut by a read in the middle of a write is not a message yet.
    }
  }
  return `${messages} assistant messages, ${calls} tool calls${last ? ` (last: ${last})` : ""}, session ${Math.round(text.length / 1024)} KB`;
}

/**
 * True when the last assistant message of the newest session file was cut at the output limit, or
 * held thinking and no text. Such a message wrote no record, and a nudge must say not to think more.
 */
export function lastTurnCut(sessionDir: string): boolean {
  if (lastStopReason(sessionDir) === "length") return true;
  if (!isDir(sessionDir)) return false;
  const newest = readdirSync(sessionDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .at(-1);
  if (newest === undefined) return false;
  let thoughtOnly = false;
  for (const line of readFileSync(join(sessionDir, newest), "utf8").split("\n")) {
    if (!line.includes('"assistant"')) continue;
    try {
      const m = (JSON.parse(line) as { message?: { role?: unknown; content?: unknown } }).message;
      if (m?.role !== "assistant") continue;
      const parts = Array.isArray(m.content) ? (m.content as { type?: string; text?: string }[]) : [];
      const hasText = parts.some((p) => p.type === "text" && String(p.text ?? "").trim() !== "");
      const hasCall = parts.some((p) => p.type === "toolCall");
      thoughtOnly = !hasText && !hasCall && parts.some((p) => p.type === "thinking");
    } catch {
      // A line cut by a read in the middle of a write is not a message yet.
    }
  }
  return thoughtOnly;
}

/**
 * Why the last assistant message of the newest session file ended (`stop`, `toolUse`, `length`...).
 * Empty when there is no session file or no assistant message.
 */
export function lastStopReason(sessionDir: string): string {
  if (!isDir(sessionDir)) return "";
  const files = readdirSync(sessionDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  const newest = files.at(-1);
  if (newest === undefined) return "";
  let reason = "";
  for (const text of readFileSync(join(sessionDir, newest), "utf8").split("\n")) {
    if (!text.includes('"assistant"')) continue;
    try {
      const m = (JSON.parse(text) as { message?: { role?: unknown; stopReason?: unknown } }).message;
      if (m?.role === "assistant") reason = typeof m.stopReason === "string" ? m.stopReason : "";
    } catch {
      // A line that is not JSON is not a message.
    }
  }
  return reason;
}

function ownRecord(sessionDir: string, record: string, alsoAt: readonly string[] = []): string | null {
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
  for (const path of [record, ...alsoAt]) {
    if (isFile(path) && readJsonFs(path) !== null) return readFileSync(path, "utf8");
  }
  return null;
}

/** What an investigation may not touch: the evidence it reads, the deliverable and the adjudication files. */
const SCOPE_DIRS = ["rollouts", "out"];
const SCOPE_FILES = ["finish.json", "repair.json"];

/**
 * The contents of every file an investigation must leave alone. The investigation sessions run in the
 * task root with a shell, and without a jail nothing but their prompt stops a write outside their own
 * files, so the harness checks the result instead of trusting the model.
 */
export function snapshotScope(ws: string): Map<string, Buffer> {
  const snap = new Map<string, Buffer>();
  const add = (p: string) => snap.set(posixRel(ws, p), readFileSync(p));
  for (const dir of SCOPE_DIRS) {
    if (isDir(join(ws, dir))) walkFiles(join(ws, dir)).forEach(add);
  }
  for (const file of SCOPE_FILES) {
    if (isFile(join(ws, file))) add(join(ws, file));
  }
  return snap;
}

/**
 * Undoes what an investigation did outside its own files and returns one line for each change: a file
 * it changed or deleted comes back as it was, and a file it added is moved to `foreign/` where the
 * reviewer can still read it. A file that is only set aside cannot pose as a deliverable.
 */
export function settleScope(ws: string, snap: Map<string, Buffer>): string[] {
  const found: string[] = [];
  for (const [rel, bytes] of snap) {
    const p = join(ws, rel);
    if (!isFile(p)) {
      ensureDir(dirname(p));
      writeFileSync(p, bytes);
      found.push(`${rel} (deleted; restored)`);
    } else if (!readFileSync(p).equals(bytes)) {
      writeFileSync(p, bytes);
      found.push(`${rel} (changed; restored)`);
    }
  }
  const now: string[] = [];
  for (const dir of SCOPE_DIRS) {
    if (isDir(join(ws, dir))) walkFiles(join(ws, dir)).forEach((p) => now.push(posixRel(ws, p)));
  }
  for (const rel of now) {
    if (snap.has(rel)) continue;
    const to = join(ws, "foreign", rel);
    ensureDir(dirname(to));
    renameSync(join(ws, rel), to);
    found.push(`${rel} (added; set aside)`);
  }
  return found;
}

/**
 * Files an earlier run of this task left: each investigation's record (in the task root and in its
 * own folder), finish.json and repair.json. They would pass for this run's, because a record is read
 * back from disk when a session built it with a shell and finish.json is read from disk after its
 * turn. They are moved to `previous/`, never deleted.
 */
function setAsideEarlierRun(ws: string): void {
  const stale = [...INVESTIGATIONS.flatMap(([name, , , record]) => [record, `${name}/${record}`]), ...SCOPE_FILES];
  for (const rel of stale) {
    const from = join(ws, rel);
    if (!isFile(from)) continue;
    const to = join(ws, "previous", rel);
    ensureDir(dirname(to));
    renameSync(from, to);
    log(ws, `an earlier run left ${rel}; set aside as previous/${rel}`);
  }
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

async function adjudicate(
  agent: Agent,
  args: DriverArgs,
  skills: string[],
  kind: RuntimeKind,
): Promise<Record<string, unknown> | null> {
  log(agent.ws, "adjudication: ADJUDICATE.md (fresh session)");
  const message =
    readFileSync(join(config.PROMPTS_DIR, "ADJUDICATE.md"), "utf8") +
    renderSkills(skills, agent.ws, "adjudicate", args.skillsMode, kind);
  return turnUntil(
    agent,
    message,
    NUDGE_FINISH,
    join(agent.ws, "finish.json"),
    [args.turnTimeout, args.nudgeTimeout],
    false,
  );
}

/**
 * Complete the bundle after the repair turn, then check it: the delivery verdict, the restored base
 * files and the changed files.
 *
 * The verifier controls what is under out/. A link there, or a file system error (a file where the
 * bundle directory goes, a directory where a base file goes, a file that cannot be read), makes the
 * delivery invalid with a reason, instead of stopping the task before the repair block is in
 * finish.json. The result then has no `restored` or `changed`: they are not known, and score reads
 * an empty `changed` as an unchanged bundle. An error with no errno code is a harness bug and is
 * thrown.
 */
function settleBundle(ws: string, base: string): Record<string, unknown> {
  const refusal = outRefusal(ws);
  if (refusal) return { valid: false, reason: refusal };
  try {
    const restored = completeBundle(ws, base);
    return {
      ...validateDelivery(ws, base),
      restored: restored.slice(0, 20),
      changed: changedFiles(ws, base).slice(0, 50),
    };
  } catch (e) {
    if (typeof (e as NodeJS.ErrnoException).code !== "string") throw e;
    return { valid: false, reason: `the bundle cannot be completed: ${(e as Error).message}` };
  }
}

/** What a fixer in a fresh session is told first: the adjudication it did not see. */
const FRESH_FIXER_BRIEF =
  "The adjudication ran in another session, on another model or server. You did not see it. `finish.json` is its " +
  "result. Before you start, read `finish.json`, the two investigation records (`ledger_elim.json` and " +
  "`ledger_fals.json`), `MISSION.md` and the rollouts that `finish.json` names.\n\n";

async function deliver(
  agent: Agent,
  args: DriverArgs,
  finish: Record<string, unknown>,
  skills: string[],
  kind: RuntimeKind,
  fresh: boolean,
): Promise<void> {
  const ws = agent.ws;
  const base = baseOf(finish);
  const baseLine =
    base !== "none"
      ? `\n\nThe adjudication named \`${base}\` as the base.\n`
      : "\n\nThe adjudication found no candidate worth starting from (base none): " +
        "build the deliverable from the inputs.\n";
  const message =
    (fresh ? FRESH_FIXER_BRIEF : "") +
    readFileSync(join(config.PROMPTS_DIR, "REPAIR.md"), "utf8") +
    baseLine +
    renderSkills(skills, ws, "repair", args.skillsMode, kind);
  // The earlier turns can plant a link under out/, and ensureDir would follow it and create the
  // bundle directory on the host. They can also leave a file at out/deliverables, and ensureDir
  // then throws. The checks after the repair refuse such a bundle, so the repair runs either way.
  if (!outRefusal(ws)) {
    try {
      ensureDir(join(ws, "out", "deliverables"));
    } catch (e) {
      log(ws, `delivery: out/deliverables not created: ${(e as Error).message}`);
    }
  }
  log(
    ws,
    fresh
      ? "delivery: REPAIR.md (fresh session: the fixer's model is not the reviewer's)"
      : "delivery: REPAIR.md (continuing adjudication session)",
  );
  const repair = await turnUntil(
    agent,
    message,
    NUDGE_REPAIR,
    join(ws, "repair.json"),
    [args.turnTimeout, args.nudgeTimeout],
    !fresh,
  );
  const repairBlock = {
    written: repair !== null,
    ...settleBundle(ws, base),
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
        role: { type: "string", multiple: true },
        "role-base-url": { type: "string", multiple: true },
        "role-context-size": { type: "string", multiple: true },
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
    // `auto` is the server's own window. It is kept, so it also beats VERIHARNESS_CONTEXT_SIZE.
    const rawContext = values["context-size"] as string | undefined;
    const contextSize = rawContext?.trim().toLowerCase() === "auto" ? "auto" : optionalNumber("context-size", rawContext);
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
    const roleSet = parseRoleOptions(
      (values.role as string[] | undefined) ?? [],
      (values["role-base-url"] as string[] | undefined) ?? [],
      (values["role-context-size"] as string[] | undefined) ?? [],
    );
    if ("error" in roleSet) return roleSet;
    const roles = resolveRoles(
      {
        provider,
        model: values.model as string | undefined,
        baseUrl: values["base-url"] as string | undefined,
        contextSize: contextSize as ContextSize | undefined,
      },
      roleSet,
    );
    // The pi tuning options apply to the roles that run pi; with none, they are refused as before.
    // --base-url and --context-size describe the main model, so a Claude Code main model refuses them.
    const anyPi = ROLES.some((role) => roles[role].provider !== CLAUDE_CODE_PROVIDER);
    const given = values as Record<string, unknown>;
    const mainOnly = provider === CLAUDE_CODE_PROVIDER ? { "base-url": given["base-url"], "context-size": given["context-size"] } : {};
    for (const role of ROLES) {
      if (roles[role].provider !== CLAUDE_CODE_PROVIDER) continue;
      const own = roleSet[role] !== undefined;
      const refusal = claudeCodeRefusal(env, roles[role].model, anyPi ? mainOnly : given);
      if (refusal !== null) return { error: own ? `--role ${role}: ${refusal}` : refusal };
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
        contextSize: contextSize as ContextSize | undefined,
        temperature: temperature as number | undefined,
        maxTokens: maxTokens as number | undefined,
        topP: topP as number | undefined,
        requestTimeout: requestTimeout as number | undefined,
        roles: roleSet,
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
  /** The fetch the local-model preflight uses (default: the global fetch). */
  fetch?: FetchLike;
}

/** The agent of each role in one task. */
interface Cast {
  checker: Agent;
  challenger: Agent;
  /** Called once the investigations have left their records, so a runtime can change where it runs. */
  reviewer: () => Agent;
  /** A fresh session for a fixer on another model than the reviewer's; null continues the reviewer's session. */
  fixer: (() => Agent) | null;
  kinds: Record<Role, RuntimeKind>;
}

/**
 * The phases every runtime shares: the two investigations in parallel, the adjudication, then, on the
 * artifact contract, the repair. Resolves to the exit code.
 */
async function runPhases(cast: Cast, args: DriverArgs, mission: string, skills: string[]): Promise<number> {
  const ws = cast.checker.ws;
  const [elim, fals] = INVESTIGATIONS as [[string, string, string, string], [string, string, string, string]];
  // A result.json of an earlier run would describe a run that did not happen.
  if (isFile(join(ws, "result.json"))) unlinkSync(join(ws, "result.json"));
  setAsideEarlierRun(ws);
  const scope = snapshotScope(ws);
  const ok = await Promise.all([
    investigate(cast.checker, args, mission, skills, elim, cast.kinds.checker),
    investigate(cast.challenger, args, mission, skills, fals, cast.kinds.challenger),
  ]);
  const scopeFound = settleScope(ws, scope);
  for (const line of scopeFound) {
    log(ws, `scope: an investigation wrote outside its own files: ${line}`);
  }
  restoreRecords(ws);
  // The exit code says only that the run ended. result.json says what it did, so an exit 0 with an
  // investigation missing, or with no usable rollout as the base, cannot pass for a verified run.
  const result: Record<string, unknown> = {
    investigations: Object.fromEntries(INVESTIGATIONS.map(([name], i) => [name, Boolean(ok[i])])),
    scope: scopeFound,
  };
  const done = (code: number, more: Record<string, unknown> = {}): number => {
    writeJsonFs(join(ws, "result.json"), { exit: code, ...result, ...more });
    return code;
  };
  if (!ok.some(Boolean)) {
    log(ws, "no investigation left a record; recording no-output");
    return done(1);
  }
  // One investigation without a record leaves the other, and the rollouts, to adjudicate from. The
  // reviewer reads both record files, so the missing one is written as a stub that says it is missing.
  INVESTIGATIONS.forEach(([name, , , record], i) => {
    if (ok[i]) return;
    writeJsonFs(join(ws, record), {
      missing: true,
      reason: `the ${name} investigation ended with no record of its own: adjudicate from the other record and the rollouts alone`,
    });
    log(ws, `${name}: no record of its own; the adjudication runs on the other record`);
  });

  const reviewer = cast.reviewer();
  const finish = await adjudicate(reviewer, args, skills, cast.kinds.reviewer);
  if (finish === null) {
    log(ws, "no finish.json after nudge; recording no-output");
    return done(1);
  }
  log(
    ws,
    `finish: base=${baseOf(finish)} work=${(finish.work as unknown[] | undefined)?.length ?? 0} ` +
      `open=${(finish.open as unknown[] | undefined)?.length ?? 0}`,
  );

  if (args.contract === "artifact") {
    const fixer = cast.fixer === null ? reviewer : cast.fixer();
    await deliver(fixer, args, finish, skills, cast.kinds.fixer, cast.fixer !== null);
  }
  return done(0, {
    base: baseOf(finish),
    work: (finish.work as unknown[] | undefined)?.length ?? 0,
    open: (finish.open as unknown[] | undefined)?.length ?? 0,
    ...(finish.repair ? { delivery: finish.repair } : {}),
  });
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

type ClaudeBase = Omit<ConstructorParameters<typeof ClaudeRuntime>[0], "model" | "limit">;

/** The Claude Code runtime of each model a task uses. All of them share one usage-limit state. */
class ClaudeFleet {
  readonly limit: UsageLimitState = { message: null };
  private readonly runtimes = new Map<string, ClaudeRuntime>();

  constructor(private readonly base: ClaudeBase) {}

  runtime(model: string): ClaudeRuntime {
    let r = this.runtimes.get(model);
    if (!r) {
      r = new ClaudeRuntime({ ...this.base, model, limit: this.limit });
      this.runtimes.set(model, r);
    }
    return r;
  }

  /** Give back the saved copies of every session. Idempotent. */
  finish(): void {
    for (const r of this.runtimes.values()) r.finish();
  }
}

/** Start the Claude Code side of a task: the command check, the warnings and the charter file. Null on failure. */
function startClaudeFleet(
  ws: string,
  args: DriverArgs,
  deps: DriverDeps,
  charter: string,
  skills: string[],
): ClaudeFleet | null {
  // A verifier started from inside a Claude Code session must not inherit that session's identity.
  const env = claudeSessionEnv(agentEnv(process.env));
  const command = deps.claudeCommand ?? claudeCommand(args.claudeBin, process.env);
  const started = startCheck(command, env);
  if (!started.ok) {
    process.stderr.write(`error: ${started.error}\n`);
    return null;
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

  return new ClaudeFleet({
    ws,
    command,
    tools: claudeTools(TOOLS[args.contract]!),
    charterFile,
    addDirs: skillRoots(skills),
    env,
    deadline: Date.now() / 1000 + args.taskTimeout,
    backoff: deps.backoff ?? RETRY_BACKOFF,
    log: (message) => log(ws, message),
    sleep: deps.sleep,
  });
}

/** A pi role, once its local server (if any) is ready: the provider and the model pi gets, and its pi home. */
interface PiRole {
  provider: string | undefined;
  model: string | undefined;
  piHome: string | null;
  /** The window the role runs with and where it came from; absent for a pi provider that is not local. */
  context?: { window: number; source: string; serverWindow: number; serverSource: string };
}

/** Probe the local server of a local role and write the pi home that names its model. */
async function prepareLocalRole(ws: string, args: DriverArgs, m: RoleModel, home: string, fetch?: FetchLike): Promise<PiRole> {
  const prepared = await prepareLocalProvider(
    resolveLocalConfig({
      provider: m.provider,
      model: m.model,
      baseUrl: m.baseUrl,
      temperature: args.temperature,
      topP: args.topP,
      maxTokens: args.maxTokens,
      contextSize: m.contextSize,
      timeoutMs: args.requestTimeout === undefined ? undefined : secondsToMs(args.requestTimeout, "request timeout"),
    }),
    { fetch },
  );
  materializePiHome(home, prepared.piProvider);
  for (const warning of prepared.warnings) log(ws, `local model: ${warning}`);
  log(
    ws,
    `local model ${prepared.config.provider} ${prepared.model} at ${prepared.config.baseUrl} ` +
      `tools=${String(prepared.probe.capabilities.tools)}`,
  );
  // prepareLocalProvider has checked the window, so the probe reports one and an explicit size fits it.
  const caps = prepared.probe.capabilities;
  const serverWindow = caps.contextSize!;
  const serverSource = caps.contextSource ?? "unknown";
  const explicit = prepared.config.contextSize;
  const context =
    explicit === undefined
      ? { window: serverWindow, source: serverSource, serverWindow, serverSource }
      : { window: explicit, source: "explicit", serverWindow, serverSource };
  return { provider: prepared.config.provider, model: prepared.model, piHome: home, context };
}

/**
 * One `context:` line per role: the window it runs with and where that number came from. A role that
 * asks for a size other than the loaded model's gets a warning: the harness sends no num_ctx, but
 * another client of the same server can, and Ollama then reloads the model at that client's size.
 */
function logContext(ws: string, roles: Record<Role, RoleModel>, kinds: Record<Role, RuntimeKind>, piRoles: Map<string, PiRole>): void {
  for (const role of ROLES) {
    const m = roles[role];
    const pi = kinds[role] === "pi" ? piRoles.get(roleKey(m)) : undefined;
    const model = pi?.model ?? m.model;
    const label = `${role}=${m.provider ?? "default"}:${model ?? "default"}`;
    if (pi?.context) {
      const c = pi.context;
      log(ws, `context: ${label} window=${c.window} source=${c.source}`);
      if (c.source === "explicit" && c.serverSource === "loaded" && c.window !== c.serverWindow) {
        log(ws, `context: ${role} asks ${c.window}, the server runs ${model} at ${c.serverWindow}; a client that sends num_ctx may reload it`);
      }
      continue;
    }
    const table = kinds[role] === "claude-code" && model !== undefined ? config.claudeCodeWindow(model) : undefined;
    log(ws, table === undefined ? `context: ${label} window=unknown source=none` : `context: ${label} window=${table} source=table`);
  }
}

/** Run one task workspace; returns the exit code. */
export async function main(argv: string[] = process.argv.slice(2), deps: DriverDeps = {}): Promise<number> {
  const parsed = parseDriverArgv(argv);
  if ("error" in parsed) {
    if (parsed.error === "HELP") {
      process.stdout.write(
        "usage: veriharness driver <ws> [--contract artifact|pick-only] [--provider P] [--model M] " +
          "[--thinking T] [--base-url URL] [--context-size N|auto] [--temperature N] [--max-tokens N] [--top-p N] " +
          "[--request-timeout S] [--skill NAME]... [--no-skills] [--skills-mode mounted|auto] " +
          "[--env jail|none|native|native-full] [--turn-timeout S] [--nudge-timeout S] [--task-timeout S] " +
          "[--pi-bin PATH] [--claude-bin PATH] [--role ROLE=PROVIDER:MODEL]... [--role-base-url ROLE=URL]... " +
          "[--role-context-size ROLE=N|auto]...\n" +
          "local providers: --provider ollama (default http://127.0.0.1:11434) or --provider llamacpp " +
          "(default http://127.0.0.1:8080). Both need --model. No API key.\n" +
          "Claude Code: --provider claude-code --model <full model id> --env none. Uses the login Claude Code " +
          "holds (or ANTHROPIC_API_KEY). See docs/claude-code.md.\n" +
          `roles: ${ROLES.join(", ")}. A role with no --role uses --provider and --model; a fixer with no ` +
          "--role uses the reviewer's model. See docs/roles.md.\n",
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

  const roles = resolveRoles(mainModel(args), args.roles);
  const kinds = Object.fromEntries(ROLES.map((role) => [role, kindOf(roles[role])])) as Record<Role, RuntimeKind>;

  log(
    ws,
    `task=${basename(ws)} N=${nRollouts} contract=${args.contract} skills=${skills.length} skills_mode=${args.skillsMode} ` +
      `timeouts(turn/nudge/task)=${args.turnTimeout}/${args.nudgeTimeout}/${args.taskTimeout}s`,
  );
  log(ws, `roles: ${describeRoles(roles)}`);
  for (const warning of sharedServerWarnings(roles)) log(ws, `WARNING: ${warning}`);

  // The pi side: one prepared provider per distinct pi role, so each local server is probed once.
  // Each distinct local role gets its own pi home: `.pi` for the first, then `.pi-2`, `.pi-3`.
  const piRoles = new Map<string, PiRole>();
  let homes = 0;
  for (const role of ROLES) {
    const m = roles[role];
    const key = roleKey(m);
    if (kinds[role] !== "pi" || piRoles.has(key)) continue;
    if (!canonicalLocalProvider(m.provider)) {
      piRoles.set(key, { provider: m.provider, model: m.model, piHome: null });
      continue;
    }
    homes++;
    try {
      piRoles.set(key, await prepareLocalRole(ws, args, m, join(ws, homes === 1 ? ".pi" : `.pi-${homes}`), deps.fetch));
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }

  logContext(ws, roles, kinds, piRoles);

  const usesPi = piRoles.size > 0;
  const useJail = usesPi && args.env !== "none";
  if (useJail) {
    const why = jailUnavailable();
    if (why) {
      process.stderr.write(
        `error: the jail cannot run here (${why}); pass --env none to run without isolation ` +
          `(the data root's archived scores are then reachable from a session)\n`,
      );
      return 2;
    }
  } else if (usesPi) {
    log(ws, "no isolation (--env none): sessions run directly on the host");
  }

  const wantsNative = usesPi && (args.env === "native" || args.env === "native-full");
  const nativeImage = wantsNative ? imageFor(ws) : null;
  if (wantsNative && !nativeImage) {
    log(ws, "no usable native image for this task (docker or image missing); every turn stays in the jail");
  }

  const baseFlags = [
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
    baseFlags.push("--skill", skill);
  }
  const deadline = Date.now() / 1000 + args.taskTimeout;
  const pis = new Map<string, Pi>();
  const piFor = (m: RoleModel): Pi => {
    const key = roleKey(m);
    let pi = pis.get(key);
    if (!pi) {
      const p = piRoles.get(key)!;
      const flags = [...baseFlags];
      for (const [opt, v] of [["provider", p.provider], ["model", p.model], ["thinking", args.thinking]] as const) {
        if (v) flags.push(`--${opt}`, v);
      }
      pi = new Pi(
        ws,
        deps.piCommand ?? piCommandFor(args.piBin),
        flags,
        useJail,
        deadline,
        null,
        p.piHome,
        deps.backoff ?? RETRY_BACKOFF,
      );
      pis.set(key, pi);
    }
    return pi;
  };

  // The Claude Code side: one runtime per model, one shared usage limit.
  const fleet = ROLES.some((role) => kinds[role] === "claude-code")
    ? startClaudeFleet(ws, args, deps, charter, skills)
    : undefined;
  if (fleet === null) return 2;

  /** The agent of an investigation: in the native image only with native-full. */
  const early = (m: RoleModel): Agent => {
    if (kindOf(m) === "claude-code") return fleet!.runtime(m.model!).session("");
    const pi = piFor(m);
    return nativeImage && args.env === "native-full" ? pi.inNative(new Native(ws, nativeImage)) : pi;
  };
  if (nativeImage && args.env === "native-full" && (kinds.checker === "pi" || kinds.challenger === "pi")) {
    log(ws, `native environment for the investigations: ${nativeImage}`);
  }
  let nativeLogged = false;
  /** The agent of a role that runs after the investigations: in the native image when there is one. */
  const late = (m: RoleModel, claudeSession: string): Agent => {
    if (kindOf(m) === "claude-code") return fleet!.runtime(m.model!).session(claudeSession);
    const pi = piFor(m);
    if (!nativeImage) return pi;
    if (!nativeLogged) log(ws, `native environment for adjudication and delivery: ${nativeImage}`);
    nativeLogged = true;
    return pi.inNative(new Native(ws, nativeImage));
  };

  const cast: Cast = {
    checker: early(roles.checker),
    challenger: early(roles.challenger),
    reviewer: () => late(roles.reviewer, "adjudicate"),
    // A pi fixer takes its own session directory; a Claude Code fixer has one from its session name.
    fixer:
      roleKey(roles.fixer) === roleKey(roles.reviewer)
        ? null
        : () => {
            const agent = late(roles.fixer, "repair");
            return kinds.fixer === "pi" ? agent.withSession("repair") : agent;
          },
    kinds,
  };

  if (!fleet) return runPhases(cast, args, mission, skills);

  // A driver that is killed still gives the saved copies back.
  const onExit = (): void => fleet.finish();
  process.once("exit", onExit);
  try {
    let code = await runPhases(cast, args, mission, skills);
    if (fleet.limit.message !== null) {
      // The limit is the account's, not the task's: say so in the record, and let the runner stop the lane.
      const finish = readJsonFs<Record<string, unknown>>(join(ws, "finish.json"));
      if (finish !== null) {
        finish.repair = { ...(finish.repair as object | undefined), error: "usage-limit" };
        writeJsonFs(join(ws, "finish.json"), finish);
      }
      log(ws, `usage-limit: ${fleet.limit.message}`);
      code = USAGE_LIMIT_EXIT;
    }
    return code;
  } finally {
    fleet.finish();
    process.removeListener("exit", onExit);
  }
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
