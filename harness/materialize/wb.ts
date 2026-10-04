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

import { join } from "node:path";

import { DATA } from "../config.js";
import { exists, isDir, posixRel, readJson, readText, walkFiles } from "../fsutil.js";
import { Rollout, Task, srcRoot } from "./base.js";
import { renderAtifSteps, wbToolResults } from "./renderers.js";

export const POOLS: Record<string, string> = { flash: "flash", opus: "opus" };

const DS_NAME: Record<string, string> = {
  code: "wb-bench-code-v1.0",
  office: "wb-bench-office-v1.0",
  web: "wb-bench-web-v1.0",
};

const DOMAINS = ["code", "office", "web"] as const;

function wbIndex(): string {
  const env = process.env.VERIHARNESS_WB_INDEX;
  return env && env.length > 0 ? env : join(srcRoot(), "benchmarks/workbuddy/wb_index.json");
}

function patchText(patch: string): () => string {
  return () => readText(patch);
}

function traj(tf: string, runDir: string): () => string {
  return () => renderAtifSteps(readJson(tf), wbToolResults(runDir));
}

export function* iterTasks(pool: string): Generator<Task> {
  const index = readJson(wbIndex()) as Record<string, Record<string, Record<string, { dir?: string; reward?: number }>>>;
  const datasets = join(srcRoot(), "benchmarks/workbuddy/workbuddy-bench/datasets");
  const repos = join(DATA, "_worlds", "wb");
  for (const dom of DOMAINS) {
    const entries = index[`${POOLS[pool]}/${dom}`] ?? {};
    for (const tname of Object.keys(entries).sort()) {
      const seeds = entries[tname]!;
      const taskDir = join(datasets, DS_NAME[dom], "tasks", tname);
      const instr = join(taskDir, "instruction.md");
      const task = new Task(
        `${dom}__${tname}`,
        exists(instr) ? readText(instr) : tname,
      );
      const env = join(taskDir, "environment");
      if (isDir(env)) task.trees.push([env, ""]);
      const repo = join(repos, tname, "repo");
      if (isDir(repo)) task.links.push(["repo", repo]);
      for (const [sd, info] of Object.entries(seeds).sort(([a], [b]) => a.localeCompare(b))) {
        if (info.reward === undefined || info.reward === null) continue;
        const d = info.dir ?? "";
        if (!d || !isDir(d)) continue;
        const patch = join(d, "verifier", "agent.patch");
        const tf = join(d, "agent", "trajectory.json");
        const texts: [string, () => string][] = exists(patch) ? [["agent.patch", patchText(patch)]] : [];
        let files: [string, string][] = [];
        const ra = join(d, "verifier", "raw_artifacts");
        if (isDir(ra)) {
          files = walkFiles(ra, { followLinks: false })
            .sort()
            .map((p) => [p, join("artifacts", posixRel(ra, p))] as [string, string]);
        }
        const r = new Rollout(sd, Number(info.reward));
        r.texts = texts;
        r.files = files;
        if (exists(tf)) r.traj = traj(tf, d);
        task.rollouts[sd] = r;
      }
      yield task;
    }
  }
}
