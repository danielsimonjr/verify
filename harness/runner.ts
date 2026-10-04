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

import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import * as config from "./config.js";
import { exists, isDir, mtime, readText, rmrf, walkFiles, writeJson } from "./fsutil.js";
import { harnessCommand, isMain } from "./runtime.js";
import { renderViews } from "./views.js";

const DEFAULT_LANE_MAX: Record<string, number> = { flash: 25, opus: 45 };
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

function runTask(
  src: string,
  ws: string,
  lane: string,
  driverArgs: string[],
  skipInflightMin: number,
): string {
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
  renderViews(join(ws, "workspace"));
  renderViews(join(ws, "rollouts"));
  const cmd = harnessCommand(import.meta.url, "driver", [ws, ...config.LANES[lane]!, ...driverArgs]);
  const outFd = openSync(join(ws, "run.out"), "w");
  let rc = 1;
  try {
    const hit = spawnSync(cmd[0]!, cmd.slice(1), {
      cwd: config.REPO,
      stdio: ["ignore", outFd, outFd],
    });
    rc = hit.status ?? 1;
  } finally {
    closeSync(outFd);
  }
  return exists(join(ws, "finish.json")) ? "ok" : `no-finish(rc=${rc})`;
}

interface RunnerArgs {
  cells: string[];
  runName: string;
  contract: string;
  lane?: string;
  maxFlash: number;
  maxOpus: number;
  cellCap: string;
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
}

/** Match Python random.Random(seed).sample (Fisher–Yates on a seeded LCG). */
function seededSample<T>(keys: T[], n: number, seed: number): T[] {
  const copy = [...keys];
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}

function selectKeys(bench: string, pool: string, args: RunnerArgs): string[] {
  const tasksDir = join(config.DATA, bench, pool, "tasks");
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
  if (args.fraction > 0 && args.fraction < 1) {
    keys = seededSample(keys, Math.max(1, Math.round(keys.length * args.fraction)), args.seed).sort();
  }
  return keys;
}

function parseCaps(spec: string): Record<string, number> {
  const caps = { ...DEFAULT_CELL_CAP };
  for (const item of (spec || "").split(",").filter(Boolean)) {
    const [k, v] = item.split("=");
    caps[k.trim()] = parseInt(v!, 10);
  }
  return caps;
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
        "max-flash": { type: "string", default: String(DEFAULT_LANE_MAX.flash) },
        "max-opus": { type: "string", default: String(DEFAULT_LANE_MAX.opus) },
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
      maxFlash: Number(values["max-flash"] ?? DEFAULT_LANE_MAX.flash),
      maxOpus: Number(values["max-opus"] ?? DEFAULT_LANE_MAX.opus),
      cellCap: String(values["cell-cap"] ?? ""),
      only,
      onlyFile: values["only-file"] as string | undefined,
      limit: Number(values.limit ?? 0),
      sample: Number(values.sample ?? 0),
      fraction: Number(values.fraction ?? 0),
      seed: Number(values.seed ?? 0),
      turnTimeout: values["turn-timeout"] ? Number(values["turn-timeout"]) : undefined,
      taskTimeout: values["task-timeout"] ? Number(values["task-timeout"]) : undefined,
      skipInflight: Number(values["skip-inflight"] ?? 45),
      skill,
      noSkills: Boolean(values["no-skills"]),
      skillsMode: String(values["skills-mode"] ?? "mounted"),
      driverArg,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

type CellKey = `${string}\0${string}`;

function cellKey(bench: string, pool: string): CellKey {
  return `${bench}\0${pool}`;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
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
  const cells = args.cells.map((c) => {
    const [bench, pool] = c.split(":", 2);
    return [bench!, pool!] as [string, string];
  });
  for (const [bench, pool] of cells) {
    if (!(config.BENCHES as readonly string[]).includes(bench)) {
      process.stderr.write(`error: unknown bench '${bench}'\n`);
      return 2;
    }
    if (!(pool in config.LANES) && !args.lane) {
      process.stderr.write(`error: pool '${pool}' names no lane; pass --lane\n`);
      return 2;
    }
  }
  const laneOf: Record<string, string> = {};
  for (const [, pool] of cells) {
    laneOf[pool] = args.lane ?? pool;
  }
  if (Object.values(laneOf).some((lane) => (config.PROXIED_LANES as readonly string[]).includes(lane))) {
    const up = spawnSync(join(config.SCRIPTS_DIR, "litellm_up.sh"), { stdio: "inherit" });
    if (up.status !== 0) {
      return up.status ?? 1;
    }
  }

  const driverArgs = ["--contract", args.contract];
  if (args.turnTimeout) driverArgs.push("--turn-timeout", String(args.turnTimeout));
  if (args.taskTimeout) driverArgs.push("--task-timeout", String(args.taskTimeout));
  if (args.noSkills) driverArgs.push("--no-skills");
  for (const s of args.skill) driverArgs.push("--skill", s);
  if (args.skillsMode !== "mounted") driverArgs.push("--skills-mode", args.skillsMode);
  driverArgs.push(...args.driverArg);

  const caps = parseCaps(args.cellCap);
  const laneMax: Record<string, number> = Object.fromEntries(
    Object.keys(config.LANES).map((lane) => [lane, Math.max(...Object.values(DEFAULT_LANE_MAX))]),
  );
  laneMax.flash = args.maxFlash;
  laneMax.opus = args.maxOpus;

  const root = join(config.RUNS, args.runName);
  const plan: [string, string, string, string][][] = [];
  const cellCap: Record<CellKey, number> = {} as Record<CellKey, number>;

  for (const [bench, pool] of cells) {
    const cellDir = join(root, `${bench}_${pool}`);
    mkdirSync(cellDir, { recursive: true });
    const keys = selectKeys(bench, pool, args);
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
      status = runTask(
        join(config.DATA, bench, pool, "tasks", key),
        join(cellDir, key),
        laneOf[pool]!,
        driverArgs,
        args.skipInflight,
      );
    } catch (e) {
      status = `error(${e})`;
    }
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
      await new Promise((r) => setTimeout(r, 3000));
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
