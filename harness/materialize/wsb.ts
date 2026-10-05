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

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { exists, isDir, posixRel, walkFiles } from "../fsutil.js";
import { Rollout, Task, readJsonStrict, srcRoot } from "./base.js";
import { renderWsbTraj, truthy } from "./renderers.js";

export const POOLS: Record<string, string> = {
  flash: "Gemini-3.5-Flash",
  opus: "Opus-4-8",
};

type TaskMeta = { task: string; output_files: string[]; n_rubrics: number };

let metaCache: { root: string; metas: Record<string, TaskMeta> } | null = null;

function wsbRoot(): string {
  return join(srcRoot(), "benchmarks/wsb_lite/official/evaluation");
}

/** Task directory names are keys here, so these maps take no inherited property ("constructor"). */
function nameMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function taskMeta(): Record<string, TaskMeta> {
  const root = wsbRoot();
  if (metaCache?.root === root) return metaCache.metas;
  const out = nameMap<TaskMeta>();
  const tasksDir = join(root, "tasks");
  for (const t of readdirSync(tasksDir).sort()) {
    const f = join(tasksDir, t, "metadata.json");
    if (!exists(f)) continue;
    const m = readJsonStrict<{ task?: unknown; output_files?: unknown; rubrics?: unknown } | null>(f);
    out[t] = {
      task: typeof m?.task === "string" ? m.task : "",
      output_files: (Array.isArray(m?.output_files) ? m.output_files : []).map(String),
      n_rubrics: Array.isArray(m?.rubrics) ? m.rubrics.length : 0,
    };
  }
  metaCache = { root, metas: out };
  return out;
}

/**
 * Python's int(x) for a rubric index; undefined where int() raises (None, "abc", "1.5", NaN,
 * containers). `Number(null)` is 0, so a rubric with no index would otherwise count as rubric 0.
 */
function pyInt(v: unknown): number | undefined {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : undefined;
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return Number.parseInt(v, 10);
  return undefined;
}

function spec(meta: TaskMeta): string {
  const out = [meta.task];
  if (meta.output_files.length) {
    out.push(`Required output files: ${meta.output_files.join(", ")}`);
  }
  return out.filter(Boolean).join("\n\n");
}

function rolloutPayload(td: string): [string, string][] {
  const outDir = join(td, "output");
  if (!isDir(outDir)) return [];
  return walkFiles(outDir, { followLinks: false })
    .sort()
    .map((p) => [p, posixRel(outDir, p)] as [string, string]);
}

export function* iterTasks(pool: string): Generator<Task> {
  const model = POOLS[pool]!;
  const metas = taskMeta();
  const outputRoot = join(wsbRoot(), "output");
  const runs = readdirSync(outputRoot, { withFileTypes: true })
    .filter((p) => p.isDirectory() && p.name.startsWith(`ClaudeCode--${model}--s`))
    .map((p) => join(outputRoot, p.name))
    .filter((p) => exists(join(p, ".s_done")))
    .sort();
  const tasks = nameMap<Task>();
  for (const run of runs) {
    const seed = run.split("--").pop()!;
    for (const ent of readdirSync(run, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const td = join(run, ent.name);
      const meta = metas[ent.name];
      const jf = join(td, "rubrics_judge--claude-opus-4-8.json");
      if (!meta || !meta.n_rubrics || !exists(jf)) continue;
      const judged = readJsonStrict<{
        rubrics?: { index?: unknown; passed?: unknown; evidence?: unknown }[];
        judge?: { error?: unknown };
      } | null>(jf);
      const rubrics = Array.isArray(judged?.rubrics) ? judged.rubrics : [];
      const ok: Record<number, boolean> = {};
      for (const x of rubrics) {
        const i = pyInt(x?.index);
        if (i !== undefined) ok[i] = truthy(x.passed);
      }
      const failed =
        truthy(judged?.judge?.error) ||
        (rubrics.length > 0 &&
          rubrics.every((x) => String(x?.evidence ?? "").startsWith("ClaudeCode judge failed")));
      let passed = 0;
      for (let i = 0; i < meta.n_rubrics; i++) {
        if (ok[i]) passed += 1;
      }
      const score = failed ? null : passed / meta.n_rubrics;
      let t = tasks[ent.name];
      if (!t) {
        t = new Task(ent.name, spec(meta));
        tasks[ent.name] = t;
      }
      const dataDir = join(wsbRoot(), "tasks", ent.name, "data");
      if (isDir(dataDir) && !t.trees.length) t.trees.push([dataDir, ""]);
      const files = rolloutPayload(td);
      const af = join(td, "agent.json");
      const r = new Rollout(seed, score);
      r.files = files;
      if (exists(af)) {
        r.traj = () => renderWsbTraj(af);
        r.trajFiles = [[af, "agent.json"]];
      }
      t.rollouts[seed] = r;
    }
  }
  for (const k of Object.keys(tasks).sort()) {
    yield tasks[k]!;
  }
}
