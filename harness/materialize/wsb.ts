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

import { exists, isDir, posixRel, readJson, walkFiles } from "../fsutil.js";
import { Rollout, Task, srcRoot } from "./base.js";
import { renderWsbTraj } from "./renderers.js";

export const POOLS: Record<string, string> = {
  flash: "Gemini-3.5-Flash",
  opus: "Opus-4-8",
};

type TaskMeta = { task: string; output_files: string[]; n_rubrics: number };

let metaCache: Record<string, TaskMeta> | null = null;

function wsbRoot(): string {
  return join(srcRoot(), "benchmarks/wsb_lite/official/evaluation");
}

function taskMeta(): Record<string, TaskMeta> {
  if (metaCache) return metaCache;
  const out: Record<string, TaskMeta> = {};
  const tasksDir = join(wsbRoot(), "tasks");
  for (const t of readdirSync(tasksDir).sort()) {
    const f = join(tasksDir, t, "metadata.json");
    if (!exists(f)) continue;
    const m = readJson(f) as { task?: string; output_files?: string[]; rubrics?: unknown[] };
    out[t] = {
      task: m.task ?? "",
      output_files: (m.output_files ?? []).map(String),
      n_rubrics: (m.rubrics ?? []).length,
    };
  }
  metaCache = out;
  return out;
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
  const tasks: Record<string, Task> = {};
  for (const run of runs) {
    const seed = run.split("--").pop()!;
    for (const ent of readdirSync(run, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const td = join(run, ent.name);
      const meta = metas[ent.name];
      const jf = join(td, "rubrics_judge--claude-opus-4-8.json");
      if (!meta || !meta.n_rubrics || !exists(jf)) continue;
      const judged = readJson(jf) as {
        rubrics?: { index?: unknown; passed?: boolean; evidence?: string }[];
        judge?: { error?: unknown };
      };
      const rubrics = judged.rubrics ?? [];
      const ok: Record<number, boolean> = {};
      for (const x of rubrics) {
        try {
          ok[Number(x.index)] = Boolean(x.passed);
        } catch {
          /* skip */
        }
      }
      const failed =
        Boolean(judged.judge?.error) ||
        (rubrics.length > 0 &&
          rubrics.every((x) => String(x.evidence ?? "").startsWith("ClaudeCode judge failed")));
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
