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

/** VeriHarness driver: run one verification task through the pi agent runtime. */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
import { Native, imageFor } from "./env/index.js";
import { canonicalLocalProvider, materializePiHome, prepareLocalProvider, resolveLocalConfig } from "./model/index.js";
import { isMain } from "./runtime.js";
import { isView } from "./views.js";

export { readJsonFs as readJson, writeJsonFs as writeJson };

const JAIL = join(config.SCRIPTS_DIR, "jail_run.sh");

export function jailUnavailable(): string {
  if (!isFile(JAIL)) {
    return `${JAIL} missing`;
  }
  try {
    const p = spawnSync("unshare", ["-r", "-m", "-p", "-f", "--mount-proc", "true"], {
      encoding: "utf8",
      timeout: 20_000,
    });
    if (p.error) {
      return `unshare: ${p.error.name}`;
    }
    return p.status === 0 ? "" : `unshare -r -m -p failed: ${(p.stderr || "").trim().slice(0, 120)}`;
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

let logLock = false;

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

export function baseOf(finish: Record<string, unknown>): string {
  const raw = finish.base ?? finish.pick ?? "";
  const name = String(raw || "")
    .trim()
    .replace(/\/$/, "")
    .split("/")
    .pop()!;
  return name.toLowerCase() === "" || ["none", "null"].includes(name.toLowerCase()) ? "none" : name;
}

class Pi {
  ws: string;
  piBin: string;
  flags: string[];
  useJail: boolean;
  deadline: number;
  native: Native | null;
  piHome: string | null;

  constructor(
    ws: string,
    piBin: string,
    flags: string[],
    useJail: boolean,
    deadline: number,
    native: Native | null = null,
    piHome: string | null = null,
  ) {
    this.ws = ws;
    this.piBin = piBin;
    this.flags = flags;
    this.useJail = useJail;
    this.deadline = deadline;
    this.native = native;
    this.piHome = piHome;
  }

  withSession(name: string): Pi {
    const sessionDir = join(this.ws, "session", name);
    ensureDir(sessionDir);
    const flags = [...this.flags];
    const idx = flags.indexOf("--session-dir");
    flags[idx + 1] = sessionDir;
    return new Pi(this.ws, this.piBin, flags, this.useJail, this.deadline, this.native, this.piHome);
  }

  get sessionDir(): string {
    const idx = this.flags.indexOf("--session-dir");
    return this.flags[idx + 1]!;
  }

  inNative(native: Native): Pi {
    return new Pi(this.ws, this.piBin, this.flags, this.useJail, this.deadline, native, this.piHome);
  }

  _cmd(message: string, continueSession: boolean, env: NodeJS.ProcessEnv): [string[], string | null] {
    const cmd = [this.piBin, "-p", ...this.flags];
    if (continueSession) cmd.push("-c");
    cmd.push("--", message);
    if (this.native !== null) {
      const [wrapped, name] = this.native.wrap(cmd, env as Record<string, string>);
      return [wrapped, name];
    }
    return [this.useJail ? [JAIL, this.ws, ...cmd] : cmd, null];
  }

  async turn(message: string, timeout: number, continueSession: boolean, tag = ""): Promise<boolean> {
    const env = { ...process.env };
    if (this.piHome) env.PI_CODING_AGENT_DIR = this.piHome;
    else env.PI_CODING_AGENT_DIR ??= config.PI_HOME;
    env.GOOGLE_CLOUD_LOCATION ??= "global";
    env.PI_SKIP_VERSION_CHECK ??= "1";
    env.VERIHARNESS_DATA = config.DATA;

    for (let attempt = 0; attempt < RETRY_BACKOFF.length + 1; attempt++) {
      const budget = Math.min(timeout, this.deadline - Date.now() / 1000);
      if (budget <= 0) {
        log(this.ws, `${tag}task deadline reached before turn start; skipping turn`);
        return false;
      }
      log(
        this.ws,
        `${tag}pi turn (continue=${continueSession}, attempt=${attempt + 1}, budget=${Math.floor(budget)}s` +
          `${this.native ? ", native " + this.native.image : ""})`,
      );
      const [cmd, container] = this._cmd(message, continueSession, env);
      const proc = spawn(cmd[0]!, cmd.slice(1), {
        cwd: this.ws,
        env,
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      const finished = await new Promise<{ ok: boolean; timedOut: boolean }>((resolveP) => {
        const timer = setTimeout(() => {
          try {
            if (proc.pid) process.kill(-proc.pid, "SIGKILL");
          } catch {
            proc.kill("SIGKILL");
          }
          resolveP({ ok: false, timedOut: true });
        }, budget * 1000);
        proc.on("close", (code) => {
          clearTimeout(timer);
          resolveP({ ok: code === 0, timedOut: false });
        });
        proc.on("error", () => {
          clearTimeout(timer);
          resolveP({ ok: false, timedOut: false });
        });
      });

      if (finished.timedOut) {
        await new Promise<void>((r) => proc.on("close", () => r()));
        if (container && this.native) {
          this.native.kill(container);
        }
        log(this.ws, `${tag}pi turn timed out after ${Math.floor(budget)}s (process group killed)`);
        return false;
      }

      const rc = proc.exitCode ?? 1;
      log(this.ws, `${tag}pi exited rc=${rc}`);
      if (rc === 0) {
        return true;
      }
      log(this.ws, `${tag}pi stderr (tail): ${stderr.slice(-2000)}`);
      if (!TRANSIENT.some((sig) => stderr.includes(sig)) || attempt === RETRY_BACKOFF.length) {
        return false;
      }
      log(this.ws, `${tag}transient provider error; retrying in ${RETRY_BACKOFF[attempt]}s`);
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF[attempt]! * 1000));
      const sessionDir = this.sessionDir;
      continueSession = readdirSync(sessionDir, { withFileTypes: true }).some(
        (e) => e.isFile() && e.name.endsWith(".jsonl"),
      );
    }
    return false;
  }

  async turnUntil(
    message: string,
    nudge: string,
    output: string,
    timeouts: [number, number],
    continueSession: boolean,
    tag = "",
  ): Promise<Record<string, unknown> | null> {
    await this.turn(message, timeouts[0], continueSession, tag);
    let result = readJsonFs<Record<string, unknown>>(output);
    if (result === null) {
      await this.turn(nudge, timeouts[1], true, tag);
      result = readJsonFs<Record<string, unknown>>(output);
    }
    return result;
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

export function renderSkills(
  skillPaths: string[],
  ws: string,
  phase: string,
  mode: string = "mounted",
): string {
  const rolloutsDir = join(ws, "rollouts");
  const delivered = new Set<string>();
  if (isDir(rolloutsDir)) {
    for (const p of walkFiles(rolloutsDir)) {
      if (p.includes("/deliverables/")) {
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
      "read tool when you judge it useful for what this task delivered; skip the ones that are not. " +
      "Relative paths inside a skill resolve against its directory.\n\n" +
      parts.join("\n") +
      "\n"
    );
  }
  return (
    "\n\n# Evidence instruments\n\nThe skills listed in your system prompt, in full. Relative paths in them " +
    "resolve against the skill directory given for each.\n\n" +
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
  const baseDir = join(ws, "rollouts", base, "deliverables");
  if (!isDir(baseDir)) {
    return {
      valid: false,
      reason: `base rollout '${base}' has no deliverables dir (base must be a rollout name)`,
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

export function completeBundle(ws: string, base: string): string[] {
  const out = join(ws, "out", "deliverables");
  const baseDir = join(ws, "rollouts", base, "deliverables");
  if (isDir(out)) {
    for (const p of walkFiles(out)) {
      if (isView(basename(p))) {
        unlinkSync(p);
      }
    }
  }
  if (base === "none" || !isDir(baseDir)) {
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

export function changedFiles(ws: string, base: string): string[] {
  const out = join(ws, "out", "deliverables");
  const baseDir = join(ws, "rollouts", base, "deliverables");
  if (!isDir(out)) return [];
  return [...bundleFiles(out)]
    .filter((rel) => {
      const outP = join(out, rel);
      const baseP = join(baseDir, rel);
      return !isFile(baseP) || digestFile(outP) !== digestFile(baseP);
    })
    .sort();
}

export interface DriverArgs {
  contract: string;
  provider?: string;
  model?: string;
  thinking?: string;
  skill: string[];
  noSkills: boolean;
  skillsMode: string;
  piBin: string;
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

async function investigate(
  pi: Pi,
  args: DriverArgs,
  mission: string,
  skills: string[],
  spec: [string, string, string, string],
): Promise<boolean> {
  const [name, playbook, ledgerDoc, record] = spec;
  const ws = pi.ws;
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
    renderSkills(skills, ws, name, args.skillsMode);
  const tag = `[${name}] `;
  log(ws, `${tag}investigation: ${playbook}`);
  const session = pi.withSession(name);
  const sessionDir = join(ws, "session", name);
  await session.turn(message, args.turnTimeout, false, tag);
  if (ownRecord(sessionDir, join(ws, record)) === null) {
    await session.turn(NUDGE_LEDGER.replace("{record}", record), args.nudgeTimeout, true, tag);
  }
  const own = ownRecord(sessionDir, join(ws, record));
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

async function adjudicate(pi: Pi, args: DriverArgs, skills: string[]): Promise<Record<string, unknown> | null> {
  log(pi.ws, "adjudication: ADJUDICATE.md (fresh session)");
  const message =
    readFileSync(join(config.PROMPTS_DIR, "ADJUDICATE.md"), "utf8") +
    renderSkills(skills, pi.ws, "adjudicate", args.skillsMode);
  return pi.turnUntil(
    message,
    NUDGE_FINISH,
    join(pi.ws, "finish.json"),
    [args.turnTimeout, args.nudgeTimeout],
    false,
  );
}

async function deliver(
  pi: Pi,
  args: DriverArgs,
  finish: Record<string, unknown>,
  skills: string[],
): Promise<void> {
  const ws = pi.ws;
  const base = baseOf(finish);
  const baseLine =
    base !== "none"
      ? `\n\nThe adjudication named \`${base}\` as the base.\n`
      : "\n\nThe adjudication found no candidate worth starting from (base none): " +
        "build the deliverable from the inputs.\n";
  const message =
    readFileSync(join(config.PROMPTS_DIR, "REPAIR.md"), "utf8") +
    baseLine +
    renderSkills(skills, ws, "repair", args.skillsMode);
  ensureDir(join(ws, "out", "deliverables"));
  log(ws, "delivery: REPAIR.md (continuing adjudication session)");
  const repair = await pi.turnUntil(
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

function resolveSkills(names: string[]): string[] {
  return names.map((s) => (s.includes("/") ? s : resolve(join(config.SKILLS_DIR, s))));
}

function optionalNumber(name: string, raw: string | undefined): number | undefined | { error: string } {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return { error: `invalid ${name} '${raw}'` };
  return n;
}

export function parseDriverArgv(argv: string[]): { ws: string; args: DriverArgs } | { error: string } {
  const skillsFromArgv: string[] = [];
  const passthrough: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--skill") {
      skillsFromArgv.push(argv[++i]!);
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
    if (!(contract in CONTRACTS)) {
      return { error: `invalid contract ${contract}` };
    }
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
    const provider = canonicalLocalProvider(values.provider as string | undefined) ?? (values.provider as string | undefined);
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
        env: String(values.env ?? "jail"),
        turnTimeout: Number(values["turn-timeout"] ?? 1800),
        nudgeTimeout: Number(values["nudge-timeout"] ?? 600),
        taskTimeout: Number(values["task-timeout"] ?? 3600),
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

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseDriverArgv(argv);
  if ("error" in parsed) {
    if (parsed.error === "HELP") {
      process.stdout.write(
        "usage: veriharness driver <ws> [--contract artifact|pick-only] [--provider P] [--model M] " +
          "[--thinking T] [--base-url URL] [--context-size N] [--temperature N] [--max-tokens N] [--top-p N] " +
          "[--request-timeout S] [--skill NAME]... [--no-skills] [--skills-mode mounted|auto] " +
          "[--env jail|none|native|native-full] [--turn-timeout S] [--nudge-timeout S] [--task-timeout S]\n" +
          "local providers: --provider ollama (default http://127.0.0.1:11434) or --provider llamacpp " +
          "(default http://127.0.0.1:8080). Both need --model. No API key.\n",
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
          timeoutMs: args.requestTimeout === undefined ? undefined : args.requestTimeout * 1000,
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

  let pi = new Pi(ws, args.piBin, flags, useJail, Date.now() / 1000 + args.taskTimeout, null, localPiHome);

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

  const ok = await Promise.all(
    INVESTIGATIONS.map((spec) => investigate(investigator, args, mission, skills, spec)),
  );
  restoreRecords(ws);
  if (!ok.every(Boolean)) {
    log(ws, "an investigation left no record; recording no-output");
    return 1;
  }

  if (nativeImage) {
    log(ws, `native environment for adjudication and delivery: ${nativeImage}`);
    pi = pi.inNative(new Native(ws, nativeImage));
  }

  const finish = await adjudicate(pi, args, skills);
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
    await deliver(pi, args, finish, skills);
  }
  return 0;
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
