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

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import JSZip from "jszip";

import * as config from "../config.js";
import { benchRoot, DATA, TMP_DIR } from "../config.js";
import { exists, isFile, posixRel, readJson, readText, rmrf, walkFiles, writeFileAtomic, writeText } from "../fsutil.js";
import { defaultTasks, domainCode, type ApexTask } from "../materialize/apex.js";
import { readJsonStrict } from "../materialize/base.js";
import { isView } from "../views.js";
import type { GradeResult } from "./index.js";
import { describeFailure, run } from "./proc.js";

const CONFIGS = join(config.HARNESS_DIR, "benchmarks", "apex");
const GRADER = "apex/runner.main";

/**
 * The benchmark's grading runner checkout. Resolved when asked, not at import: `benchRoot()` throws
 * when the bench root is unset, and `preflight()` must be able to report that instead.
 */
export function gradingDir(): string {
  const env = process.env.APEX_GRADING_DIR;
  // resolve(): the runner starts with this directory as its cwd, so a relative path must not be re-read from there.
  return env ? resolve(env) : join(benchRoot(), "benchmarks", "apex", "grading");
}

const venvPython = (): string => join(gradingDir(), ".venv", "bin", "python");

// Seeded with the pid, as the Python was (itertools.count(os.getpid())): every one-shot
// `veriharness grade` process would otherwise start at key 0 and never reach the others.
let keyCounter = process.pid;
/** The next judge-key index, counting up from the pid. Take it modulo the number of keys. */
export function nextKey(): number {
  return keyCounter++; // not wrapped here: the caller takes it modulo the key count, as Python did
}

async function tasks(): Promise<Record<string, unknown>[]> {
  return (await defaultTasks()) as unknown as Record<string, unknown>[];
}

function apiKeys(): string[] {
  return (process.env.GEMINI_API_KEY ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

/** The benchmark's grading settings, with the judge model swapped for APEX_JUDGE_MODEL when that is set. */
export function gradingSettings(defaultPath = join(CONFIGS, "grading_settings.json")): string {
  const model = process.env.APEX_JUDGE_MODEL;
  if (!model) return defaultPath;
  // Strict: a missing settings file must not become `{llm_judge_model}` alone.
  const settings = { ...readJsonStrict<Record<string, unknown>>(defaultPath), llm_judge_model: model };
  const uid = process.getuid?.() ?? 0;
  const out = join(tmpdir(), `vh_apex_grading_settings_${uid}.json`);
  writeFileAtomic(out, JSON.stringify(settings, null, 2));
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
  try {
    const py = venvPython();
    return exists(py) ? "" : `APEX grading venv not found: ${py}`;
  } catch (e) {
    return (e as Error).message;
  }
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

async function taskFor(key: string): Promise<Record<string, unknown>> {
  const m = /^(\d{3})_(IB|MC|Law)$/.exec(key);
  if (!m) throw new Error(`bad apex key ${JSON.stringify(key)}`);
  const list = await tasks();
  const t = list[parseInt(m[1], 10)];
  if (!t) throw new Error(`key ${key} is outside the ${list.length} APEX tasks`);
  if (domainCode(t as unknown as ApexTask) !== m[2]) {
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
  // No folder entries: the Python wrote only the files, and the runner diffs the archive's entries.
  for (const f of files) zip.file(f.name, f.data, { createFolders: false });
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  writeFileSync(path, buf);
}

export type ApexOptions = {
  /** Runner timeout in milliseconds (default 30 minutes). */
  timeout?: number;
  /** Replaces `<grading venv python> -m runner.main`; the runner's arguments follow it. For tests. */
  command?: string[];
};

export async function grade(
  key: string,
  deliverables: string,
  opts: ApexOptions = {},
): Promise<GradeResult> {
  const timeout = opts.timeout ?? 1_800_000;
  const ans = join(deliverables, "answer.md");
  if (!exists(ans)) {
    return { score: 0.0, error: "no answer.md in deliverables", grader: GRADER };
  }
  const answer = readText(ans).replace(/\r\n/g, "\n").trim();
  if (!answer) return { score: 0.0, error: "empty answer.md", grader: GRADER };
  const t = await taskFor(key);
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
    // Sorted, so the same bundle always makes the same archive. basename(), not split("/"): on a
    // native Windows path the last "/" piece is the whole path, and answer.md would be sent as an artifact.
    for (const f of walkFiles(deliverables).sort()) {
      const base = basename(f);
      if (base === "answer.md" || isView(base)) continue;
      if (!isFile(f)) continue;
      const rel = posixRel(deliverables, f);
      files.push({ name: `filesystem/${rel}`, data: readFileSync(f) });
    }
    await writeZip(final, files);

    const vf = join(td, "verifiers.json");
    writeText(vf, JSON.stringify(vlist, null, 2));
    const out = join(td, "grades.json");
    const runId = `vh_${key}_${basename(td).split("_").pop()}`;
    const runner = opts.command ?? [venvPython(), "-m", "runner.main"];
    const args = [
      ...runner.slice(1),
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
    const env: Record<string, string> = { ...process.env, PYTHONPATH: "." } as Record<string, string>;
    if (keys.length) env.GEMINI_API_KEY = keys[nextKey() % keys.length]!;
    // Asynchronous: grade() runs inside a worker pool, and a blocking spawnSync serialised it.
    const p = await run(runner[0]!, args, { timeoutMs: timeout, cwd: gradingDir(), env });
    // A runner that wrote grades.json and then failed or was signalled has not finished: the file may be partial.
    if (p.timedOut || p.error || p.truncated || p.signal || p.status !== 0 || !exists(out)) {
      return { score: null, error: describeFailure(p, "apex runner"), grader: GRADER };
    }
    let g: Record<string, unknown>;
    try {
      g = readJsonStrict<Record<string, unknown>>(out);
    } catch (e) {
      return { score: null, error: (e as Error).message.slice(0, 800), grader: GRADER };
    }
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
