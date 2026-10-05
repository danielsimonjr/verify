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

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DATA } from "../config.js";
import { exists, isDir, readJson } from "../fsutil.js";
import { Rollout, Task, assertSegment, readJsonStrict, srcRoot, writeFileAtomic } from "./base.js";
import { renderOpenaiMessages, truthy } from "./renderers.js";

export const POOLS: Record<string, [string, string]> = {
  flash: ["digest_cache_*_flash", "flash_high_s"],
  opus: ["digest_cache_*_opus_high", "opus_high_s"],
};

const DOMAIN: Record<string, string> = {
  "Investment Banking": "IB",
  "Management Consulting": "MC",
  Law: "Law",
};

/** The grader checks this suffix against its own table, so an unknown domain has no valid key. */
export function domainCode(t: ApexTask): string {
  if (!Object.hasOwn(DOMAIN, t.domain)) {
    throw new Error(`unknown domain ${JSON.stringify(t.domain)} in APEX task ${t.task_id}: add it to DOMAIN`);
  }
  return DOMAIN[t.domain]!;
}

const TASKS_URL =
  "https://huggingface.co/datasets/mercor/apex-agents/resolve/main/tasks_and_rubrics.json";
const FETCH_TIMEOUT_MS = 60_000;

export type ApexTask = { task_id: string; domain: string; prompt: string };

/**
 * Where the task list is cached: VERIHARNESS_APEX_TASKS when set (also a way to supply a copy
 * downloaded elsewhere), else under the data directory. A shared name in the temp directory let
 * any local user plant the rubrics the grader trusts, and a reboot emptied it.
 */
export function defaultCachePath(): string {
  const env = process.env.VERIHARNESS_APEX_TASKS;
  return env && env.length > 0 ? env : join(DATA, "_cache", "apex-tasks_and_rubrics.json");
}

export type TasksSource = {
  fetchImpl?: typeof fetch;
  cachePath?: string;
  /** Hugging Face token; defaults to HF_TOKEN, then HUGGING_FACE_HUB_TOKEN. */
  token?: string | undefined;
};

function parseTasks(raw: string, where: string): ApexTask[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`APEX tasks from ${where} are not valid JSON: ${(e as Error).message}`);
  }
  const wellFormed = (t: unknown): t is ApexTask => {
    const r = t as Record<string, unknown> | null;
    return (
      typeof r === "object" &&
      r !== null &&
      typeof r.task_id === "string" &&
      typeof r.domain === "string" &&
      typeof r.prompt === "string"
    );
  };
  if (!Array.isArray(data) || data.length === 0 || !data.every(wellFormed)) {
    throw new Error(`APEX tasks from ${where} are not a non-empty list of {task_id, domain, prompt}`);
  }
  return data;
}

/**
 * The task list: the cached copy when it parses, else a fresh download. The unauthenticated
 * request is answered 401, so the download sends a Hugging Face token as `hf_hub_download` did in
 * the Python. A body is cached only after it parses, and through a rename, so a bad download is
 * never trusted.
 */
export async function loadTasks(src: TasksSource = {}): Promise<ApexTask[]> {
  const cachePath = src.cachePath ?? defaultCachePath();
  if (exists(cachePath)) {
    try {
      return parseTasks(readFileSync(cachePath, "utf8"), cachePath);
    } catch {
      /* a corrupt or truncated cache is replaced below */
    }
  }
  const token = "token" in src ? src.token : process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN;
  const res = await (src.fetchImpl ?? fetch)(TASKS_URL, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? "; set HF_TOKEN to a Hugging Face token that can read it" : "";
    throw new Error(`failed to download APEX tasks: ${res.status} ${res.statusText}${hint}`);
  }
  const body = await res.text();
  const tasks = parseTasks(body, TASKS_URL);
  writeFileAtomic(cachePath, body);
  return tasks;
}

let tasksMemo: Promise<ApexTask[]> | null = null;

/** One download per process: both pools read the same list. A failure is not remembered. */
export function defaultTasks(): Promise<ApexTask[]> {
  tasksMemo ??= loadTasks().catch((e) => {
    tasksMemo = null;
    throw e;
  });
  return tasksMemo;
}

function apexRoot(): string {
  return join(srcRoot(), "benchmarks/apex");
}

function matchGlob(name: string, pattern: string): boolean {
  const re = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
  );
  return re.test(name);
}

/** Mean verifier score of a run. An unreadable file counts as zero, as in the archived scores. */
function score(gradesFile: string): number {
  const vr = (readJson(gradesFile) as { verifier_results?: unknown } | null)?.verifier_results;
  if (!Array.isArray(vr) || vr.length === 0) return 0;
  let sum = 0;
  for (const v of vr) {
    const s = (v as { score?: unknown } | null)?.score ?? 0;
    if (typeof s !== "number" || !Number.isFinite(s)) {
      throw new Error(`non-numeric verifier score ${JSON.stringify(s)} in ${gradesFile}`);
    }
    sum += s;
  }
  return sum / vr.length;
}

