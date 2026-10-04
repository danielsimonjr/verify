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
import { basename, join } from "node:path";

import { exists, isDir, posixRel, readJson, readText, walkFiles } from "../fsutil.js";
import { Rollout, Task, srcRoot } from "./base.js";
import { renderOpencodeEvents } from "./renderers.js";

const JUDGE = "gemini-3-flash-preview";

export const POOLS: Record<string, string[]> = {
  flash: [...Array.from({ length: 10 }, (_, s) => `gemini-3-5-flash-s${String(s + 1).padStart(2, "0")}`), "gemini-3-5-flash-lo30"],
  opus: Array.from({ length: 10 }, (_, s) => `opus48-s${String(s + 1).padStart(2, "0")}`),
};

function jbPaths() {
  const root = join(srcRoot(), "benchmarks/jobbench");
  return {
    ds: join(root, "job-bench-eval/dataset/main"),
    judgeRoot: join(root, "results/judge/main"),
    trajRoot: join(root, "results/traj/main"),
    outputRoot: join(root, "results/output/main"),
  };
}

function pickTraj(tdir: string): string | null {
  if (!isDir(tdir)) return null;
  const jl = readdirSync(tdir)
    .filter((n) => n.endsWith(".jsonl"))
    .sort();
  if (!jl.length) return null;
  if (jl.length === 1) return join(tdir, jl[0]!);
  const tsv = join(tdir, "attempt_index.tsv");
  if (exists(tsv)) {
    const rows = readText(tsv)
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.split("\t"));
    let best: string | null = null;
    for (const r of rows) {
      if (r.length >= 11 && r[4] === "success") {
        const cand = join(tdir, basename(r[10]!));
        if (exists(cand)) best = cand;
      }
    }
    if (best) return best;
  }
  return join(tdir, jl[jl.length - 1]!);
}

function renderTraj(f: string): () => string {
  return () => renderOpencodeEvents(readText(f).split(/\r?\n/));
}

export function* iterTasks(pool: string): Generator<Task> {
  const labels = POOLS[pool]!;
  const { ds, judgeRoot, trajRoot, outputRoot } = jbPaths();
  const instrFiles = walkFiles(ds, { followLinks: false })
    .filter((p) => p.endsWith("/task_folder/TASK_INSTRUCTIONS.txt"))
    .sort();
  for (const instr of instrFiles) {
    const td = join(instr, "..", "..");
    const prof = basename(join(td, ".."));
    const tn = basename(td);
    const task = new Task(`${prof}__${tn}`, readText(instr));
    task.trees.push([join(td, "task_folder"), "task_folder"]);
    const frs = join(td, "files_required_to_search");
    if (isDir(frs)) task.trees.push([frs, "files_required_to_search"]);
    for (const lbl of labels) {
      const jf = join(judgeRoot, prof, tn, "eval_result", `eval_${lbl}`, `${JUDGE}_judge.json`);
      if (!exists(jf)) continue;
      const jd = readJson(jf) as Record<string, unknown> | null;
      if (!jd) continue;
      const ms = Number(jd.max_score ?? 0);
      const score = ms ? Number(jd.total_score ?? 0) / ms : 0;
      const mo = join(outputRoot, prof, tn, "model_output", lbl);
      const files = isDir(mo)
        ? walkFiles(mo, { followLinks: false })
            .sort()
            .map((p) => [p, posixRel(mo, p)] as [string, string])
        : [];
      const tf = pickTraj(join(trajRoot, prof, tn, "model_traj", lbl));
      const r = new Rollout(lbl, score);
      r.files = files;
      if (tf) r.traj = renderTraj(tf);
      task.rollouts[lbl] = r;
    }
    yield task;
  }
}
