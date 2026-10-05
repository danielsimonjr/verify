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

import { chmodSync, copyFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { HARNESS_DIR, benchRoot, TMP_DIR } from "../config.js";
import { exists, rmrf } from "../fsutil.js";
import { readJsonStrict } from "../materialize/base.js";
import { python3 } from "../runtime.js";
import type { GradeResult } from "./index.js";
import { describeFailure, failureReason, run } from "./proc.js";

// Resolved when asked, not at import: benchRoot() throws when the bench root is unset, and an
// import that throws cannot be reported by preflight.
const sb2Dir = (): string => join(benchRoot(), "benchmarks", "sb2", "official");
const dataDir = (): string => join(sb2Dir(), "data");
const image = (): string => process.env.VERIHARNESS_IMAGE_SB2_GRADER ?? "veriharness-sb2";
const DET_CATS = ["Debugging", "Template", "Financial_Model"] as const;
const GRADER = "sb2/evaluation.py+recalc";
const COMPARE_PY = join(HARNESS_DIR, "grade", "sb2_compare.py");

const uid = (): number => process.getuid?.() ?? 0;
const gid = (): number => process.getgid?.() ?? 0;

export type Sb2Options = {
  /** The docker command (default `["docker"]`). For tests. */
  dockerCmd?: string[];
  /** The whole command that runs the cell comparison (default `[python3, sb2_compare.py]`). For tests. */
  compareCmd?: string[];
  /** Milliseconds allowed for the LibreOffice recalculation (default 15 minutes). */
  recalcTimeoutMs?: number;
  /** Milliseconds allowed for one cell comparison (default 10 minutes). */
  compareTimeoutMs?: number;
};

type Dataset = Map<string, Record<string, unknown>>;
const datasets = new Map<string, Dataset>();

function dataset(cat: string): Dataset {
  const file = join(dataDir(), cat, "dataset.json");
  let ds = datasets.get(file);
  if (!ds) {
    // Strict: a missing dataset.json is an error, not "every task id is unknown".
    const rows = readJsonStrict<Record<string, unknown>[]>(file);
    if (!Array.isArray(rows)) throw new Error(`${file} is not a list of task records`);
    ds = new Map(rows.map((d) => [String(d.id), d]));
    datasets.set(file, ds);
  }
  return ds;
}

/** `<category>__<task id>`, split at the FIRST "__": an id may itself contain "__". */
function splitKey(key: string): [string, string] | null {
  const i = key.indexOf("__");
  return i < 0 ? null : [key.slice(0, i), key.slice(i + 2)];
}

let python: string | undefined;
const interpreter = (): string => (python ??= python3()); // python3() spawns a process each call

let containerSeq = 0;

/**
 * The official recalculation (LibreOffice through UNO, iterative calculation on, saved back as xlsx),
 * run inside the benchmark image on a staging directory mounted separately, so nothing is written into
 * the benchmark tree. The script processes every *output.xlsx under the directory.
 */
async function recalc(stage: string, o: Sb2Options): Promise<void> {
  const [docker, ...dockerArgs] = o.dockerCmd ?? ["docker"];
  const name = `vh-sb2-${process.pid}-${containerSeq++}-${Date.now().toString(36)}`;
  const args = [
    ...dockerArgs,
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    "none",
    "-u",
    `${uid()}:${gid()}`,
    "-e",
    "HOME=/tmp",
    "-v",
    `${sb2Dir()}:/sb2:ro`,
    "-v",
    `${stage}:/stage`,
    image(),
    "python3",
    "/sb2/evaluation/open_spreadsheet.py",
    "--dir_path",
    "/stage",
  ];
  const r = await run(docker!, args, {
    timeoutMs: o.recalcTimeoutMs ?? 900_000,
    // Killing the docker CLI does not stop the container: the daemon owns it. Stop it by name.
    onTimeout: () => run(docker!, [...dockerArgs, "kill", name], { timeoutMs: 30_000 }),
  });
  const out = r.stdout + r.stderr;
  const bad = [
    "Error [",
    "Initialization failed",
    "Batch processing error",
    "Cannot start LibreOffice",
  ].filter((m) => out.includes(m));
  if (r.error || r.timedOut || r.truncated || r.status !== 0 || bad.length || !out.includes("LibreOffice service started")) {
    throw new Error(`recalc failed (${failureReason(r)}, ${JSON.stringify(bad)}): ${out.slice(-600)}`);
  }
}

async function gradeDet(
  data: Record<string, unknown>,
  cat: string,
  outputsDir: string,
  o: Sb2Options,
): Promise<GradeResult> {
  const payload = JSON.stringify({ data, cat, outputs_dir: outputsDir });
  const cmd = o.compareCmd ?? [interpreter(), COMPARE_PY];
  const r = await run(cmd[0]!, cmd.slice(1), {
    input: payload,
    timeoutMs: o.compareTimeoutMs ?? 600_000,
    // The payload and the output are UTF-8; Python on Windows would read stdin in the console code page.
    env: { ...process.env, PYTHONUTF8: "1" },
  });
  if (r.error || r.timedOut || r.truncated || r.status !== 0) {
    return { score: null, error: describeFailure(r, "sb2_compare.py", 400), grader: GRADER };
  }
  let res: unknown;
  try {
    res = JSON.parse(r.stdout);
  } catch {
    const tail = r.stdout.trim().slice(-400);
    return { score: null, error: `sb2_compare.py returned invalid JSON: ${tail || "(nothing printed)"}`, grader: GRADER };
  }
  const score = (res as { score?: unknown } | null)?.score;
  if (typeof res !== "object" || res === null || !(score === null || typeof score === "number")) {
    return { score: null, error: "sb2_compare.py returned a result without a score", grader: GRADER };
  }
  return res as GradeResult;
}

export async function grade(key: string, deliverables: string, opts: Sb2Options = {}): Promise<GradeResult> {
  const parts = splitKey(key);
  if (!parts) {
    return { score: null, error: `bad sb2 key ${JSON.stringify(key)}: expected <category>__<task id>`, grader: GRADER };
  }
  const [cat, tid] = parts;
  if (!DET_CATS.includes(cat as (typeof DET_CATS)[number])) {
    return {
      score: null,
      error: `category ${cat} not wrapped (needs VLM checklist path)`,
      grader: GRADER,
    };
  }
  const data = dataset(cat).get(tid);
  if (!data) return { score: null, error: `unknown task id ${tid}`, grader: GRADER };
  const src = join(deliverables, `${tid}_output.xlsx`);
  if (!exists(src)) {
    return { score: 0.0, error: `no ${tid}_output.xlsx in deliverables`, grader: GRADER };
  }
  const td = mkdtempSync(join(TMP_DIR, "vh_sb2_"));
  try {
    const stage = join(td, "outputs");
    mkdirSync(stage);
    copyFileSync(src, join(stage, `${tid}_output.xlsx`));
    chmodSync(stage, 0o777);
    chmodSync(join(stage, `${tid}_output.xlsx`), 0o666);
    await recalc(stage, opts);
    return await gradeDet(data, cat, stage, opts);
  } finally {
    rmrf(td);
  }
}

/**
 * Grade several (key, deliverables, _) with ONE recalc container: every workbook is staged under one
 * directory (file names are <tid>_output.xlsx, unique per task, so keys must be distinct within a batch),
 * LibreOffice recalculates them all in one pass, then the official comparison runs per task. Asynchronous,
 * so the containers the caller runs at once really do run at once.
 */
export async function gradeBatch(
  items: [string, string, string | null][],
  _workers = 8,
  opts: Sb2Options = {},
): Promise<Record<string, GradeResult>> {
  const out: Record<string, GradeResult> = {};
  const staged: Record<string, [Record<string, unknown>, string]> = {};
  const td = mkdtempSync(join(TMP_DIR, "vh_sb2b_"));
  try {
    const stage = join(td, "outputs");
    mkdirSync(stage);
    chmodSync(stage, 0o777);
    for (const [key, deliverables] of items) {
      const parts = splitKey(key);
      if (!parts) {
        out[key] = { score: null, error: `bad sb2 key ${JSON.stringify(key)}: expected <category>__<task id>`, grader: GRADER };
        continue;
      }
      const [cat, tid] = parts;
      if (!DET_CATS.includes(cat as (typeof DET_CATS)[number])) {
        out[key] = {
          score: null,
          error: `category ${cat} not wrapped (needs VLM checklist path)`,
          grader: GRADER,
        };
        continue;
      }
      const data = dataset(cat).get(tid);
      if (!data) {
        out[key] = { score: null, error: `unknown task id ${tid}`, grader: GRADER };
        continue;
      }
      const src = join(deliverables, `${tid}_output.xlsx`);
      if (!exists(src)) {
        out[key] = {
          score: 0.0,
          error: `no ${tid}_output.xlsx in deliverables`,
          grader: GRADER,
        };
        continue;
      }
      copyFileSync(src, join(stage, `${tid}_output.xlsx`));
      chmodSync(join(stage, `${tid}_output.xlsx`), 0o666);
      staged[key] = [data, cat];
    }
    if (Object.keys(staged).length) {
      try {
        await recalc(stage, opts);
      } catch (e) {
        const msg = String(e).slice(0, 200);
        for (const key of Object.keys(staged)) {
          out[key] = { score: null, error: `recalc failed: ${msg}`, grader: GRADER };
        }
        return out;
      }
      for (const [key, [data, cat]] of Object.entries(staged)) {
        try {
          out[key] = await gradeDet(data, cat, stage, opts);
        } catch (e) {
          const err = e as Error;
          out[key] = {
            score: null,
            error: `${err.name}: ${String(err.message).slice(0, 200)}`,
            grader: GRADER,
          };
        }
      }
    }
    return out;
  } finally {
    rmrf(td);
  }
}
