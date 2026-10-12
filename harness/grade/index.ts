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

import { basename, dirname } from "node:path";

import { BENCHES, type Bench } from "../config.js";
import { assertNoLinkBelow, SymlinkError } from "../fsutil.js";

/**
 * The result of one grading: `score` is a number, or null when the grader could not score.
 * `error` says why a grade failed; the other fields carry grader output.
 */
export type GradeResult = {
  score: number | null;
  error?: string | null;
  detail?: unknown;
  grader?: string;
  rubrics?: unknown;
  judge_errors?: number;
  [key: string]: unknown;
};

/**
 * The shape of a per-benchmark grader module. `grade` is required; `preflight` and
 * `gradeBatch` are optional.
 */
export type GradeModule = {
  grade: (key: string, deliverables: string, ...args: unknown[]) => GradeResult | Promise<GradeResult>;
  preflight?: () => string | Promise<string>;
  gradeBatch?: (
    items: [string, string, string | null][],
    ...args: unknown[]
  ) => Record<string, GradeResult> | Promise<Record<string, GradeResult>>;
};

/** Import the grader module of the benchmark `bench`. Throws when `bench` is not in `BENCHES`. */
export async function loadGradeModule(bench: string): Promise<GradeModule> {
  if (!BENCHES.includes(bench as Bench)) {
    throw new Error(`unknown bench ${JSON.stringify(bench)}`);
  }
  return (await import(`./${bench}.js`)) as GradeModule;
}

/**
 * Grade one deliverables folder with the grader of `bench`. A symbolic link at or below the
 * folder returns a null score with an error before the grader loads. `kw` passes to the grader.
 */
export async function gradeDeliverables(
  bench: string,
  key: string,
  deliverables: string,
  kw: Record<string, unknown> = {},
): Promise<GradeResult> {
  // A link at or under the bundle resolves on the host when a grader reads it. Refused here for
  // every bench, before its grader loads. The directories above the bundle belong to the caller:
  // score checks them from the task workspace.
  try {
    assertNoLinkBelow(dirname(deliverables), basename(deliverables));
  } catch (e) {
    if (e instanceof SymlinkError) return { score: null, error: e.message };
    throw e;
  }
  const mod = await loadGradeModule(bench);
  const ret = mod.grade(key, deliverables, kw);
  return ret instanceof Promise ? await ret : ret;
}

/** Run the `preflight` check of the grader of `bench`. Returns "" when the grader is ready or has no check, else the problem text. */
export async function preflight(bench: string): Promise<string> {
  const mod = await loadGradeModule(bench);
  if (!mod.preflight) return "";
  const r = mod.preflight();
  return r instanceof Promise ? await r : r;
}
