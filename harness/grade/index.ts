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

/** Re-grading of NEW deliverables through each benchmark's own grader. */

import { BENCHES, type Bench } from "../config.js";

export type GradeResult = {
  score: number | null;
  error?: string | null;
  detail?: unknown;
  grader?: string;
  rubrics?: unknown;
  judge_errors?: number;
  [key: string]: unknown;
};

export type GradeModule = {
  grade: (key: string, deliverables: string, ...args: unknown[]) => GradeResult | Promise<GradeResult>;
  preflight?: () => string | Promise<string>;
  gradeBatch?: (
    items: [string, string, string | null][],
    ...args: unknown[]
  ) => Record<string, GradeResult> | Promise<Record<string, GradeResult>>;
};

export async function loadGradeModule(bench: string): Promise<GradeModule> {
  if (!BENCHES.includes(bench as Bench)) {
    throw new Error(`unknown bench ${JSON.stringify(bench)}`);
  }
  return (await import(`./${bench}.js`)) as GradeModule;
}

export async function gradeDeliverables(
  bench: string,
  key: string,
  deliverables: string,
  kw: Record<string, unknown> = {},
): Promise<GradeResult> {
  const mod = await loadGradeModule(bench);
  const ret = mod.grade(key, deliverables, kw);
  return ret instanceof Promise ? await ret : ret;
}

export async function preflight(bench: string): Promise<string> {
  const mod = await loadGradeModule(bench);
  if (!mod.preflight) return "";
  const r = mod.preflight();
  return r instanceof Promise ? await r : r;
}
