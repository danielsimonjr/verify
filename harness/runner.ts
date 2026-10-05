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

/** Batch runner: drive materialized tasks through the driver with one global work pool. */

import { closeSync, cpSync, mkdirSync, openSync, readdirSync, writeSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { USAGE_LIMIT_EXIT, UNSUPPORTED_WITH_CLAUDE_CODE, isClaudeCodeProvider } from "./claude/index.js";
import * as config from "./config.js";
import { claudeCodeRefusal } from "./driver.js";
import { exists, isDir, mtime, readText, rmrf, walkFiles, writeJson } from "./fsutil.js";
import { flagValue, withModelOverride } from "./model/flags.js";
import { PyRandom, pyRound } from "./pyrandom.js";
import { harnessCommand, isMain } from "./runtime.js";
import { renderViews } from "./views.js";

/**
 * Tasks a lane runs at once. The Claude Code lanes default low: a subscription's usage limit is shared
 * with every other Claude Code session of the account, so they start at 2 and `--lane-max haiku=4` raises one.
 */
const DEFAULT_LANE_MAX: Record<string, number> = { flash: 25, opus: 45, haiku: 2, sonnet: 2 };
const DEFAULT_CELL_CAP: Record<string, number> = {
  apex: 8,
  wb: 10,
  sb2: 14,
  jb: 14,
  wsb: 14,
  default: 12,
};

function lastActivity(ws: string): number {
  const files: string[] = [join(ws, "driver.log")];
  const session = join(ws, "session");
  if (isDir(session)) {
    files.push(...walkFiles(session).filter((p) => p.endsWith(".jsonl")));
  }
  let max = 0;
  for (const f of files) {
    if (exists(f)) max = Math.max(max, mtime(f));
  }
  return max;
}

/** The command that runs one task. Tests replace it with a stub; production runs the driver. */
type DriverCommand = (ws: string, flags: string[]) => string[];

/**
 * Run a command to completion with its output going to `outFd`, and resolve to its exit code.
 * The child runs asynchronously: a blocking spawn would hold the event loop for the whole task
 * and let no other task start.
 */
function runToExit(cmd: string[], outFd: number): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (rc: number) => {
      if (!settled) {
        settled = true;
        resolve(rc);
      }
    };
    const child = spawn(cmd[0]!, cmd.slice(1), { cwd: config.REPO, stdio: ["ignore", outFd, outFd] });
    child.once("error", (e) => {
      writeSync(outFd, `spawn failed: ${e.message}\n`);
      finish(1);
    });
    child.once("close", (code) => finish(code ?? 1));
  });
}

async function runTask(
  src: string,
  ws: string,
  lane: string,
  driverArgs: string[],
  skipInflightMin: number,
  driverCommand: DriverCommand = (w, flags) => harnessCommand(import.meta.url, "driver", [w, ...flags]),
): Promise<string> {
  if (exists(join(ws, "finish.json"))) {
    return "skip";
  }
  if (exists(ws) && skipInflightMin && Date.now() / 1000 - lastActivity(ws) < skipInflightMin * 60) {
    return "inflight";
  }
  if (exists(ws)) {
    rmrf(ws);
  }
  cpSync(src, ws, { recursive: true });
  // The driver and its verifier read these views as evidence, so they must exist before launch.
  await Promise.all([renderViews(join(ws, "workspace")), renderViews(join(ws, "rollouts"))]);
  const cmd = driverCommand(ws, flagsForLane(lane, driverArgs));
  const outFd = openSync(join(ws, "run.out"), "w");
  let rc = 1;
  try {
    rc = await runToExit(cmd, outFd);
  } finally {
    closeSync(outFd);
  }
  // A usage limit is the account's, not the task's: the driver says so by exit code, and the caller stops the lane.
  if (rc === USAGE_LIMIT_EXIT) return "usage-limit";
  return exists(join(ws, "finish.json")) ? "ok" : `no-finish(rc=${rc})`;
}

