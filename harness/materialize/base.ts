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
import { dirname, join, resolve } from "node:path";

import { DATA, benchRoot } from "../config.js";
import {
  ensureDir,
  exists,
  posixRel,
  readText,
  rmrf,
  symlinkDir,
  walkFiles,
  writeJson,
  writeText,
} from "../fsutil.js";
import { renderViews } from "../views.js";

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
  if (isLeakBlocked(src.split("/").pop() ?? src)) {
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
    const base = p.split("/").pop() ?? p;
    if (isLeakBlocked(base)) continue;
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
): Promise<Record<string, unknown>> {
  const ws = join(DATA, bench, pool, "tasks", task.key);
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

async function collectTasks(it: TaskIterable): Promise<Task[]> {
  const out: Task[] = [];
  if (it && typeof (it as AsyncIterable<Task>)[Symbol.asyncIterator] === "function") {
    for await (const t of it as AsyncIterable<Task>) out.push(t);
  } else {
    for (const t of it as Iterable<Task>) out.push(t);
  }
  return out;
}

function parseCliArgs(argv: string[], pools: string[]) {
  let pool = "all";
  const only: string[] = [];
  let limit: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pool" && argv[i + 1]) {
      pool = argv[++i]!;
    } else if (a === "--only" && argv[i + 1]) {
      only.push(argv[++i]!);
    } else if (a === "--limit" && argv[i + 1]) {
      limit = parseInt(argv[++i]!, 10);
    }
  }
  const poolList = pool === "all" ? pools : [pool];
  if (!poolList.every((p) => pools.includes(p))) {
    throw new Error(`invalid --pool ${pool}; choices: ${pools.join(", ")}, all`);
  }
  return { poolList, only: only.length ? new Set(only) : null, limit };
}

export async function runCli(
  bench: string,
  pools: string[],
  iterTasks: (pool: string) => TaskIterable,
  argv: string[] = [],
): Promise<number> {
  const { poolList, only, limit } = parseCliArgs(argv, pools);
  for (const pool of poolList) {
    const metaFile = join(DATA, bench, pool, "meta.json");
    const merged: Record<string, unknown> = exists(metaFile)
      ? (JSON.parse(readText(metaFile)) as Record<string, unknown>)
      : {};
    let done = 0;
    const tasks = await collectTasks(iterTasks(pool));
    for (const task of tasks) {
      if (only && !only.has(task.key)) continue;
      if (limit !== undefined && done >= limit) break;
      const marker = join(DATA, bench, pool, ".done", task.key);
      if (exists(marker)) {
        done += 1;
        continue;
      }
      if (Object.keys(task.rollouts).length < 2) continue;
      merged[task.key] = await writeTask(bench, pool, task);
      ensureDir(dirname(marker));
      writeFileSync(marker, "", "utf8");
      done += 1;
      console.log(
        `[${bench}/${pool}] ${done}: ${task.key} (${Object.keys(task.rollouts).length} rollouts)`,
      );
    }
    ensureDir(dirname(metaFile));
    writeJson(metaFile, merged);
    console.log(`[${bench}/${pool}] total ${done}; meta: ${metaFile}`);
  }
  return 0;
}

/** Lazy bench root (do not read at module load). */
export function srcRoot(): string {
  return benchRoot();
}
