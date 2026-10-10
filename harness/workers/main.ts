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

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { USAGE_LIMIT_EXIT, claudeTools, isClaudeCodeProvider } from "../claude/provider.js";
import { DEFAULT_LANE_MAX, LANES, claudeCodeWindow } from "../config.js";
import { canonicalLocalProvider, parseContextSize, resolveLocalConfig, type BackendDeps } from "../model/config.js";
import { prepareLocalProvider } from "../model/prepare.js";
import type { PiProviderRecord } from "../model/pi.js";
import { isMain } from "../runtime.js";
import type { WorkerRecord } from "./record.js";
import { unsupportedKeywords } from "./schema.js";
import { runWorker, type WorkerJob, type WorkerModel } from "./worker.js";

const USAGE =
  "usage: veriharness workers DIR --provider P --model M [--base-url U] [--context-size N|auto]\n" +
  "         [--count N] [--tools LIST] [--deliverable NAME] [--prompt FILE] [--only NAME]...\n" +
  "         [--timeout S] [--max-turns N] [--max-parallel N] [--env none] [--temperature T] [--thinking L] [--max-tokens N]\n" +
  "         [--schema FILE] [--retries N] [--nudge-timeout S] [--allow-compaction]\n";

/** What a test replaces: the local server fetch and the worker runner. */
export interface WorkersDeps extends BackendDeps {
  runWorker?: typeof runWorker;
}

class UsageError extends Error {}

const DEFAULT_TOOLS = "read,grep,find,ls";

/** Errors a second try can fix: the model's output was wrong or empty. A limit, a timeout or a stop would only repeat. */
/**
 * A retry runs in the same rollout folder and would replace the stream and the record of the attempt
 * before it. Move both to trajectory/attempt-N/, so a rollout that took three tries shows all three.
 */
function keepAttempt(job: WorkerJob, attempt: number): void {
  const t = join(job.batchDir, "rollouts", job.rollout, "trajectory");
  const to = join(t, `attempt-${attempt}`);
  mkdirSync(to, { recursive: true });
  for (const name of ["agent.jsonl", "worker.json"]) {
    if (existsSync(join(t, name))) renameSync(join(t, name), join(to, name));
  }
}

const RETRYABLE = new Set(["no-result", "no-json", "thinking-only", "length", "schema"]);

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