function initialContext(runDir: string): string | null {
  const f = join(runDir, "initial_messages.json");
  if (!exists(f)) return null;
  let msgs: unknown;
  try {
    msgs = readJsonStrict(f);
  } catch {
    return null; // an unreadable file is no context: the next run's copy is tried
  }
  if (!Array.isArray(msgs)) return null;
  const out = msgs.map((m: { role?: string; content?: unknown } | null) => {
    const c = m?.content;
    return `## ${m?.role ?? "?"}\n\n${typeof c === "string" ? c : c == null ? "" : JSON.stringify(c)}`;
  });
  return `# The actor's initial context (from initial_messages.json)\n\n${out.join("\n\n")}`;
}

function renderTraj(runDir: string): () => string {
  return () => {
    const data = readJsonStrict<{ messages?: unknown } | null>(join(runDir, "trajectory.json"));
    const msgs = data?.messages;
    return renderOpenaiMessages(Array.isArray(msgs) ? (msgs as Record<string, unknown>[]) : []);
  };
}

const WORLDS = join(DATA, "_worlds", "apex");

function worldDir(idx: number): string | null {
  try {
    const stem = (readJson(join(WORLDS, "index.json")) as { idx2zip?: Record<string, string> })
      ?.idx2zip?.[String(idx)];
    if (!stem) return null;
    const d = join(WORLDS, stem);
    return isDir(d) ? d : null;
  } catch {
    return null;
  }
}

const RUN_DIR = /^idx(\d+)(?:_|$)/;

/** `tasks` is the HF task list; it is downloaded (and cached) when omitted. */
export async function* iterTasks(pool: string, tasks?: ApexTask[]): AsyncGenerator<Task> {
  const [cacheGlob, prefix] = POOLS[pool]!;
  const apex = apexRoot();
  const dissolve = join(apex, "dissolve");
  const caches = readdirSync(dissolve)
    .filter((n) => matchGlob(n, cacheGlob))
    .sort();
  if (!caches.length) throw new Error(`no ${cacheGlob} directory under ${dissolve}`);
  const cache = join(dissolve, caches[0]!);
  const ex = join(apex, "results/examples");
  const seeds = Array.from({ length: 10 }, (_, s) => `${prefix}${String(s + 1).padStart(2, "0")}`);
  const runs: Record<number, Record<string, string>> = {};
  for (const seed of seeds) {
    const outDir = join(ex, seed, "output");
    if (!exists(outDir)) continue;
    for (const name of readdirSync(outDir).sort()) {
      const rd = join(outDir, name);
      // isDir follows a symlinked run directory, as the Python glob did; a run without a grade is no run.
      if (!name.startsWith("idx") || !isDir(rd) || !exists(join(rd, "grades.json"))) continue;
      const m = RUN_DIR.exec(name);
      if (!m) throw new Error(`run directory ${rd} is not named idx<N> or idx<N>_<label>`);
      const idx = Number(m[1]);
      runs[idx] ??= {};
      runs[idx][seed] = rd;
    }
  }

  const all = tasks ?? (await defaultTasks());
  for (let i = 0; i < all.length; i++) {
    const t = all[i]!;
    assertSegment("APEX task_id", t.task_id);
    const cf = join(cache, `${t.task_id}.json`);
    if (!exists(cf)) continue;
    const digests = readJsonStrict<Record<string, { answer?: unknown } | null>>(cf);
    const task = new Task(`${String(i).padStart(3, "0")}_${domainCode(t)}`, t.prompt);
    const wd = worldDir(i);
    if (wd) task.links.push(["world", wd]);
    for (const rd of Object.values(runs[i] ?? {})) {
      const ctx = initialContext(rd);
      if (ctx) {
        task.workspaceTexts.push(["initial_messages.md", ctx]);
        break;
      }
    }
    for (const seed of seeds) {
      const raw = digests[seed]?.answer;
      if (truthy(raw) && typeof raw !== "string") {
        throw new Error(`the ${seed} answer in ${cf} is ${typeof raw}, not text`);
      }
      const answer = truthy(raw) ? (raw as string).trim() : "";
      if (!answer) continue;
      const d = runs[i]?.[seed];
      const r = new Rollout(seed, d ? score(join(d, "grades.json")) : 0);
      r.texts.push(["answer.md", answer]);
      if (d) r.traj = renderTraj(d);
      task.rollouts[seed] = r;
    }
    yield task;
  }
}
