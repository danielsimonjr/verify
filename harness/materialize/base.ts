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

/** Shared materialization machinery for all benchmarks. */

import { copyFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { DATA, benchRoot } from "../config.js";
import { parseCount } from "../count.js";
import {
  ensureDir,
  exists,
  posixRel,
  readText,
  rmrf,
  symlinkDir,
  walkFiles,
  writeFileAtomic,
  writeText,
} from "../fsutil.js";
import { renderViews } from "../views.js";

/** A command-line mistake: the caller prints the message and exits 2. */
export class UsageError extends Error {}

/**
 * Parse a JSON file that must exist and be valid. `readJson` in fsutil returns null for both,
 * which callers then read as "empty" or trip over; adapters and graders want the path in the error.
 */
export function readJsonStrict<T = unknown>(path: string): T {
  let raw: string;
  try {
    raw = readText(path);
  } catch (e) {
    throw new Error(`cannot read ${path}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new Error(`invalid JSON in ${path}: ${(e as Error).message}`);
  }
}

/** Reject anything that is not one plain path segment before it is joined under a root and deleted. */
export function assertSegment(label: string, value: string): void {
  if (!value || value === "." || value === ".." || /[\\/\0]/.test(value)) {
    throw new Error(`${label} must be a single path segment, got ${JSON.stringify(value)}`);
  }
}

function writeJsonAtomic(path: string, obj: unknown): void {
  writeFileAtomic(path, JSON.stringify(obj, null, 1));
}

export type TextOrFn = string | (() => string);

const BLOCK_NAMES = new Set([
  "grades.json",
  "grade.json",
  "verifiers.json",
  "RUBRICS.json",
  "dataset.json",
  "task.toml",
]);
const BLOCK_PREFIXES = ["rubrics_judge"];
const BLOCK_SUBSTR = ["golden"];
const BLOCK_DIRS = new Set([
  "tests",
  "solution",
  "eval_result",
  "model_output",
  "model_traj",
]);

export function isLeakBlocked(name: string): boolean {
  const low = name.toLowerCase();
  return (
    BLOCK_NAMES.has(name) ||
    BLOCK_PREFIXES.some((p) => name.startsWith(p)) ||
    BLOCK_SUBSTR.some((s) => low.includes(s))
  );
}

export function copyFile(src: string, dst: string, lenient = false): void {
  if (isLeakBlocked(basename(src))) {
    if (!lenient) {
      throw new Error(`leak blocklist refuses to copy: ${src}`);
    }
    console.warn(`WARNING: copying blocklist-named rollout file: ${src}`);
  }
  ensureDir(dirname(dst));
  copyFileSync(src, dst);
}

export function copyTree(src: string, dst: string): void {
  const files = walkFiles(src, { followLinks: false }).sort();
  for (const p of files) {
    const rel = posixRel(src, p);
    if (rel.split("/").some((part) => BLOCK_DIRS.has(part))) continue;
    if (isLeakBlocked(basename(p))) continue;
    copyFile(p, join(dst, rel));
  }
}

export class Rollout {
  seed: string;
  score: number | null;
  files: [string, string][] = [];
  texts: [string, TextOrFn][] = [];
  traj: TextOrFn | null = null;
  trajFiles: [string, string][] = [];

  constructor(seed: string, score: number | null) {
    this.seed = seed;
    this.score = score;
  }
}

export class Task {
  key: string;
  spec: string;
  workspace: [string, string][] = [];
  workspaceTexts: [string, TextOrFn][] = [];
  trees: [string, string][] = [];
  rollouts: Record<string, Rollout> = {};
  links: [string, string][] = [];

  constructor(key: string, spec: string) {
    this.key = key;
    this.spec = spec;
  }
}

function text(v: TextOrFn): string {
  return typeof v === "function" ? v() : v;
}

export async function writeTask(
  bench: string,
  pool: string,
  task: Task,
  dataRoot: string = DATA,
): Promise<Record<string, unknown>> {
  // The task directory is deleted before it is rewritten: every segment must be a plain name,
  // or a key like ".." would wipe the whole pool (and its meta.json).
  assertSegment("bench", bench);
  assertSegment("pool", pool);
  assertSegment("task key", task.key);
  const ws = join(dataRoot, bench, pool, "tasks", task.key);
  rmrf(ws);
  ensureDir(join(ws, "spec"));
  writeText(join(ws, "spec", "task.md"), task.spec);
  ensureDir(join(ws, "workspace"));
  for (const [src, name] of task.workspace) {
    copyFile(src, join(ws, "workspace", name));
  }
  for (const [name, txt] of task.workspaceTexts) {
    writeText(join(ws, "workspace", name), text(txt));
  }
  for (const [srcdir, name] of task.trees) {
    copyTree(srcdir, name ? join(ws, "workspace", name) : join(ws, "workspace"));
  }
  for (const [name, target] of task.links) {
    symlinkDir(resolve(target), join(ws, "workspace", name));
  }
  await renderViews(join(ws, "workspace"));

  const meta: { rollouts: Record<string, { seed: string; score: number | null }> } = {
    rollouts: {},
  };
  const seeds = Object.keys(task.rollouts).sort();
  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i]!;
    const label = `r${String(i + 1).padStart(2, "0")}`;
    const r = task.rollouts[seed]!;
    const rdir = join(ws, "rollouts", label);
    ensureDir(join(rdir, "deliverables"));
    for (const [src, name] of r.files) {
      copyFile(src, join(rdir, "deliverables", name), true);
    }
    for (const [name, txt] of r.texts) {
      writeText(join(rdir, "deliverables", name), text(txt));
    }
    if (r.traj !== null || r.trajFiles.length) {
      ensureDir(join(rdir, "trajectory"));
    }
    if (r.traj !== null) {
      writeText(join(rdir, "trajectory", "trajectory.txt"), text(r.traj));
    }
    for (const [src, name] of r.trajFiles) {
      copyFile(src, join(rdir, "trajectory", name));
    }
    await renderViews(join(rdir, "deliverables"));
    meta.rollouts[label] = { seed, score: r.score };
  }
  return meta;
}

export type TaskIterable = Iterable<Task> | AsyncIterable<Task>;

export function parseCliArgs(argv: string[], pools: string[]) {
  let pool = "all";
  const only: string[] = [];
  let limit: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === "--pool") {
      pool = value();
    } else if (a === "--only") {
      only.push(value());
    } else if (a === "--limit") {
      const v = value();
      const n = parseCount(v);
      if (n === undefined) {
        throw new UsageError(`--limit must be a non-negative integer, got ${JSON.stringify(v)}`);
      }
      limit = n;
    } else {
      throw new UsageError(`unknown argument ${JSON.stringify(a)}`);
    }
  }
  const poolList = pool === "all" ? pools : [pool];
  if (!poolList.every((p) => pools.includes(p))) {
    throw new UsageError(`invalid --pool ${pool}; choices: ${pools.join(", ")}, all`);
  }
  return { poolList, only: only.length ? new Set(only) : null, limit };
}

export async function runCli(
  bench: string,
  pools: string[],
  iterTasks: (pool: string) => TaskIterable,
  argv: string[] = [],
  dataRoot: string = DATA,
): Promise<number> {
  const { poolList, only, limit } = parseCliArgs(argv, pools);
  for (const pool of poolList) {
    const metaFile = join(dataRoot, bench, pool, "meta.json");
    const merged: Record<string, unknown> = exists(metaFile)
      ? readJsonStrict<Record<string, unknown>>(metaFile)
      : {};
    let done = 0;
    // Tasks are pulled one at a time, so --limit and --only stop the adapter's work early and a
    // failure on a later task cannot undo the earlier ones.
    if (limit !== 0) {
      for await (const task of iterTasks(pool)) {
        if (only && !only.has(task.key)) continue;
        const marker = join(dataRoot, bench, pool, ".done", task.key);
        // A marker alone is not "done": the label -> seed map and the scores live in meta.json.
        if (exists(marker) && task.key in merged) {
          done += 1;
        } else if (Object.keys(task.rollouts).length >= 2) {
          merged[task.key] = await writeTask(bench, pool, task, dataRoot);
          // Persist the meta BEFORE the marker, so a crash can never leave a task marked done
          // whose scores were never saved.
          writeJsonAtomic(metaFile, merged);
          ensureDir(dirname(marker));
          writeFileSync(marker, "", "utf8");
          done += 1;
          console.log(
            `[${bench}/${pool}] ${done}: ${task.key} (${Object.keys(task.rollouts).length} rollouts)`,
          );
        }
        if (limit !== undefined && done >= limit) break;
      }
    }
    writeJsonAtomic(metaFile, merged);
    console.log(`[${bench}/${pool}] total ${done}; meta: ${metaFile}`);
  }
  return 0;
}

/** Lazy bench root (do not read at module load). */
export function srcRoot(): string {
  return benchRoot();
}
