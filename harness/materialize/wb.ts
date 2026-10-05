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
import { exists, isDir, posixRel, readText, walkFiles } from "../fsutil.js";
import { Rollout, Task, readJsonStrict, srcRoot } from "./base.js";
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
  // A trajectory that cannot be read is an error: rendering it as empty would hand the verifier no evidence.
  return () => renderAtifSteps(readJsonStrict(tf), wbToolResults(runDir));
}

/** The archived reward as a number; a value that is not one is an error, not a NaN score. */
function rewardOf(reward: unknown, where: string): number {
  const n = typeof reward === "number" || (typeof reward === "string" && reward.trim() !== "") ? Number(reward) : NaN;
  if (!Number.isFinite(n)) throw new Error(`reward ${JSON.stringify(reward)} of ${where} is not a number`);
  return n;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function* iterTasks(pool: string): Generator<Task> {
  const index = readJsonStrict<Record<string, Record<string, Record<string, { dir?: string; reward?: unknown } | null>>>>(
    wbIndex(),
  );
  const datasets = join(srcRoot(), "benchmarks/workbuddy/workbuddy-bench/datasets");
  const repos = join(DATA, "_worlds", "wb");
  for (const dom of DOMAINS) {
    const poolKey = `${POOLS[pool]}/${dom}`;
    const entries = Object.hasOwn(index, poolKey) ? index[poolKey]! : {};
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
      // Code-unit order, as Python's sorted(): localeCompare would renumber the rollouts per locale.
      for (const [sd, info] of Object.entries(seeds).sort(([a], [b]) => byCodeUnit(a, b))) {
        if (info?.reward === undefined || info.reward === null) continue;
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
            .map((p) => [p, `artifacts/${posixRel(ra, p)}`] as [string, string]);
        }
        const r = new Rollout(sd, rewardOf(info.reward, `${tname} / ${sd} in ${wbIndex()}`));
        r.texts = texts;
        r.files = files;
        if (exists(tf)) r.traj = traj(tf, d);
        task.rollouts[sd] = r;
      }
      yield task;
    }
  }
}
