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
import { mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { benchRoot, TMP_DIR } from "../config.js";
import { copyTree, exists, isDir, isFile, partition, readJson, readText, rmrf } from "../fsutil.js";
import { python3 } from "../runtime.js";
import { isView } from "../views.js";
import type { GradeResult } from "./index.js";

const JB = join(benchRoot(), "benchmarks", "jobbench", "job-bench-eval");
const JUDGE = join(JB, "eval", "judge.py");
const DS = join(JB, "dataset", "main");

const ENV = {
  JUDGE_MODEL: process.env.JB_JUDGE_MODEL ?? "gemini-3-flash-preview",
  JUDGE_API_BASE: process.env.JB_JUDGE_API_BASE ?? "http://127.0.0.1:4000/v1",
  JUDGE_API_KEY: process.env.JB_JUDGE_API_KEY ?? "",
};

function findRubrics(prof: string, tn: string): string | null {
  const direct = join(DS, prof, tn, "task_folder", "RUBRICS.json");
  if (exists(direct)) return direct;
  const root = join(DS, prof, tn);
  if (!isDir(root)) return null;
  const walk = (dir: string): string | null => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === "RUBRICS.json" && isFile(p)) return p;
      if (isDir(p)) {
        const hit = walk(p);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(root);
}

/** Rubrics file of a `<profession>__<task>` key; the task name may itself contain "__". */
export function rubricsFor(key: string): string | null {
  const [prof, tn] = partition(key, "__");
  return prof && tn ? findRubrics(prof, tn) : null;
}

export async function preflight(): Promise<string> {
  const body = JSON.stringify({
    model: ENV.JUDGE_MODEL,
    max_tokens: 1,
    messages: [{ role: "user", content: "ok" }],
  });
  try {
    const r = await fetch(`${ENV.JUDGE_API_BASE.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ENV.JUDGE_API_KEY}`,
      },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    // A JSON error body (401, 404, 500, ...) parses fine, so check the status first: scoring
    // against a judge that rejects every request would produce misleading zeros.
    if (!r.ok) {
      const detail = (await r.text().catch(() => "")).slice(0, 200);
      return `jb judge ${ENV.JUDGE_MODEL} at ${ENV.JUDGE_API_BASE} returned HTTP ${r.status}: ${detail}`;
    }
    await r.json();
    return "";
  } catch (e) {
    const err = e as Error;
    return (
      `jb judge ${ENV.JUDGE_MODEL} unreachable at ${ENV.JUDGE_API_BASE}: ${err.name}: ` +
      `${String(err.message).slice(0, 200)}`
    );
  }
}

export function grade(
  key: string,
  deliverables: string,
  opts: { workers?: number } = {},
): GradeResult {
  const workers = opts.workers ?? 6;
  let res = gradeOnce(key, deliverables, workers);
  if (res.judge_errors) res = gradeOnce(key, deliverables, workers);
  if (res.judge_errors) {
    return {
      ...res,
      score: null,
      error: `judge failed on ${res.judge_errors} rubric(s)`,
    };
  }
  return res;
}

function gradeOnce(key: string, deliverables: string, workers: number): GradeResult {
  const rub = rubricsFor(key);
  if (!rub) {
    return { score: null, error: `no RUBRICS.json for ${key}`, grader: "jb/judge.py" };
  }
  const td = mkdtempSync(join(TMP_DIR, "vh_jb_"));
  try {
    const details = join(td, "details.json");
    const staged = join(td, "output");
    copyTree(deliverables, staged, (rel) => {
      const base = rel.split("/").pop() ?? rel;
      return !isView(base);
    });
    const cmd = [
      python3(),
      JUDGE,
      "--output-dir",
      staged,
      "--rubrics-file",
      rub,
      "--details-file",
      details,
      "--judge-model",
      ENV.JUDGE_MODEL,
      "--api-base",
      ENV.JUDGE_API_BASE,
      "--api-key",
      ENV.JUDGE_API_KEY,
      "--max-workers",
      String(workers),
      "--evaluated-model",
      "veriharness",
    ];
    const p = spawnSync(cmd[0], cmd.slice(1), {
      encoding: "utf8",
      timeout: 1_800_000,
      cwd: JB,
      env: { ...process.env, ...ENV },
    });
    if (!exists(details)) {
      return {
        score: null,
        error: ((p.stderr || "") + (p.stdout || "")).slice(-800),
        grader: "jb/judge.py",
      };
    }
    const d = readJson<Record<string, unknown>>(details)!;
    const ms = (d.max_score as number) || 0;
    const rubrics = (d.rubrics as Record<string, unknown>[]) || [];
    const errors =
      Number(d.judge_error_count) ||
      rubrics.filter(
        (r) =>
          r.judge_error ||
          (r.result as Record<string, unknown> | undefined)?.judge_error,
      ).length;
    const detail: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d)) {
      if (k !== "rubrics") detail[k] = v;
    }
    return {
      score: ms ? Number(d.total_score || 0) / ms : null,
      error: ms ? null : "no rubric was scored",
      judge_errors: errors,
      detail,
      rubrics,
      grader: "jb/judge.py",
    };
  } finally {
    rmrf(td);
  }
}
