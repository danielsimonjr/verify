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

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { HARNESS_DIR, benchRoot, TMP_DIR } from "../config.js";
import { exists, readJson, rmrf } from "../fsutil.js";
import { python3 } from "../runtime.js";
import type { GradeResult } from "./index.js";

const SB2 = join(benchRoot(), "benchmarks", "sb2", "official");
const DATA = join(SB2, "data");
const IMAGE = process.env.VERIHARNESS_IMAGE_SB2_GRADER ?? "veriharness-sb2";
const DET_CATS = ["Debugging", "Template", "Financial_Model"] as const;
const GRADER = "sb2/evaluation.py+recalc";
const COMPARE_PY = join(HARNESS_DIR, "grade", "sb2_compare.py");

const uid = (): number => process.getuid?.() ?? 0;
const gid = (): number => process.getgid?.() ?? 0;

const datasets: Record<string, Record<string, Record<string, unknown>>> = {};

function dataset(cat: string): Record<string, Record<string, unknown>> {
  if (!datasets[cat]) {
    const rows = readJson<Record<string, unknown>[]>(join(DATA, cat, "dataset.json")) ?? [];
    datasets[cat] = {};
    for (const d of rows) datasets[cat][String(d.id)] = d;
  }
  return datasets[cat];
}

function recalc(stage: string): void {
  const cmd = [
    "docker",
    "run",
    "--rm",
    "--network",
    "none",
    "-u",
    `${uid()}:${gid()}`,
    "-e",
    "HOME=/tmp",
    "-v",
    `${SB2}:/sb2:ro`,
    "-v",
    `${stage}:/stage`,
    IMAGE,
    "python3",
    "/sb2/evaluation/open_spreadsheet.py",
    "--dir_path",
    "/stage",
  ];
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", timeout: 900_000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const bad = [
    "Error [",
    "Initialization failed",
    "Batch processing error",
    "Cannot start LibreOffice",
  ].filter((m) => out.includes(m));
  if (r.status !== 0 || bad.length || !out.includes("LibreOffice service started")) {
    throw new Error(`recalc failed (rc=${r.status}, ${JSON.stringify(bad)}): ${out.slice(-600)}`);
  }
}

function gradeDet(data: Record<string, unknown>, cat: string, outputsDir: string): GradeResult {
  const payload = JSON.stringify({ data, cat, outputs_dir: outputsDir });
  const r = spawnSync(python3(), [COMPARE_PY], {
    input: payload,
    encoding: "utf8",
    timeout: 600_000,
    env: process.env,
  });
  if (r.status !== 0) {
    return {
      score: null,
      error: ((r.stderr || "") + (r.stdout || "")).slice(-400),
      grader: GRADER,
    };
  }
  try {
    return JSON.parse(r.stdout || "{}") as GradeResult;
  } catch {
    return { score: null, error: "sb2_compare.py returned invalid JSON", grader: GRADER };
  }
}

export function grade(key: string, deliverables: string): GradeResult {
  const [cat, tid] = key.split("__", 2);
  if (!DET_CATS.includes(cat as (typeof DET_CATS)[number])) {
    return {
      score: null,
      error: `category ${cat} not wrapped (needs VLM checklist path)`,
      grader: GRADER,
    };
  }
  const data = dataset(cat)[tid!];
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
    recalc(stage);
    return gradeDet(data, cat, stage);
  } finally {
    rmrf(td);
  }
}

export function gradeBatch(
  items: [string, string, string | null][],
  _workers = 8,
): Record<string, GradeResult> {
  const out: Record<string, GradeResult> = {};
  const staged: Record<string, [Record<string, unknown>, string]> = {};
  const td = mkdtempSync(join(TMP_DIR, "vh_sb2b_"));
  try {
    const stage = join(td, "outputs");
    mkdirSync(stage);
    chmodSync(stage, 0o777);
    for (const [key, deliverables] of items) {
      const [cat, tid] = key.split("__", 2);
      if (!DET_CATS.includes(cat as (typeof DET_CATS)[number])) {
        out[key] = {
          score: null,
          error: `category ${cat} not wrapped (needs VLM checklist path)`,
          grader: GRADER,
        };
        continue;
      }
      const data = dataset(cat)[tid!];
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
        recalc(stage);
      } catch (e) {
        const msg = String(e).slice(0, 200);
        for (const key of Object.keys(staged)) {
          out[key] = { score: null, error: `recalc failed: ${msg}`, grader: GRADER };
        }
        return out;
      }
      for (const [key, [data, cat]] of Object.entries(staged)) {
        try {
          out[key] = gradeDet(data, cat, stage);
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
