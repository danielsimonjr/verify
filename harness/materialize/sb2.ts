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

import { exists, isDir, readJson } from "../fsutil.js";
import { Rollout, Task, srcRoot } from "./base.js";
import { renderSb2Traj } from "./renderers.js";

export const POOLS: Record<string, string> = { flash: "flash_high", opus: "opus_high" };

function sb2Root(): string {
  return join(srcRoot(), "benchmarks/sb2");
}

function specs(): Record<string, [string, string]> {
  const out: Record<string, [string, string]> = {};
  const official = join(sb2Root(), "official/data");
  for (const cat of readdirSync(official).sort()) {
    const ds = join(official, cat, "dataset.json");
    if (!exists(ds)) continue;
    const recs = readJson(ds) as { id: string; instruction?: string; spreadsheet_path: string }[];
    for (const rec of recs ?? []) {
      const key = `${cat}__${rec.id}`;
      out[key] = [rec.instruction ?? "", join(official, cat, rec.spreadsheet_path)];
    }
  }
  return out;
}

export function* iterTasks(pool: string): Generator<Task> {
  const prefix = POOLS[pool]!;
  const sb2 = sb2Root();
  const grades = readJson(join(sb2, "grades/grades.json")) as Record<
    string,
    Record<string, { accuracy?: number }>
  >;
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
    if (seeds.length < 2 || !(key in specMap)) continue;
    const [instruction, inputFile] = specMap[key]!;
    const tid = key.split("__", 2)[1]!;
    const task = new Task(key, instruction);
    if (exists(inputFile)) task.workspace.push([inputFile, inputFile.split("/").pop()!]);
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
      const r = new Rollout(seed, acc !== undefined && acc !== null ? Number(acc) : null);
      r.files = files;
      if (exists(tf)) r.traj = () => renderSb2Traj(tf);
      task.rollouts[seed] = r;
    }
    yield task;
  }
}
