import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { main, type DriverDeps } from "../../../harness/driver.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const STUB = join(HERE, "stub.mjs");
export const STUB_PI = join(HERE, "stub-pi.mjs");

/** One recorded call of the stub: what the harness started it with. */
export interface Call {
  argv: string[];
  stdin: string;
  cwd: string;
  env: Record<string, string>;
}

/** One recorded call of the stand-in pi: how the message arrived and what it was. */
export interface PiCall {
  argv: string[];
  stdin: string;
  message: string;
  via: "argv" | "stdin" | "file";
  cwd: string;
  longestArgument: number;
}

export interface Rule {
  match?: string;
  times?: number;
  action: Record<string, unknown>;
}

export interface Rig {
  root: string;
  /** The task workspace: rollouts/r1/deliverables/answer.txt, workspace/, spec/. */
  ws: string;
  stubDir: string;
  /** Claude Code's configuration directory for the run: nothing here is the real one. */
  configDir: string;
  script(rules: Rule[]): void;
  calls(): Call[];
  /** The calls of the stand-in pi, when the run used one. */
  piCalls(): PiCall[];
  /** Run the driver with the stub as `claude`, with the retry waits removed. */
  run(argv: string[], env?: Record<string, string | undefined>, deps?: DriverDeps): Promise<number>;
  log(): string;
  cleanup(): void;
}

function readCalls<T>(stubDir: string): T[] {
  const dir = join(stubDir, "calls");
  try {
    return readdirSync(dir)
      .sort()
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as T);
  } catch {
    return [];
  }
}

/** A workspace with one rollout, and a stub binary directory, all under a fresh temporary directory. */
export function makeRig(): Rig {
  const root = mkdtempSync(join(tmpdir(), "vcc-"));
  const ws = join(root, "ws");
  const stubDir = join(root, "stub");
  const configDir = join(root, "config");
  for (const d of [join(ws, "rollouts", "r1", "deliverables"), join(ws, "workspace"), join(ws, "spec"), stubDir, configDir]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(ws, "rollouts", "r1", "deliverables", "answer.txt"), "r1 answer");
  const scriptPath = join(root, "script.json");
  writeFileSync(scriptPath, JSON.stringify({ rules: [] }));

  const rig: Rig = {
    root,
    ws,
    stubDir,
    configDir,
    script: (rules) => writeFileSync(scriptPath, JSON.stringify({ rules })),
    calls: () => readCalls<Call>(stubDir),
    piCalls: () => readCalls<PiCall>(stubDir),
    run: async (argv, env = {}, deps = {}) => {
      const set: Record<string, string | undefined> = {
        STUB_DIR: stubDir,
        STUB_SCRIPT: scriptPath,
        CLAUDE_CONFIG_DIR: configDir,
        ...env,
      };
      const before: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(set)) {
        before[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      const realLog = console.log;
      console.log = () => {};
      try {
        return await main([ws, ...argv], {
          claudeCommand: [process.execPath, STUB],
          backoff: [0, 0, 0],
          sleep: async () => {},
          ...deps,
        });
      } finally {
        console.log = realLog;
        for (const [k, v] of Object.entries(before)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    },
    log: () => {
      try {
        return readFileSync(join(ws, "driver.log"), "utf8");
      } catch {
        return "";
      }
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return rig;
}

const ELIM = { disagreements: [{ question: "q", checked: "c", found: "f", verdict: "r1" }], notes: "keep r1" };
const FALS = { challenges: [{ claim: "c", tried: "t", found: "f", holds: true, because: "b" }], notes: "n" };

/** A rule that makes the verifier write `file` with a Write tool call, as the real Write tool does. */
export function writeRule(ws: string, match: string, file: string, content: unknown, extra: Record<string, unknown> = {}): Rule {
  const text = JSON.stringify(content);
  return {
    match,
    action: {
      toolUses: [{ name: "Write", input: { file_path: join(ws, file), content: text } }],
      writes: [{ path: file, content: text }],
      ...extra,
    },
  };
}

/** The same for the stand-in pi: a `write` tool call in its transcript, in pi's format. */
export function piWriteRule(ws: string, match: string, file: string, content: unknown, extra: Record<string, unknown> = {}): Rule {
  const text = JSON.stringify(content);
  return {
    match,
    action: {
      toolUses: [{ name: "write", arguments: { path: join(ws, file), content: text } }],
      writes: [{ path: file, content: text }],
      ...extra,
    },
  };
}

/** Rules for a pi task in which every phase succeeds. */
export function piHappyRules(ws: string): Rule[] {
  return [
    piWriteRule(ws, "# Repair", "repair.json", { base: "r1", applied: false, changes: [], open: [], summary: "unchanged" }),
    piWriteRule(ws, "# Adjudication", "finish.json", { base: "r1", work: [], open: [], notes: "r1" }),
    piWriteRule(ws, "# Discrimination", "ledger_elim.json", ELIM),
    piWriteRule(ws, "# Falsification", "ledger_fals.json", FALS),
  ];
}

/** Rules for a task in which every phase succeeds. Each phase is recognised by the heading of its prompt. */
export function happyRules(ws: string): Rule[] {
  return [
    writeRule(ws, "# Repair", "repair.json", { base: "r1", applied: false, changes: [], open: [], summary: "unchanged" }),
    writeRule(ws, "# Adjudication", "finish.json", { base: "r1", work: [], open: [], notes: "r1" }),
    writeRule(ws, "# Discrimination", "ledger_elim.json", ELIM),
    writeRule(ws, "# Falsification", "ledger_fals.json", FALS),
  ];
}

export { ELIM, FALS };
