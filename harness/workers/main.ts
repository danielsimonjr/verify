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

/**
 * `veriharness workers` — run N worker rollouts on each batch of a `batch` output root, or on one task
 * workspace. A local model runs one batch at a time with all its rollouts in parallel: the server has
 * a fixed token rate, so more sessions at once only make each one slower. Claude Code runs up to the
 * lane cap of the model across batches. A rollout whose record has no error is skipped, so a second
 * call after a stop finishes the job without repeating work.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { USAGE_LIMIT_EXIT, isClaudeCodeProvider } from "../claude/provider.js";
import { DEFAULT_LANE_MAX, LANES, claudeCodeWindow } from "../config.js";
import { canonicalLocalProvider, parseContextSize, resolveLocalConfig, type BackendDeps } from "../model/config.js";
import { prepareLocalProvider } from "../model/prepare.js";
import type { PiProviderRecord } from "../model/pi.js";
import { isMain } from "../runtime.js";
import type { WorkerRecord } from "./record.js";
import { runWorker, type WorkerJob, type WorkerModel } from "./worker.js";

const USAGE =
  "usage: veriharness workers DIR --provider P --model M [--base-url U] [--context-size N|auto]\n" +
  "         [--count N] [--tools LIST] [--deliverable NAME] [--prompt FILE] [--only NAME]...\n" +
  "         [--timeout S] [--max-parallel N] [--env none] [--temperature T] [--thinking L] [--max-tokens N]\n";

export interface WorkersDeps extends BackendDeps {
  runWorker?: typeof runWorker;
}

class UsageError extends Error {}

interface Batch {
  name: string;
  dir: string;
}

const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();
const isTask = (dir: string): boolean => isDir(join(dir, "spec")) && isDir(join(dir, "workspace"));

/** DIR itself when it is one task workspace, else each sub-folder that is one, by name. */
function findBatches(dir: string): Batch[] {
  if (isTask(dir)) return [{ name: basename(dir), dir }];
  return readdirSync(dir)
    .sort()
    .map((name) => ({ name, dir: join(dir, name) }))
    .filter((b) => isTask(b.dir));
}

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${name} must be a positive whole number, not '${raw}'`);
  return n;
}

function optionalNumber(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UsageError(`invalid ${name} '${raw}'`);
  return n;
}

/** A complete rollout: its record says no error. */
function isComplete(batchDir: string, rollout: string): boolean {
  const path = join(batchDir, "rollouts", rollout, "trajectory", "worker.json");
  if (!existsSync(path)) return false;
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { error?: unknown }).error === null;
  } catch {
    return false;
  }
}

/** The lane cap of a Claude Code model: the lane whose `--model` it is, else 2. */
function laneCap(model: string): number {
  for (const [lane, flags] of Object.entries(LANES)) {
    if (flags[flags.indexOf("--model") + 1] === model) return DEFAULT_LANE_MAX[lane] ?? 2;
  }
  return 2;
}

/** Run `jobs` with at most `size` at once; stop taking new ones once `stop()` is true. */
async function pool<T>(jobs: readonly T[], size: number, work: (job: T) => Promise<void>, stop: () => boolean): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (!stop() && next < jobs.length) await work(jobs[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, lane));
}

export async function main(argv: string[] = process.argv.slice(2), deps: WorkersDeps = {}): Promise<number> {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h", default: false },
        provider: { type: "string" },
        model: { type: "string" },
        "base-url": { type: "string" },
        "context-size": { type: "string" },
        count: { type: "string" },
        tools: { type: "string" },
        deliverable: { type: "string" },
        prompt: { type: "string" },
        only: { type: "string", multiple: true },
        timeout: { type: "string" },
        "max-parallel": { type: "string" },
        env: { type: "string" },
        temperature: { type: "string" },
        thinking: { type: "string" },
        "max-tokens": { type: "string" },
      },
    }));
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  let jobsByBatch: { batch: Batch; jobs: WorkerJob[] }[];
  let parallel: number;
  let local: boolean;
  let skipped = 0;
  try {
    if (positionals.length !== 1) throw new UsageError("give one DIR: a batch output root or one task workspace");
    const dir = resolve(positionals[0]!);
    if (!isDir(dir)) throw new UsageError(`${dir} is not a folder`);
    const provider = values.provider;
    const model = values.model;
    if (!provider || !model) throw new UsageError("--provider and --model are required");
    const claude = isClaudeCodeProvider(provider);
    local = canonicalLocalProvider(provider) !== undefined;
    if (values.env !== undefined && values.env !== "none") throw new UsageError(`--env '${values.env}': only --env none is supported`);
    if (claude) {
      if (values.env !== "none") throw new UsageError("a claude-code worker needs --env none, as on the driver");
      const piOnly = ["temperature", "thinking", "max-tokens", "base-url", "context-size"].filter((n) => values[n as keyof typeof values] !== undefined);
      if (piOnly.length) throw new UsageError(`${piOnly.map((n) => "--" + n).join(", ")} not supported with --provider claude-code`);
    }

    let batches = findBatches(dir);
    if (batches.length === 0) throw new UsageError(`${dir} holds no batch: no folder with spec/ and workspace/`);
    const only = values.only ?? [];
    for (const name of only) {
      if (!batches.some((b) => b.name === name)) throw new UsageError(`--only ${name}: no such batch in ${dir}`);
    }
    if (only.length) batches = batches.filter((b) => only.includes(b.name));

    const promptPath = values.prompt ?? join(dir, "worker_prompt.md");
    if (!existsSync(promptPath)) throw new UsageError(`no worker prompt: pass --prompt FILE or write ${promptPath}`);
    const prompt = readFileSync(promptPath, "utf8");
    const count = positiveInt("--count", values.count, 3);
    const timeoutSec = positiveInt("--timeout", values.timeout, 3600);

    // Resolve the model once before the first worker: for a local model this also proves the server.
    const workerModel: WorkerModel = {
      provider,
      model,
      baseUrl: values["base-url"],
      contextSize: parseContextSize(values["context-size"], "--context-size"),
      temperature: optionalNumber("--temperature", values.temperature),
      thinking: values.thinking,
      maxTokens: optionalNumber("--max-tokens", values["max-tokens"]),
    };
    let piProvider: PiProviderRecord | undefined;
    if (local) {
      const config = resolveLocalConfig({ ...workerModel, provider, model });
      const prepared = await prepareLocalProvider(config, deps);
      for (const warning of prepared.warnings) process.stderr.write(`workers: ${warning}\n`);
      const caps = prepared.probe.capabilities;
      const source = config.contextSize !== undefined ? "explicit" : caps.contextSource;
      process.stderr.write(`workers: ${provider}:${prepared.model} window=${config.contextSize ?? caps.contextSize} source=${source}\n`);
      piProvider = prepared.piProvider;
      workerModel.model = prepared.model;
    } else if (claude) {
      const window = claudeCodeWindow(model);
      process.stderr.write(`workers: ${provider}:${model} window=${window ?? "unknown"} source=${window ? "table" : "none"}\n`);
    }

    parallel = positiveInt("--max-parallel", values["max-parallel"], claude ? laneCap(model) : count);
    const width = Math.max(2, String(count).length);
    jobsByBatch = batches.map((batch) => {
      const jobs: WorkerJob[] = [];
      for (let i = 1; i <= count; i++) {
        const rollout = `r${String(i).padStart(width, "0")}`;
        if (isComplete(batch.dir, rollout)) {
          skipped++;
          continue;
        }
        jobs.push({
          batchDir: batch.dir,
          rollout,
          prompt,
          model: workerModel,
          tools: values.tools ?? "read,grep,find,ls",
          deliverable: values.deliverable ?? "report.json",
          timeoutSec,
          piProvider,
        });
      }
      return { batch, jobs };
    });
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const start = deps.runWorker ?? runWorker;
  let complete = 0;
  let errors = 0;
  let limited = false;
  const work = async ({ batch, job }: { batch: Batch; job: WorkerJob }): Promise<void> => {
    let record: WorkerRecord;
    try {
      record = await start(job);
    } catch (err) {
      process.stderr.write(`error: ${batch.name}/${job.rollout}: ${err instanceof Error ? err.message : String(err)}\n`);
      errors++;
      return;
    }
    process.stdout.write(JSON.stringify({ batch: batch.name, ...record }) + "\n");
    if (record.error === null) complete++;
    else errors++;
    if (record.error === "usage-limit") limited = true;
  };
  const stop = () => limited;
  const tagged = jobsByBatch.map(({ batch, jobs }) => jobs.map((job) => ({ batch, job })));
  if (local) {
    for (const jobs of tagged) {
      if (limited) break;
      await pool(jobs, parallel, work, stop);
    }
  } else {
    await pool(tagged.flat(), parallel, work, stop);
  }
  process.stdout.write(JSON.stringify({ summary: { complete, errors, skipped } }) + "\n");
  if (limited) return USAGE_LIMIT_EXIT;
  return errors > 0 ? 1 : 0;
}

if (isMain(import.meta.url)) {
  main().then((code) => process.exit(code));
}