interface RunnerArgs {
  cells: string[];
  runName: string;
  contract: string;
  lane?: string;
  /** `--max-flash`, an alias of `--lane-max flash=N`. */
  maxFlash?: number;
  /** `--max-opus`, an alias of `--lane-max opus=N`. */
  maxOpus?: number;
  laneMax: Record<string, number>;
  /** `--env`, passed to every driver; unset leaves the driver's default (the jail). */
  env?: string;
  caps: Record<string, number>;
  only: string[];
  onlyFile?: string;
  limit: number;
  sample: number;
  fraction: number;
  seed: number;
  turnTimeout?: number;
  taskTimeout?: number;
  skipInflight: number;
  skill: string[];
  noSkills: boolean;
  skillsMode: string;
  driverArg: string[];
  provider?: string;
  model?: string;
  baseUrl?: string;
  contextSize?: string;
  temperature?: string;
  maxTokens?: string;
  topP?: string;
  requestTimeout?: string;
}

/** Lane flags, then driver flags, with later copies of the same option winning. */
export function flagsForLane(lane: string, driverArgs: string[]): string[] {
  return withModelOverride(config.LANES[lane] ?? [], driverArgs);
}

/** The same elements, in the same order, as Python's `random.Random(seed).sample(keys, n)`. */
export function seededSample<T>(keys: readonly T[], n: number, seed: number): T[] {
  return new PyRandom(seed).sample(keys, n);
}

/** Python's `max(1, round(n * fraction))`: `round` takes ties to the even integer. */
export function fractionCount(n: number, fraction: number): number {
  return Math.max(1, pyRound(n * fraction));
}

function selectKeys(dataDir: string, bench: string, pool: string, args: RunnerArgs): string[] {
  const tasksDir = join(dataDir, bench, pool, "tasks");
  let keys = readdirSync(tasksDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const only = new Set(args.only);
  if (args.onlyFile) {
    for (const line of readText(args.onlyFile).split("\n")) {
      const t = line.replace(/\n$/, "");
      if (t.trim()) only.add(t);
    }
  }
  if (only.size) {
    keys = keys.filter((k) => only.has(k));
  }
  if (args.limit) {
    keys = keys.slice(0, args.limit);
  }
  if (args.sample && args.sample < keys.length) {
    keys = seededSample(keys, args.sample, args.seed).sort();
  }
  if (args.fraction > 0 && args.fraction < 1 && keys.length) {
    keys = seededSample(keys, fractionCount(keys.length, args.fraction), args.seed).sort();
  }
  return keys;
}

/**
 * Parse an integer flag the way argparse's `type=int` did. `Number()` turns a typo into NaN,
 * which a seed or a cap then carries silently into the run.
 */
function intOption(name: string, raw: string | undefined, fallback: number, min = -Infinity): number {
  if (raw === undefined) return fallback;
  if (!/^[+-]?\d+$/.test(raw.trim())) throw new Error(`--${name} must be an integer, got '${raw}'`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new Error(`--${name} is out of range: '${raw}'`);
  if (n < min) throw new Error(`--${name} must be at least ${min}, got ${n}`);
  return n;
}

/** An optional integer flag of at least 1; unset stays undefined so the driver keeps its default. */
function optionalPositive(name: string, raw: string | undefined): number | undefined {
  return raw === undefined ? undefined : intOption(name, raw, 0, 1);
}

/**
 * Parse `--lane-max lane=N[,lane=N]` (repeatable). A lane that does not exist would do nothing, and a
 * cap that is not an integer of at least 1 would let the lane never start a task.
 */
function parseLaneMax(specs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of specs) {
    for (const item of spec.split(",").filter((s) => s.trim())) {
      const eq = item.indexOf("=");
      const lane = (eq < 0 ? item : item.slice(0, eq)).trim();
      const raw = eq < 0 ? "" : item.slice(eq + 1).trim();
      if (!isLane(lane)) {
        throw new Error(`--lane-max: unknown lane '${lane}' (known: ${Object.keys(config.LANES).join(", ")})`);
      }
      if (!/^\d+$/.test(raw) || Number(raw) < 1) {
        throw new Error(`--lane-max: '${lane}' needs an integer of at least 1, got '${raw}'`);
      }
      out[lane] = Number(raw);
    }
  }
  return out;
}

/**
 * Parse `bench=N,...` (key `default` for the rest) over the default caps. A cap that is not an
 * integer of at least 1 would make `inUseCell < cap` false forever: the cell never starts and
 * the scheduler loop wakes every few seconds for nothing. An unknown key would do nothing.
 */
function parseCaps(spec: string): Record<string, number> {
  const caps = { ...DEFAULT_CELL_CAP };
  for (const item of spec.split(",").filter((s) => s.trim())) {
    const eq = item.indexOf("=");
    const key = (eq < 0 ? item : item.slice(0, eq)).trim();
    const raw = eq < 0 ? "" : item.slice(eq + 1).trim();
    if (key !== "default" && !(config.BENCHES as readonly string[]).includes(key)) {
      throw new Error(`--cell-cap: unknown key '${key}' (use a bench: ${config.BENCHES.join(", ")}; or default)`);
    }
    if (!/^\d+$/.test(raw) || Number(raw) < 1) {
      throw new Error(`--cell-cap: '${key}' needs an integer of at least 1, got '${raw}'`);
    }
    caps[key] = Number(raw);
  }
  return caps;
}

const ENVS = ["jail", "none", "native", "native-full"];

/** `--env`: one of the driver's environments, or unset. Anything else would fail every task at its start. */
function envOption(raw: string | undefined): string | undefined {
  if (raw !== undefined && !ENVS.includes(raw)) {
    throw new Error(`--env must be one of ${ENVS.join("|")}, got '${raw}'`);
  }
  return raw;
}

/** `--fraction`: a number from 0 to 1. A typo parsed as NaN would mean "no sampling", the full set. */
function fractionOption(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`--fraction must be a number from 0 to 1, got '${raw}'`);
  }
  return n;
}

