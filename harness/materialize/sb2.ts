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

import { exists, isDir } from "../fsutil.js";
import { Rollout, Task, readJsonStrict, srcRoot } from "./base.js";
import { renderSb2Traj } from "./renderers.js";

export const POOLS: Record<string, string> = { flash: "flash_high", opus: "opus_high" };

function sb2Root(): string {
  return join(srcRoot(), "benchmarks/sb2");
}

type Spec = { instruction: string; inputFile: string; tid: string };

/**
 * key -> spec. The task id is taken from the dataset record, not cut out of the key: an id may
 * itself contain "__", and the Python split at the FIRST separator only.
 */
function specs(): Map<string, Spec> {
  const out = new Map<string, Spec>();
  const official = join(sb2Root(), "official/data");
  for (const cat of readdirSync(official).sort()) {
    const ds = join(official, cat, "dataset.json");
    if (!exists(ds)) continue;
    const recs = readJsonStrict<{ id?: unknown; instruction?: unknown; spreadsheet_path?: unknown }[]>(ds);
    if (!Array.isArray(recs)) throw new Error(`${ds} is not a list of task records`);
    for (const rec of recs) {
      if (typeof rec?.id !== "string" || typeof rec.spreadsheet_path !== "string") {
        throw new Error(`${ds} has a record without a string id and spreadsheet_path`);
      }
      out.set(`${cat}__${rec.id}`, {
        instruction: typeof rec.instruction === "string" ? rec.instruction : "",
        inputFile: join(official, cat, rec.spreadsheet_path),
        tid: rec.id,
      });
    }
  }
  return out;
}

export function* iterTasks(pool: string): Generator<Task> {
  const prefix = POOLS[pool]!;
  const sb2 = sb2Root();
  const grades = readJsonStrict<Record<string, Record<string, { accuracy?: unknown }>>>(
    join(sb2, "grades/grades.json"),
  );
  const specMap = specs();
  const poolsDir = join(sb2, "pools");
  const seedsAll = new Set(
    readdirSync(poolsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && new RegExp(`^${prefix}_s\\d\\d$`).test(d.name))
      .map((d) => d.name),
  );

  for (const key of Object.keys(grades).sort()) {
    const seeds = Object.keys(grades[key] ?? {})
      .filter((s) => s.startsWith(prefix) && seedsAll.has(s))
      .sort();
    const spec = specMap.get(key);
    if (seeds.length < 2 || !spec) continue;
    const { instruction, inputFile, tid } = spec;
    const task = new Task(key, instruction);
    if (exists(inputFile)) task.workspace.push([inputFile, basename(inputFile)]);
    for (const seed of seeds) {
      const d = join(poolsDir, seed, key);
      const files =
        isDir(d)
          ? readdirSync(d)
              .filter((n) => n.startsWith(`${tid}_output.`))
              .sort()
              .map((n) => [join(d, n), n] as [string, string])
          : [];
      const tf = join(d, "traj", `${tid}.traj`);
      const acc = grades[key]![seed]?.accuracy;
      let score: number | null = null;
      if (acc !== undefined && acc !== null) {
        score = Number(acc);
        if (!Number.isFinite(score)) {
          throw new Error(`accuracy ${JSON.stringify(acc)} of ${key} / ${seed} is not a number`);
        }
      }
      const r = new Rollout(seed, score);
      r.files = files;
      if (exists(tf)) r.traj = () => renderSb2Traj(tf);
      task.rollouts[seed] = r;
    }
    yield task;
  }
}
