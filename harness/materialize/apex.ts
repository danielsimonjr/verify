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

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DATA } from "../config.js";
import { exists, isDir, readJson, readText } from "../fsutil.js";
import { Rollout, Task, srcRoot } from "./base.js";
import { renderOpenaiMessages } from "./renderers.js";

export const POOLS: Record<string, [string, string]> = {
  flash: ["digest_cache_*_flash", "flash_high_s"],
  opus: ["digest_cache_*_opus_high", "opus_high_s"],
};

const DOMAIN: Record<string, string> = {
  "Investment Banking": "IB",
  "Management Consulting": "MC",
  Law: "Law",
};

const TASKS_URL =
  "https://huggingface.co/datasets/mercor/apex-agents/resolve/main/tasks_and_rubrics.json";

type ApexTask = { task_id: string; domain: string; prompt: string };

let tasksCache: ApexTask[] | null = null;

async function loadTasks(): Promise<ApexTask[]> {
  if (tasksCache) return tasksCache;
  const cachePath = join(tmpdir(), "veriharness-apex-tasks_and_rubrics.json");
  if (!exists(cachePath)) {
    const res = await fetch(TASKS_URL);
    if (!res.ok) {
      throw new Error(`failed to download APEX tasks: ${res.status} ${res.statusText}`);
    }
    writeFileSync(cachePath, Buffer.from(await res.arrayBuffer()));
  }
  tasksCache = JSON.parse(readFileSync(cachePath, "utf8")) as ApexTask[];
  return tasksCache;
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

function score(gradesFile: string): number {
  try {
    const vr = (readJson(gradesFile) as { verifier_results?: { score?: number }[] })
      ?.verifier_results ?? [];
    if (!vr.length) return 0;
    return vr.reduce((s, v) => s + (v.score ?? 0), 0) / vr.length;
  } catch {
    return 0;
  }
}

function initialContext(runDir: string): string | null {
  const f = join(runDir, "initial_messages.json");
  if (!exists(f)) return null;
  try {
    const msgs = readJson(f) as { role?: string; content?: string }[];
    const out = (msgs ?? []).map((m) => `## ${m.role ?? "?"}\n\n${m.content ?? ""}`);
    return `# The actor's initial context (from initial_messages.json)\n\n${out.join("\n\n")}`;
  } catch {
    return null;
  }
}

function renderTraj(runDir: string): () => string {
  return () => {
    const msgs =
      (readJson(join(runDir, "trajectory.json")) as { messages?: Record<string, unknown>[] })
        ?.messages ?? [];
    return renderOpenaiMessages(msgs);
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

export async function* iterTasks(pool: string): AsyncGenerator<Task> {
  const [cacheGlob, prefix] = POOLS[pool]!;
  const apex = apexRoot();
  const dissolve = join(apex, "dissolve");
  const caches = readdirSync(dissolve)
    .filter((n) => matchGlob(n, cacheGlob))
    .sort();
  const cache = join(dissolve, caches[0]!);
  const ex = join(apex, "results/examples");
  const seeds = Array.from({ length: 10 }, (_, s) => `${prefix}${String(s + 1).padStart(2, "0")}`);
  const runs: Record<number, Record<string, string>> = {};
  for (const seed of seeds) {
    const outDir = join(ex, seed, "output");
    if (!exists(outDir)) continue;
    for (const ent of readdirSync(outDir, { withFileTypes: true })) {
      if (!ent.isDirectory() || !ent.name.startsWith("idx")) continue;
      const gf = join(outDir, ent.name, "grades.json");
      if (!exists(gf)) continue;
      const idx = parseInt(ent.name.split("_")[0]!.slice(3), 10);
      runs[idx] ??= {};
      runs[idx][seed] = join(outDir, ent.name);
    }
  }

  const tasks = await loadTasks();
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]!;
    const cf = join(cache, `${t.task_id}.json`);
    if (!exists(cf)) continue;
    const digests = readJson(cf) as Record<string, Record<string, { answer?: string }>>;
    const task = new Task(`${String(i).padStart(3, "0")}_${DOMAIN[t.domain] ?? t.domain}`, t.prompt);
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
      const answer = String(digests[seed]?.answer ?? "").trim();
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