function driverProcesses(): Record<string, number> {
  const seen: Record<string, number> = Object.fromEntries(Object.keys(config.LANES).map((l) => [l, 0]));
  try {
    const hit = spawnSync("pgrep", ["-af", "harness/driver"], { encoding: "utf8" });
    const ps = hit.stdout || "";
    for (const line of ps.split("\n")) {
      for (const [lane, flags] of Object.entries(config.LANES)) {
        const modelIdx = flags.indexOf("--model") + 1;
        if (modelIdx > 0 && flags[modelIdx] && line.includes(flags[modelIdx])) {
          seen[lane] = (seen[lane] ?? 0) + 1;
        }
      }
    }
  } catch {
    return seen;
  }
  return seen;
}

function parseRunnerArgv(argv: string[]): RunnerArgs | { error: string } {
  const only: string[] = [];
  const skill: string[] = [];
  const driverArg: string[] = [];
  const passthrough: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--only") only.push(argv[++i]!);
    else if (a === "--skill") skill.push(argv[++i]!);
    else if (a === "--driver-arg") driverArg.push(argv[++i]!);
    else passthrough.push(a);
  }
  try {
    const { values } = parseArgs({
      args: passthrough,
      options: {
        cells: { type: "string", multiple: true },
        "run-name": { type: "string" },
        contract: { type: "string", default: "artifact" },
        lane: { type: "string" },
        "max-flash": { type: "string" },
        "max-opus": { type: "string" },
        "lane-max": { type: "string", multiple: true },
        env: { type: "string" },
        "cell-cap": { type: "string", default: "" },
        "only-file": { type: "string" },
        limit: { type: "string", default: "0" },
        sample: { type: "string", default: "0" },
        fraction: { type: "string", default: "0" },
        seed: { type: "string", default: "0" },
        "turn-timeout": { type: "string" },
        "task-timeout": { type: "string" },
        "skip-inflight": { type: "string", default: "45" },
        "no-skills": { type: "boolean", default: false },
        "skills-mode": { type: "string", default: "mounted" },
        provider: { type: "string" },
        model: { type: "string" },
        "base-url": { type: "string" },
        "context-size": { type: "string" },
        temperature: { type: "string" },
        "max-tokens": { type: "string" },
        "top-p": { type: "string" },
        "request-timeout": { type: "string" },
      },
    });
    const cells = (values.cells as string[] | undefined) ?? [];
    if (!cells.length || !values["run-name"]) {
      return { error: "--cells and --run-name are required" };
    }
    return {
      cells,
      runName: String(values["run-name"]),
      contract: String(values.contract ?? "artifact"),
      lane: values.lane as string | undefined,
      maxFlash: optionalPositive("max-flash", values["max-flash"]),
      maxOpus: optionalPositive("max-opus", values["max-opus"]),
      laneMax: parseLaneMax((values["lane-max"] as string[] | undefined) ?? []),
      env: envOption(values.env as string | undefined),
      caps: parseCaps(String(values["cell-cap"] ?? "")),
      only,
      onlyFile: values["only-file"] as string | undefined,
      limit: intOption("limit", values.limit, 0, 0),
      sample: intOption("sample", values.sample, 0, 0),
      fraction: fractionOption(values.fraction),
      seed: intOption("seed", values.seed, 0),
      turnTimeout: optionalPositive("turn-timeout", values["turn-timeout"]),
      taskTimeout: optionalPositive("task-timeout", values["task-timeout"]),
      skipInflight: intOption("skip-inflight", values["skip-inflight"], 45, 0),
      skill,
      noSkills: Boolean(values["no-skills"]),
      skillsMode: String(values["skills-mode"] ?? "mounted"),
      driverArg,
      provider: values.provider as string | undefined,
      model: values.model as string | undefined,
      baseUrl: values["base-url"] as string | undefined,
      contextSize: values["context-size"] as string | undefined,
      temperature: values.temperature as string | undefined,
      maxTokens: values["max-tokens"] as string | undefined,
      topP: values["top-p"] as string | undefined,
      requestTimeout: values["request-timeout"] as string | undefined,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * One path segment: no separator and no leading dot, so "." and ".." cannot climb out of the
 * directory a name is joined under. run_name and each cell pool are joined under the runs and
 * data directories, and runTask removes an existing task workspace there.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** An own key only: `"constructor" in LANES` is true and would pass an inherited name as a lane. */
function isLane(name: string): boolean {
  return Object.hasOwn(config.LANES, name);
}

/** `bench:pool`. Neither part can hold a colon (a bench is one of BENCHES, a pool is one path segment). */
type CellKey = `${string}:${string}`;

function cellKey(bench: string, pool: string): CellKey {
  return `${bench}:${pool}`;
}

/** Seams for tests: where the pools and runs live, and what stands in for the driver. */
export interface RunnerDeps {
  dataDir?: string;
  runsDir?: string;
  driverCommand?: DriverCommand;
  /** Milliseconds between scheduling passes while tasks wait for capacity (default 3000). */
  pollMs?: number;
}

/**
 * Run the batch runner: validate the arguments, stage each selected task and drive it through
 * the driver under the lane and cell caps. Resolves to the exit code: 0 when every task ended
 * ok, skipped or in flight, 1 when any failed, 2 for a bad argument.
 */
export async function main(argv: string[] = process.argv.slice(2), deps: RunnerDeps = {}): Promise<number> {
  const dataDir = deps.dataDir ?? config.DATA;
  const runsDir = deps.runsDir ?? config.RUNS;
  const parsed = parseRunnerArgv(argv);
  if ("error" in parsed) {
    process.stderr.write(`error: ${parsed.error}\n`);
    return 2;
  }
  const args = parsed;

  if (args.cells.some((c) => !c.includes(":"))) {
    process.stderr.write("error: a cell is <bench>:<pool>\n");
    return 2;
  }
  if (!SEGMENT.test(args.runName)) {
    process.stderr.write(`error: --run-name must be one path segment ([A-Za-z0-9][A-Za-z0-9._-]*), got '${args.runName}'\n`);
    return 2;
  }
  const cells = args.cells.map((c) => {
    const colon = c.indexOf(":");
    return [c.slice(0, colon), c.slice(colon + 1)] as [string, string];
  });
  for (const [, pool] of cells) {
    if (!SEGMENT.test(pool)) {
      process.stderr.write(`error: a cell pool must be one path segment ([A-Za-z0-9][A-Za-z0-9._-]*), got '${pool}'\n`);
      return 2;
    }
  }
  if (args.lane && !isLane(args.lane)) {
    process.stderr.write(`error: unknown lane '${args.lane}' (known: ${Object.keys(config.LANES).join(", ")})\n`);
    return 2;
  }
  for (const [bench, pool] of cells) {
    if (!(config.BENCHES as readonly string[]).includes(bench)) {
      process.stderr.write(`error: unknown bench '${bench}'\n`);
      return 2;
    }
    if (!isLane(pool) && !args.lane) {
      process.stderr.write(`error: pool '${pool}' names no lane; pass --lane\n`);
      return 2;
    }
  }
  const laneOf: Record<string, string> = {};
  for (const [, pool] of cells) {
    laneOf[pool] = args.lane ?? pool;
  }
  const driverArgs = ["--contract", args.contract];
  if (args.turnTimeout) driverArgs.push("--turn-timeout", String(args.turnTimeout));
  if (args.taskTimeout) driverArgs.push("--task-timeout", String(args.taskTimeout));
  if (args.noSkills) driverArgs.push("--no-skills");
  for (const s of args.skill) driverArgs.push("--skill", s);
  if (args.skillsMode !== "mounted") driverArgs.push("--skills-mode", args.skillsMode);
  if (args.env !== undefined) driverArgs.push("--env", args.env);
  const modelFlags: string[] = [];
  for (const [flag, value] of [
    ["--provider", args.provider],
    ["--model", args.model],
    ["--base-url", args.baseUrl],
    ["--context-size", args.contextSize],
    ["--temperature", args.temperature],
    ["--max-tokens", args.maxTokens],
    ["--top-p", args.topP],
    ["--request-timeout", args.requestTimeout],
  ] as const) {
    if (value) modelFlags.push(flag, value);
  }
  driverArgs.push(...withModelOverride(modelFlags, args.driverArg));

  if (
    Object.values(laneOf).some((lane) => flagValue(flagsForLane(lane, driverArgs), "--provider") === "vertex-litellm")
  ) {
    const up = spawnSync(join(config.SCRIPTS_DIR, "litellm_up.sh"), { stdio: "inherit" });
    if (up.status !== 0) {
      return up.status ?? 1;
    }
  }

  // A lane that runs Claude Code fails every task at its start unless it runs with --env none: say so now.
  for (const lane of new Set(Object.values(laneOf))) {
    const flags = flagsForLane(lane, driverArgs);
    if (!isClaudeCodeProvider(flagValue(flags, "--provider"))) continue;
    const given = Object.fromEntries(UNSUPPORTED_WITH_CLAUDE_CODE.map((n) => [n, flagValue(flags, `--${n}`)]));
    const refusal = claudeCodeRefusal(args.env ?? "jail", flagValue(flags, "--model"), given);
    if (refusal !== null) {
      process.stderr.write(`error: lane ${lane}: ${refusal}\n`);
      return 2;
    }
  }

  const caps = args.caps;
  const laneMax: Record<string, number> = Object.fromEntries(
    Object.keys(config.LANES).map((lane) => [
      lane,
      DEFAULT_LANE_MAX[lane] ?? Math.max(...Object.values(DEFAULT_LANE_MAX)),
    ]),
  );
  if (args.maxFlash !== undefined) laneMax.flash = args.maxFlash;
  if (args.maxOpus !== undefined) laneMax.opus = args.maxOpus;
  Object.assign(laneMax, args.laneMax);

  const root = join(runsDir, args.runName);
  const plan: [string, string, string, string][][] = [];
  const cellCap: Record<CellKey, number> = {} as Record<CellKey, number>;

  for (const [bench, pool] of cells) {
    const cellDir = join(root, `${bench}_${pool}`);
    mkdirSync(cellDir, { recursive: true });
    const keys = selectKeys(dataDir, bench, pool, args);
    const ck = cellKey(bench, pool);
    cellCap[ck] = caps[bench] ?? caps.default!;
    writeJson(join(cellDir, "run.json"), {
      bench,
      pool,
      lane: laneOf[pool],
      contract: args.contract,
      n_tasks: keys.length,
      sample: args.sample,
      fraction: args.fraction,
      seed: args.seed,
      skills: args.noSkills ? "none" : args.skill.length ? args.skill : "default",
      skills_mode: args.skillsMode,
      cell_cap: cellCap[ck],
      lane_max: laneMax,
      driver_args: driverArgs,
      keys,
    });
    plan.push(keys.map((k) => [bench, pool, cellDir, k]));
    console.log(`${bench}/${pool}: tasks=${keys.length} cap=${cellCap[ck]}`);
  }

  const maxLen = Math.max(0, ...plan.map((p) => p.length));
  const queue: [string, string, string, string][] = [];
  for (let i = 0; i < maxLen; i++) {
    for (const p of plan) {
      if (i < p.length) queue.push(p[i]!);
    }
  }
  const total = queue.length;
  const lock = { locked: false };
  const inUseLane: Record<string, number> = Object.fromEntries(
    Object.keys(config.LANES).map((l) => [l, 0]),
  );
  const inUseCell: Record<CellKey, number> = {} as Record<CellKey, number>;
  for (const [bench, pool] of cells) {
    inUseCell[cellKey(bench, pool)] = 0;
  }
  const counts: Record<string, number> = {};
  let done = 0;
  /** Lanes whose account hit a usage limit: no further task starts on them. */
  const stopped = new Set<string>();

  const withLock = <T>(fn: () => T): T => {
    while (lock.locked) {
      /* spin */
    }
    lock.locked = true;
    try {
      return fn();
    } finally {
      lock.locked = false;
    }
  };

  const work = async (bench: string, pool: string, cellDir: string, key: string) => {
    let status: string;
    try {
      status = await runTask(
        join(dataDir, bench, pool, "tasks", key),
        join(cellDir, key),
        laneOf[pool]!,
        driverArgs,
        args.skipInflight,
        deps.driverCommand,
      );
    } catch (e) {
      status = `error(${e})`;
    }
    if (status === "usage-limit") stopped.add(laneOf[pool]!);
    withLock(() => {
      inUseLane[laneOf[pool]!]!--;
      inUseCell[cellKey(bench, pool)]!--;
      counts[status] = (counts[status] ?? 0) + 1;
      done++;
      console.log(`[${done}/${total}] ${bench}/${pool} ${key}: ${status}`);
    });
  };

  console.log(`scheduling ${total} tasks; lane max ${JSON.stringify(laneMax)}; cell caps ${JSON.stringify(cellCap)}`);

  const active = new Set<Promise<void>>();
  let pending = queue;

  while (pending.length) {
    const rest: [string, string, string, string][] = [];
    const seen = driverProcesses();
    const ext = withLock(() => {
      const out: Record<string, number> = {};
      for (const lane of Object.keys(config.LANES)) {
        out[lane] = Math.max(0, (seen[lane] ?? 0) - inUseLane[lane]!);
      }
      return out;
    });

    for (const item of pending) {
      const [bench, pool] = item;
      const lane = laneOf[pool]!;
      if (stopped.has(lane)) {
        withLock(() => {
          counts["lane-stopped"] = (counts["lane-stopped"] ?? 0) + 1;
          done++;
          console.log(`[${done}/${total}] ${bench}/${pool} ${item[3]}: lane-stopped (usage limit on lane ${lane}; not started)`);
        });
        continue;
      }
      const ok = withLock(() => {
        const ck = cellKey(bench, pool);
        if (inUseLane[lane]! + ext[lane]! < laneMax[lane]! && inUseCell[ck]! < cellCap[ck]!) {
          inUseLane[lane]!++;
          inUseCell[ck]!++;
          return true;
        }
        return false;
      });
      if (ok) {
        const p = work(bench, pool, item[2], item[3]);
        active.add(p);
        p.finally(() => active.delete(p));
      } else {
        rest.push(item);
      }
    }
    pending = rest;
    if (pending.length) {
      await new Promise((r) => setTimeout(r, deps.pollMs ?? 3000));
    }
  }
  await Promise.all([...active]);

  console.log("done:", JSON.stringify(counts));
  const okStatuses = new Set(["ok", "skip", "inflight"]);
  const allOk = Object.keys(counts).every((k) => okStatuses.has(k));
  return allOk ? 0 : 1;
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
