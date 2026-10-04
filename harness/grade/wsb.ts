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
import { copyFileSync, cpSync, mkdtempSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { benchRoot, TMP_DIR } from "../config.js";
import {
  assertNoSymlinks,
  chmod,
  exists,
  isDir,
  readJson,
  readText,
  rmrf,
  SymlinkError,
  writeText,
} from "../fsutil.js";
import { isView } from "../views.js";
import type { GradeResult } from "./index.js";

const WSB = join(benchRoot(), "benchmarks", "wsb_lite", "official", "evaluation");
const TASKS = join(WSB, "tasks");
const MODEL = "claude-opus-4-8";
const GRADER = "wsb/agent_as_a_judge";

const uid = (): number => process.getuid?.() ?? 0;
const gid = (): number => process.getgid?.() ?? 0;

function parseEnvFile(): Record<string, string> {
  const env: Record<string, string> = {};
  const path = join(WSB, ".env");
  if (!exists(path)) return env;
  for (const line of readText(path).split("\n")) {
    if (!line.includes("=") || line.trimStart().startsWith("#")) continue;
    const i = line.indexOf("=");
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

export async function preflight(): Promise<string> {
  const env = parseEnvFile();
  const url = env.JUDGE_BASE_URL ?? "";
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 1,
    messages: [{ role: "user", content: "ok" }],
  });
  try {
    const r = await fetch(`${url.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.JUDGE_API_KEY ?? ""}`,
      },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    // A JSON error body (401, 404, 500, ...) parses fine, so check the status first: scoring
    // against a judge that rejects every request would produce misleading zeros.
    if (!r.ok) {
      const detail = (await r.text().catch(() => "")).slice(0, 200);
      return `wsb judge ${MODEL} at ${url} returned HTTP ${r.status}: ${detail}`;
    }
    await r.json();
    return "";
  } catch (e) {
    const err = e as Error;
    return `wsb judge ${MODEL} unreachable at ${url}: ${err.name}: ${String(err.message).slice(0, 200)}`;
  }
}

function stage(
  td: string,
  key: string,
  deliverables: string,
  meta: Record<string, unknown>,
  trace?: string | null,
): void {
  assertNoSymlinks(deliverables);
  const taskDir = join(td, key);
  mkdirSync(join(taskDir, "output"), { recursive: true });
  const tracePath =
    trace ?? join(dirname(deliverables), "trajectory", "agent.json");
  if (exists(tracePath)) {
    copyFileSync(tracePath, join(taskDir, "agent.json"));
  }
  const metaOut = {
    ...meta,
    __metadata_path: `/workspace/Workspace-Bench/evaluation/tasks/${key}/metadata.json`,
  };
  writeText(join(taskDir, "metadata.json"), JSON.stringify(metaOut, null, 1));
  for (const name of readdirSync(deliverables)) {
    if (isView(name)) continue;
    const p = join(deliverables, name);
    const dest = join(taskDir, "output", name);
    if (isDir(p)) cpSync(p, dest, { recursive: true });
    else copyFileSync(p, dest);
  }
}

function parse(td: string, key: string, meta: Record<string, unknown>, tail: string): GradeResult {
  const rj = join(td, key, `rubrics_judge--${MODEL}.json`);
  if (!exists(rj)) {
    return { score: null, error: tail || "judge produced no rubric file", grader: GRADER };
  }
  const res = readJson<Record<string, unknown>>(rj)!;
  let items: unknown = res.rubrics ?? res.results ?? res;
  if (items && typeof items === "object" && !Array.isArray(items)) {
    items = (items as Record<string, unknown>).rubrics ?? [];
  }
  const list = (items as Record<string, unknown>[]) || [];
  const n = ((meta.rubrics as unknown[]) || []).length;
  const judgeErr =
    res.judge && typeof res.judge === "object"
      ? (res.judge as Record<string, unknown>).error
      : null;
  const failedItems = list.filter(
    (x) =>
      typeof x === "object" &&
      x &&
      String(x.evidence ?? "").startsWith("ClaudeCode judge failed"),
  );
  if (judgeErr || failedItems.length || !n) {
    const errMsg =
      judgeErr ||
      (failedItems[0] as Record<string, unknown>)?.evidence ||
      "no rubrics";
    return {
      score: null,
      error: `judge failed: ${String(errMsg)}`.slice(0, 400),
      rubrics: list,
      grader: GRADER,
    };
  }
  const passed = list.filter((x) => x && x.passed).length;
  return {
    score: passed / n,
    detail: { passed, n_rubrics: n },
    rubrics: list,
    grader: GRADER,
  };
}

function runJudge(stageRoot: string, workers: number, timeout: number): string {
  const cmd = [
    "docker",
    "compose",
    "-f",
    "docker/docker-compose.yaml",
    "run",
    "--rm",
    "--user",
    `${uid()}:${gid()}`,
    "-e",
    "HOME=/tmp/home",
    "-v",
    `${stageRoot}:/workspace/vh_stage`,
    "workspace-bench",
    "python3",
    "-u",
    "/workspace/Workspace-Bench/evaluation/src/agent_as_a_judge.py",
    "--task-dir",
    "/workspace/vh_stage",
    "--eval-yaml",
    "/workspace/Workspace-Bench/evaluation/runs/judge.yaml",
    "--overwrite",
    "--workers",
    String(workers),
  ];
  try {
    const p = spawnSync(cmd[0], cmd.slice(1), {
      encoding: "utf8",
      timeout,
      cwd: WSB,
    });
    return ((p.stderr || "") + (p.stdout || "")).slice(-800);
  } catch {
    return "judge container timed out";
  }
}

export function grade(
  key: string,
  deliverables: string,
  opts: { timeout?: number; trace?: string | null } = {},
): GradeResult {
  const timeout = opts.timeout ?? 2_400_000;
  const metaSrc = join(TASKS, key, "metadata.json");
  if (!exists(metaSrc)) {
    return { score: null, error: `no tasks/${key}/metadata.json`, grader: GRADER };
  }
  const meta = readJson<Record<string, unknown>>(metaSrc)!;
  const stageRoot = mkdtempSync(join(TMP_DIR, "vh_wsb_"));
  try {
    chmod(stageRoot, 0o777);
    try {
      stage(stageRoot, key, deliverables, meta, opts.trace);
    } catch (e) {
      if (e instanceof SymlinkError) return { score: null, error: e.message, grader: GRADER };
      throw e;
    }
    spawnSync("chmod", ["-R", "a+rwX", stageRoot], { encoding: "utf8" });
    const tail = runJudge(stageRoot, 1, timeout);
    return parse(stageRoot, key, meta, tail);
  } finally {
    rmrf(stageRoot);
  }
}

export function gradeBatch(
  items: [string, string, string | null][],
  workers = 8,
  timeout = 7_200_000,
): Record<string, GradeResult> {
  const out: Record<string, GradeResult> = {};
  const metas: Record<string, Record<string, unknown>> = {};
  const stageRoot = mkdtempSync(join(TMP_DIR, "vh_wsbb_"));
  try {
    chmod(stageRoot, 0o777);
    for (const [key, deliverables, trace] of items) {
      const metaSrc = join(TASKS, key, "metadata.json");
      if (!exists(metaSrc)) {
        out[key] = { score: null, error: `no tasks/${key}/metadata.json`, grader: GRADER };
        continue;
      }
      const meta = readJson<Record<string, unknown>>(metaSrc)!;
      try {
        stage(stageRoot, key, deliverables, meta, trace);
      } catch (e) {
        if (!(e instanceof SymlinkError)) throw e;
        out[key] = { score: null, error: e.message, grader: GRADER };
        continue;
      }
      metas[key] = meta;
    }
    if (!Object.keys(metas).length) return out;
    spawnSync("chmod", ["-R", "a+rwX", stageRoot], { encoding: "utf8" });
    const tail = runJudge(stageRoot, Math.min(workers, Object.keys(metas).length), timeout).slice(
      -400,
    );
    for (const key of Object.keys(metas)) {
      out[key] = parse(stageRoot, key, metas[key], tail);
    }
    return out;
  } finally {
    rmrf(stageRoot);
  }
}