function readText(path: string, flag: string): string {
  try {
    return readFileSync(resolve(path), "utf8");
  } catch (err) {
    throw new UsageError(`${flag} ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function optionalNumber(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UsageError(`invalid ${name} '${raw}'`);
  return n;
}

/** What `batch` estimated for one batch: its token estimate and item count, from `manifest.json`. */
interface Estimate {
  estTokens: number;
  items: number;
}

/** The estimates of a `batch` output root, by batch name, and the `--item-tokens` it used. Empty when there is no manifest. */
function readEstimates(root: string): { byBatch: Map<string, Estimate>; itemTokens: number } {
  const byBatch = new Map<string, Estimate>();
  let itemTokens = 0;
  try {
    const m = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as {
      itemTokens?: unknown;
      batches?: { name?: unknown; items?: unknown; estTokens?: unknown }[];
    };
    if (typeof m.itemTokens === "number") itemTokens = m.itemTokens;
    for (const b of m.batches ?? []) {
      if (typeof b.name === "string" && typeof b.estTokens === "number" && Array.isArray(b.items)) {
        byBatch.set(b.name, { estTokens: b.estTokens, items: b.items.length });
      }
    }
  } catch {
    // No manifest, or one that is not a batch manifest: the records carry no estimate.
  }
  return { byBatch, itemTokens };
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

/** Run `veriharness workers` on `argv`; returns 0, 1 when a rollout has an error, 2 on an input error, or 75 on a usage limit. */
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
        "max-turns": { type: "string" },
        "max-parallel": { type: "string" },
        env: { type: "string" },
        temperature: { type: "string" },
        thinking: { type: "string" },
        "max-tokens": { type: "string" },
        schema: { type: "string" },
        retries: { type: "string" },
        "nudge-timeout": { type: "string" },
        "allow-compaction": { type: "boolean", default: false },
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
  let retries = 0;
  let nudgeTimeoutSec: number | undefined;
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
      // Each worker maps the tools again; a bad name must stop the run here, not fail every rollout.
      claudeTools(values.tools ?? DEFAULT_TOOLS);
    } else if (!local) {
      // Only a local server has a window to size and a URL to call; pi's own providers have neither.
      const serverOnly = ["base-url", "context-size"].filter((n) => values[n as keyof typeof values] !== undefined);
      if (serverOnly.length) throw new UsageError(`${serverOnly.map((n) => "--" + n).join(", ")} needs --provider ollama or llamacpp`);
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
    const maxTurns = values["max-turns"] === undefined ? undefined : positiveInt("--max-turns", values["max-turns"], 0);
    if (values.retries !== undefined) {
      retries = Number(values.retries);
      if (!Number.isInteger(retries) || retries < 0) throw new UsageError(`--retries must be a whole number, not '${values.retries}'`);
    }
    // A nudge continues a saved pi session, so a Claude Code worker has none. 0 turns it off.
    const nudgeRaw = values["nudge-timeout"];
    const nudge = nudgeRaw === undefined ? 300 : Number(nudgeRaw);
    if (!Number.isInteger(nudge) || nudge < 0) throw new UsageError(`--nudge-timeout must be a whole number of seconds, not '${nudgeRaw}'`);
    if (claude && nudgeRaw !== undefined && nudge > 0) throw new UsageError("--nudge-timeout needs a pi worker: a claude-code worker keeps no session to continue");
    nudgeTimeoutSec = claude || nudge === 0 ? undefined : nudge;
    let schema: unknown;
    if (values.schema !== undefined) {
      const text = readText(values.schema, "--schema");
      try {
        schema = JSON.parse(text);
      } catch {
        throw new UsageError(`--schema ${values.schema} is not JSON`);
      }
      const ignored = unsupportedKeywords(schema);
      if (ignored.length) {
        throw new UsageError(`--schema ${values.schema} has keywords the check does not know, so it would be skipped: ${ignored.join(", ")}`);
      }
    }

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
          tools: values.tools ?? DEFAULT_TOOLS,
          deliverable: values.deliverable ?? "report.json",
          timeoutSec,
          ...(maxTurns !== undefined ? { maxTurns } : {}),
          ...(schema !== undefined ? { schema } : {}),
          ...(nudgeTimeoutSec !== undefined ? { nudgeTimeoutSec } : {}),
          ...(values["allow-compaction"] ? { allowCompaction: true } : {}),
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
  const estimates = readEstimates(resolve(positionals[0]!));
  let complete = 0;
  let errors = 0;
  let limited = false;
  // The cost of one item differs from rollout to rollout, so the value to use is the largest suggestion
  // of all of them, not the suggestion of one. A rollout that compacted gives only a lower bound.
  let suggested = 0;
  let lowerBound = false;
  // A usage limit stops the workers still running too: each one would only meet the same limit.
  const stopAll = new AbortController();
  const work = async ({ batch, job }: { batch: Batch; job: WorkerJob }): Promise<void> => {
    let record: WorkerRecord;
    let attempts = 0;
    try {
      do {
        attempts++;
        if (attempts > 1) keepAttempt(job, attempts - 1);
        record = await start({ ...job, attempt: attempts, signal: stopAll.signal });
      } while (record.error !== null && RETRYABLE.has(record.error) && attempts <= retries && !limited);
    } catch (err) {
      process.stderr.write(`error: ${batch.name}/${job.rollout}: ${err instanceof Error ? err.message : String(err)}\n`);
      errors++;
      return;
    }
    // The estimate is a claim that the batch fits; the record carries the measurement that tests it.
    const est = estimates.byBatch.get(batch.name);
    process.stdout.write(JSON.stringify({ batch: batch.name, ...record, attempts, ...(est ? { estTokens: est.estTokens } : {}) }) + "\n");
    if (est && est.items > 0 && record.peakContext > est.estTokens) {
      const itemTokens = estimates.itemTokens + Math.ceil((record.peakContext - est.estTokens) / est.items);
      suggested = Math.max(suggested, itemTokens);
      // Compaction caps the peak: the context the worker needed was larger than the one it measured.
      if (record.compactions > 0) lowerBound = true;
      process.stderr.write(
        `workers: ${batch.name}/${job.rollout}: peak context ${record.peakContext} passed the estimate of ${est.estTokens}; ` +
          `${record.compactions > 0 ? "at least " : ""}--item-tokens ${itemTokens} would have covered it\n`,
      );
    }
    if (record.tools >= 5 && record.toolErrors >= 3 && record.toolErrors * 2 >= record.tools) {
      process.stderr.write(
        `workers: ${batch.name}/${job.rollout}: ${record.toolErrors} of ${record.tools} tool calls failed: ` +
          `the worker is reading paths or patterns the task does not have\n`,
      );
    }
    if (record.compactions > 0) {
      process.stderr.write(
        `workers: ${batch.name}/${job.rollout}: the context was compacted ${record.compactions} times; ` +
          `the answer rests on turns the worker no longer held, so the batch is too big for the window\n`,
      );
    }
    if (record.error === null) complete++;
    else errors++;
    if (record.error === "usage-limit" && !limited) {
      limited = true;
      stopAll.abort();
    }
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
  if (suggested > 0) {
    process.stderr.write(
      `workers: ${lowerBound ? "at least " : ""}--item-tokens ${suggested} would have covered every rollout\n`,
    );
  }
  const summary = { complete, errors, skipped, ...(suggested > 0 ? { itemTokens: suggested } : {}) };
  process.stdout.write(JSON.stringify({ summary }) + "\n");
  if (limited) return USAGE_LIMIT_EXIT;
  return errors > 0 ? 1 : 0;
}

if (isMain(import.meta.url)) {
  main().then((code) => process.exit(code));
}
