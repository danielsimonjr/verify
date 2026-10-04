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
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import JSZip from "jszip";

import * as config from "../config.js";
import { benchRoot, DATA, TMP_DIR } from "../config.js";
import {
  exists,
  isFile,
  posixRel,
  readJson,
  readText,
  rmrf,
  walkFiles,
  writeText,
} from "../fsutil.js";
import { python3 } from "../runtime.js";
import { isView } from "../views.js";
import type { GradeResult } from "./index.js";

const GRADING = process.env.APEX_GRADING_DIR
  ? join(process.env.APEX_GRADING_DIR)
  : join(benchRoot(), "benchmarks", "apex", "grading");
const PY = join(GRADING, ".venv", "bin", "python");
const CONFIGS = join(config.HARNESS_DIR, "benchmarks", "apex");
const DOMAIN: Record<string, string> = {
  "Investment Banking": "IB",
  "Management Consulting": "MC",
  Law: "Law",
};
const GRADER = "apex/runner.main";

let keyCounter = 0;
function nextKey(): number {
  return keyCounter++ % 1_000_000;
}

let tasksCache: Record<string, unknown>[] | null = null;

function tasks(): Record<string, unknown>[] {
  if (tasksCache) return tasksCache;
  const script = `
from huggingface_hub import hf_hub_download
from pathlib import Path
import json
try:
  p = hf_hub_download("mercor/apex-agents", "tasks_and_rubrics.json", repo_type="dataset", local_files_only=True)
except Exception:
  p = hf_hub_download("mercor/apex-agents", "tasks_and_rubrics.json", repo_type="dataset")
print(Path(p).read_text())
`;
  const r = spawnSync(python3(), ["-c", script], { encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) throw new Error(`hf_hub_download failed: ${(r.stderr || "").slice(-400)}`);
  tasksCache = JSON.parse(r.stdout || "[]") as Record<string, unknown>[];
  return tasksCache;
}

function apiKeys(): string[] {
  return (process.env.GEMINI_API_KEY ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

function gradingSettings(): string {
  const defaultPath = join(CONFIGS, "grading_settings.json");
  const model = process.env.APEX_JUDGE_MODEL;
  if (!model) return defaultPath;
  const settings = { ...readJson<Record<string, unknown>>(defaultPath), llm_judge_model: model };
  const uid = process.getuid?.() ?? 0;
  const out = join(tmpdir(), `vh_apex_grading_settings_${uid}.json`);
  const tmp = `${out}.${process.pid}`;
  writeText(tmp, JSON.stringify(settings, null, 2));
  renameSync(tmp, out);
  return out;
}

export function preflight(): string {
  if (
    !apiKeys().length &&
    !(process.env.APEX_JUDGE_MODEL ?? "").startsWith("vertex_ai/")
  ) {
    return (
      "the APEX rubric judge needs GEMINI_API_KEY, or APEX_JUDGE_MODEL=vertex_ai/<model> " +
      "with VERTEXAI_PROJECT and VERTEXAI_LOCATION set"
    );
  }
  return exists(PY) ? "" : `APEX grading venv not found: ${PY}`;
}

function worldZip(key: string): string | null {
  try {
    const idx = readJson<{ idx2zip: Record<string, string>; zip_paths: Record<string, string> }>(
      join(DATA, "_worlds", "apex", "index.json"),
    );
    if (!idx) return null;
    const stem = idx.idx2zip[String(parseInt(key.split("_")[0], 10))];
    const path = stem ? idx.zip_paths[stem] : undefined;
    if (path && exists(path)) return path;
  } catch {
    /* missing index */
  }
  return null;
}

function taskFor(key: string): Record<string, unknown> {
  const m = /^(\d{3})_(IB|MC|Law)$/.exec(key);
  if (!m) throw new Error(`bad apex key ${JSON.stringify(key)}`);
  const t = tasks()[parseInt(m[1], 10)]!;
  if (DOMAIN[String(t.domain)] !== m[2]) {
    throw new Error(
      `key ${key} domain mismatch with HF task ${t.task_id} (${t.domain})`,
    );
  }
  return t;
}

function verifiers(t: Record<string, unknown>): Record<string, unknown>[] {
  const rubric = (t.rubric as Record<string, unknown>[]) || [];
  return rubric.map((c, i) => ({
    verifier_id: c.verifier_id,
    verifier_version: 1,
    world_id: t.world_id,
    task_id: t.task_id,
    eval_config_id: "ec_output_llm",
    verifier_values: {
      criteria: c.criteria,
      is_primary_objective: i === 0,
    },
    verifier_index: i,
    verifier_dependencies: null,
  }));
}

async function writeZip(path: string, files: { name: string; data: Buffer }[]): Promise<void> {
  const zip = new JSZip();
  for (const f of files) zip.file(f.name, f.data);
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  writeFileSync(path, buf);
}

export async function grade(
  key: string,
  deliverables: string,
  opts: { timeout?: number } = {},
): Promise<GradeResult> {
  const timeout = opts.timeout ?? 1_800_000;
  const ans = join(deliverables, "answer.md");
  if (!exists(ans)) {
    return { score: 0.0, error: "no answer.md in deliverables", grader: GRADER };
  }
  const answer = readText(ans).replace(/\r\n/g, "\n").trim();
  if (!answer) return { score: 0.0, error: "empty answer.md", grader: GRADER };
  const t = taskFor(key);
  const vlist = verifiers(t);
  if (!vlist.length) {
    return { score: null, error: `task ${t.task_id} has no rubric`, grader: GRADER };
  }
  const td = mkdtempSync(join(TMP_DIR, "vh_apex_grade_"));
  try {
    const traj = join(td, "trajectory.json");
    writeText(
      traj,
      JSON.stringify({
        messages: [
          { role: "user", content: t.prompt },
          { role: "assistant", content: answer },
        ],
        output: null,
        status: "completed",
        time_elapsed: 0.0,
      }),
    );
    let initial = worldZip(key);
    if (!initial || !exists(initial)) {
      initial = join(td, "empty_snapshot.zip");
      await writeZip(initial, []);
    }
    const final = join(td, "final_snapshot.zip");
    const files: { name: string; data: Buffer }[] = [];
    for (const f of walkFiles(deliverables)) {
      const base = f.split("/").pop()!;
      if (base === "answer.md" || isView(base)) continue;
      if (!isFile(f)) continue;
      const rel = posixRel(deliverables, f);
      files.push({ name: `filesystem/${rel}`, data: readFileSync(f) });
    }
    await writeZip(final, files);

    const vf = join(td, "verifiers.json");
    writeText(vf, JSON.stringify(vlist, null, 2));
    const out = join(td, "grades.json");
    const runId = `vh_${key}_${td.split("_").pop()}`;
    const cmd = [
      PY,
      "-m",
      "runner.main",
      "--grading-run-id",
      runId,
      "--trajectory-id",
      runId,
      "--initial-snapshot",
      initial,
      "--final-snapshot",
      final,
      "--trajectory",
      traj,
      "--grading-settings",
      gradingSettings(),
      "--verifiers",
      vf,
      "--eval-configs",
      join(CONFIGS, "eval_configs.json"),
      "--scoring-config",
      join(CONFIGS, "scoring_config.json"),
      "--output",
      out,
    ];
    const keys = apiKeys();
    const env: Record<string, string> = { ...process.env, PYTHONPATH: "." };
    if (keys.length) env.GEMINI_API_KEY = keys[nextKey() % keys.length]!;
    const p = spawnSync(cmd[0], cmd.slice(1), {
      encoding: "utf8",
      timeout,
      cwd: GRADING,
      env,
    });
    if (!exists(out)) {
      return {
        score: null,
        error: ((p.stderr || "") + (p.stdout || "")).slice(-800),
        grader: GRADER,
      };
    }
    const g = readJson<Record<string, unknown>>(out)!;
    const vr = (g.verifier_results as Record<string, unknown>[]) || [];
    const status = g.grading_run_status;
    if (status !== "completed" || vr.length !== vlist.length) {
      const scoring = (g.scoring_results as Record<string, unknown>) || {};
      const smrv = (scoring.scoring_method_result_values as Record<string, unknown>) || {};
      const err = smrv.error || status;
      return {
        score: null,
        error: `grading_run_status=${status}, ${vr.length}/${vlist.length} verifiers: ${err}`.slice(
          0,
          800,
        ),
        grader: GRADER,
        rubrics: vr,
      };
    }
    if (vr.some((v) => v.score == null)) {
      return {
        score: null,
        error: `${vr.filter((v) => v.score == null).length} verifier(s) returned no score`,
        grader: GRADER,
        rubrics: vr,
      };
    }
    const score = vr.reduce((s, v) => s + Number(v.score), 0) / vr.length;
    const scoring = (g.scoring_results as Record<string, unknown>) || {};
    return {
      score,
      detail: {
        task_id: t.task_id,
        n_verifiers: vr.length,
        passed: vr.filter((v) => (Number(v.score) || 0) > 0).length,
        final_score: scoring.final_score,
      },
      rubrics: vr.map((v, i) => ({
        verifier_id: v.verifier_id,
        criteria: (vlist[i]!.verifier_values as Record<string, unknown>).criteria,
        score: v.score,
        status: v.status,
        judge_grade: ((v.verifier_result_values as Record<string, unknown>) || {}).judge_grade,
        rationale: ((v.verifier_result_values as Record<string, unknown>) || {}).grade_rationale,
      })),
      grader: GRADER,
    };
  } finally {
    rmrf(td);
  }
}
