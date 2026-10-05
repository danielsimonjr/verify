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

/** Score one cell of a run against its archived rollout pool. */

import { appendFileSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as config from "./config.js";
import { parseCount } from "./count.js";
import { baseOf, readJson, rolloutDir } from "./driver.js";
import { assertNoLinkBelow, isDir, isFile, readText, writeJson } from "./fsutil.js";
import {
  gradeDeliverables,
  loadGradeModule,
  preflight,
  type GradeResult,
} from "./grade/index.js";

/** The grader entry points score.ts calls, injectable so a test can run a cell without real graders. */
export interface GradeApi {
  loadGradeModule: typeof loadGradeModule;
  gradeDeliverables: typeof gradeDeliverables;
  preflight: typeof preflight;
}

/** What `main` reads from outside the cell: the pools' data root and the graders. */
export interface ScoreDeps {
  dataRoot: string;
  grade: GradeApi;
}

const DEFAULT_GRADE: GradeApi = { loadGradeModule, gradeDeliverables, preflight };
import { iteratePool } from "./pool.js";
import { isMain } from "./runtime.js";

function bootstrapCi(xs: number[], iters = 10000, alpha = 0.05, seed = 0): [number, number] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  const n = xs.length;
  const means = Array.from({ length: iters }, () => {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += xs[Math.floor(rand() * n)]!;
    }
    return sum / n;
  }).sort((a, b) => a - b);
  return [means[Math.floor(alpha / 2 * iters)]!, means[Math.floor((1 - alpha / 2) * iters) - 1]!];
}

/** An ungraded result that names the error. */
function errorResult(e: unknown): GradeResult {
  const name = e instanceof Error ? e.constructor.name : "Error";
  const msg = e instanceof Error ? e.message : String(e);
  return { score: null, error: `${name}: ${msg.slice(0, 200)}` };
}

async function safeGrade(
  grade: GradeApi,
  bench: string,
  key: string,
  deliverables: string,
  kw: Record<string, unknown> = {},
): Promise<GradeResult> {
  try {
    return await grade.gradeDeliverables(bench, key, deliverables, kw);
  } catch (e) {
    return errorResult(e);
  }
}

/**
 * The refusal for a symlink on any step of the workspace paths `rels`, or null when there is none.
 * An error during the check is a refusal too: a path that cannot be checked is not graded.
 */
function linkRefusal(ws: string, rels: string[]): GradeResult | null {
  try {
    for (const rel of rels) assertNoLinkBelow(ws, rel);
    return null;
  } catch (e) {
    return errorResult(e);
  }
}

/**
 * The result each side of a task gets without a grader, as [base, delivered]; null for a side
 * that is graded.
 *
 * The verifier writes its whole workspace, and a symlink it makes there resolves on the host when
 * a grader reads it. So a side is refused when a link sits on any step of what its grader reads:
 * its bundle, or the base rollout's trace, which both sides are given.
 */
function ungraded(ws: string, base: string, deliveryValid: boolean): [GradeResult | null, GradeResult | null] {
  const baseRel = `rollouts/${base}/deliverables`;
  const trace = `rollouts/${base}/trajectory/agent.json`;
  const missingBase: GradeResult = { score: null, error: "no base" };
  const invalidDelivery: GradeResult = { score: null, error: "delivery failed the bundle contract" };
  return [
    linkRefusal(ws, [baseRel, trace]) ?? (isDir(join(ws, baseRel)) ? null : missingBase),
    linkRefusal(ws, ["out/deliverables", trace]) ?? (deliveryValid ? null : invalidDelivery),
  ];
}

type GradeJob = [string, string, string, boolean];

async function gradeTask(grade: GradeApi, job: GradeJob): Promise<[string, GradeResult, GradeResult]> {
  const [bench, wsStr, base, deliveryValid] = job;
  const key = basename(wsStr);
  const baseDir = join(wsStr, "rollouts", base, "deliverables");
  const trace = join(baseDir, "..", "trajectory", "agent.json");
  const [baseUngraded, outUngraded] = ungraded(wsStr, base, deliveryValid);
  const gBase = baseUngraded ?? (await safeGrade(grade, bench, key, baseDir));
  const gOut = outUngraded ?? (await safeGrade(grade, bench, key, join(wsStr, "out", "deliverables"), { trace }));
  return [key, gBase, gOut];
}

async function runBatch(
  gradeBatch: (
    items: [string, string, string | null][],
    workers: number,
  ) => Record<string, GradeResult> | Promise<Record<string, GradeResult>>,
  batch: number,
  b: [number, [string, string, string | null][]],
): Promise<[number, Record<string, GradeResult>]> {
  const [side, items] = b;
  try {
    const res = await gradeBatch(items, batch);
    return [side, res];
  } catch (e) {
    const err = errorResult(e);
    return [side, Object.fromEntries(items.map(([k]) => [k, err]))];
  }
}

async function* gradeBatched(
  grade: GradeApi,
  bench: string,
  jobs: GradeJob[],
  batch: number,
  containers: number,
): AsyncGenerator<[string, GradeResult, GradeResult]> {
  const mod = await grade.loadGradeModule(bench);
  const gradeBatch = mod.gradeBatch;
  if (!gradeBatch) return;

  // A Map: a task may be named `__proto__` or `constructor`, which a plain object would swallow.
  const pending = new Map<string, [GradeResult | null, GradeResult | null]>();
  const baseItems: [string, string, string | null][] = [];
  const outItems: [string, string, string | null][] = [];

  for (const [, wsStr, base, deliveryValid] of jobs) {
    const ws = wsStr;
    const key = basename(ws);
    const baseDir = join(ws, "rollouts", base, "deliverables");
    const trace = join(baseDir, "..", "trajectory", "agent.json");
    const pair = ungraded(ws, base, deliveryValid);
    pending.set(key, pair);
    if (pair[0] === null) {
      baseItems.push([key, baseDir, null]);
    }
    if (pair[1] === null) {
      outItems.push([key, join(ws, "out", "deliverables"), trace]);
    }
  }

  const batches: [number, [string, string, string | null][]][] = [
    ...chunk(baseItems, batch).map((items) => [0, items] as [number, [string, string, string | null][]]),
    ...chunk(outItems, batch).map((items) => [1, items] as [number, [string, string, string | null][]]),
  ];
  console.log(
    `${bench}: ${baseItems.length} base + ${outItems.length} delivered gradings in ${batches.length} containers ` +
      `of <= ${batch}, ${containers} at a time`,
  );

  function* ready(): Generator<[string, GradeResult, GradeResult]> {
    for (const [key, pair] of [...pending]) {
      if (pair[0] !== null && pair[1] !== null) {
        pending.delete(key);
        yield [key, pair[0], pair[1]];
      }
    }
  }

  yield* ready();

  // Each batch is folded in as it lands, so finished tasks reach the caller (and its partial
  // file) while the other containers are still grading.
  for await (const [side, res] of iteratePool(batches, containers, (b) => runBatch(gradeBatch, batch, b))) {
    for (const [key, r] of Object.entries(res)) {
      const pair = pending.get(key);
      if (pair) pair[side] = r;
    }
    yield* ready();
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/** The archived score of `base` in the pool, or null: a task's rollout names are data, not property names. */
function archivedScore(poolScores: Record<string, number>, base: string): number | null {
  return Object.hasOwn(poolScores, base) ? poolScores[base]! : null;
}

function unchanged(base: string, delivery: Record<string, unknown>): boolean {
  return base !== "none" && (delivery.changed as unknown[] | undefined)?.length === 0;
}

function row(
  base: string,
  poolScores: Record<string, number>,
  delivery: Record<string, unknown>,
  gBase: GradeResult | null,
  gOut: GradeResult | null,
): Record<string, unknown> {
  // null, not undefined: the row is JSON, and the Python wrote "select": null for a base the pool
  // holds no score for. An absent key reads differently to whatever consumes scores.json.
  let select: number | null = archivedScore(poolScores, base);
  const changed = delivery.changed;
  const rowOut: Record<string, unknown> = {
    base,
    select,
    pool_mean: sum(Object.values(poolScores)) / Object.keys(poolScores).length,
    oracle: Math.max(...Object.values(poolScores)),
    zero_spread: new Set(Object.values(poolScores).map((v) => Math.round(v * 1e9) / 1e9)).size === 1,
    delivery_valid: Boolean(delivery.valid),
    revised:
      changed !== undefined && changed !== null
        ? Boolean((changed as unknown[]).length)
        : Boolean(delivery.applied),
  };
  if (gBase === null) {
    return { ...rowOut, final: select };
  }
  if (unchanged(base, delivery) && select !== null) {
    return {
      ...rowOut,
      base_regraded: null,
      out_graded: null,
      final: select,
      error: null,
    };
  }
  const baseRegraded = gBase.score ?? null;
  const outGraded = gOut?.score ?? null;
  if (select === null && base !== "none" && baseRegraded !== null) {
    rowOut.select = select = baseRegraded;
  }
  let final: number | null;
  if (outGraded === null) {
    final = select;
  } else if (select === null) {
    final = outGraded;
  } else if (baseRegraded === null) {
    final = outGraded;
  } else {
    final = Math.min(1.0, Math.max(0.0, select + (outGraded - baseRegraded)));
  }
  return {
    ...rowOut,
    base_regraded: baseRegraded,
    out_graded: outGraded,
    final,
    error: gOut?.error || gBase.error || null,
  };
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function mean(xs: number[]): number {
  return xs.length ? sum(xs) / xs.length : NaN;
}

function summarize(cell: string, rows: Record<string, Record<string, unknown>>, unfinished: string[]) {
  // By task key, not by completion order: the seeded bootstrap resamples these rows by position, so
  // the order in which the graders happened to finish would move the interval from run to run.
  const scored = Object.keys(rows)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => rows[key]!)
    .filter((r) => r.final !== null && r.final !== undefined);
  const out: Record<string, unknown> = {
    cell,
    n_scored: scored.length,
    n_unfinished: unfinished.length,
  };
  if (!scored.length) return out;
  const fallback = (r: Record<string, unknown>) =>
    r.select !== null && r.select !== undefined ? (r.select as number) : (r.pool_mean as number);
  Object.assign(out, {
    single_rollout: mean(scored.map((r) => r.pool_mean as number)),
    select: mean(scored.map((r) => fallback(r))),
    final: mean(scored.map((r) => r.final as number)),
    oracle: mean(scored.map((r) => r.oracle as number)),
    n_revised: scored.filter((r) => r.revised).length,
    n_invalid_delivery: scored.filter((r) => !r.delivery_valid).length,
  });
  for (const name of ["select", "final"] as const) {
    const deltas =
      name === "select"
        ? scored.map((r) => fallback(r) - (r.pool_mean as number))
        : scored.map((r) => (r.final as number) - (r.pool_mean as number));
    out[`${name}_gain`] = mean(deltas);
    out[`${name}_gain_ci95`] =
      deltas.length > 1 ? bootstrapCi(deltas) : [deltas[0]!, deltas[0]!];
  }
  return out;
}

function graderHealth(rows: Record<string, Record<string, unknown>>): string {
  const both = Object.values(rows).filter(
    (r) => r.base_regraded !== null && r.base_regraded !== undefined && r.select !== null && r.select !== undefined,
  );
  if (!both.length) return "";
  const archived = mean(both.map((r) => r.select as number));
  const regraded = mean(both.map((r) => r.base_regraded as number));
  const zeros = both.filter((r) => r.base_regraded === 0.0 && (r.select as number) > 0).length;
  if (Math.abs(archived - regraded) > 0.05 || zeros > 0.3 * both.length) {
    return (
      `!! GRADER HEALTH: archived ${archived.toFixed(3)} vs regraded ${regraded.toFixed(3)} over ${both.length} bases, ` +
      `${zeros} of them regraded 0.0 against a non-zero archived score. Check the grader before ` +
      `believing this cell.`
    );
  }
  return "";
}

const OPTIONS = {
  workers: { type: "string", default: "6" },
  batch: { type: "string", default: "1" },
  "select-only": { type: "boolean", default: false },
  redo: { type: "boolean", default: false },
  json: { type: "boolean", default: false },
} as const;

function parseScoreArgs(argv: string[]) {
  return parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
}

/** A whole number >= 1, or null. `Number("abc")` is NaN, which a pool used to read as zero workers. */
function positiveInt(raw: string | undefined): number | null {
  return raw === undefined ? null : (parseCount(raw.trim(), 1) ?? null);
}

export async function main(argv: string[] = process.argv.slice(2), deps: Partial<ScoreDeps> = {}): Promise<number> {
  const dataRoot = deps.dataRoot ?? config.DATA;
  const grade = deps.grade ?? DEFAULT_GRADE;
  let parsed: ReturnType<typeof parseScoreArgs>;
  try {
    parsed = parseScoreArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (!positionals.length) {
    process.stderr.write("cell positional required\n");
    return 2;
  }
  const parsedWorkers = positiveInt(values.workers);
  const parsedBatch = positiveInt(values.batch);
  if (parsedWorkers === null || parsedBatch === null) {
    const [flag, raw] = parsedWorkers === null ? ["--workers", values.workers] : ["--batch", values.batch];
    process.stderr.write(`error: ${flag} must be a positive integer, got '${raw}'\n`);
    return 2;
  }
  const workers: number = parsedWorkers;
  const batch: number = parsedBatch;

  const cell = resolve(positionals[0]!);
  const cellName = basename(cell);
  const lastUnderscore = cellName.lastIndexOf("_");
  if (lastUnderscore <= 0 || lastUnderscore === cellName.length - 1) {
    process.stderr.write(`error: the cell directory must be named <bench>_<pool>, got '${cellName}'\n`);
    return 2;
  }
  const benchName = cellName.slice(0, lastUnderscore);
  const poolName = cellName.slice(lastUnderscore + 1);

  const meta = JSON.parse(readText(join(dataRoot, benchName, poolName, "meta.json"))) as Record<
    string,
    { rollouts: Record<string, { score: number | null }> }
  >;

  if (!values["select-only"]) {
    const problem = await grade.preflight(benchName);
    if (problem) {
      process.stderr.write(
        `!! ${benchName} grader preflight failed; refusing to run rather than score zeros:\n   ${problem}\n`,
      );
      return 2;
    }
  }

  // Keyed by directory and rollout names, which are data: no prototype, so "constructor" or
  // "__proto__" is an ordinary key and `in` / hasOwn see only what was put there.
  const tasks: Record<
    string,
    [string, string, Record<string, number>, Record<string, unknown>]
  > = Object.create(null);
  const unfinished: string[] = [];

  // Sorted, as the Python was: the bootstrap CI resamples the per-task deltas in this order, so an
  // unsorted listing (Bun and Node differ, and ext4 is not alphabetical) would move the interval.
  const entries = readdirSync(cell, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ent of entries) {
    if (!ent.isDirectory() || !Object.hasOwn(meta, ent.name)) continue;
    const ws = join(cell, ent.name);
    const poolScores: Record<string, number> = Object.create(null);
    for (const [r, v] of Object.entries(meta[ent.name]!.rollouts)) {
      if (v.score !== null) poolScores[r] = v.score;
    }
    const finish = readJson<Record<string, unknown>>(join(ws, "finish.json"));
    if (!Object.keys(poolScores).length) {
      unfinished.push(`${ent.name} (no archived scores in the pool)`);
      continue;
    }
    const base = finish ? baseOf(finish) : "none";
    if (finish === null || (base !== "none" && rolloutDir(ws, base) === null)) {
      unfinished.push(ent.name);
      continue;
    }
    tasks[ent.name] = [ws, base, poolScores, (finish.repair as Record<string, unknown>) || {}];
  }

  const rows: Record<string, Record<string, unknown>> = Object.create(null);

  if (values["select-only"]) {
    for (const [k, [, base, sc, delivery]] of Object.entries(tasks)) {
      rows[k] = row(base, sc, delivery, null, null);
    }
  } else {
    for (const [k, [, base, poolScores, delivery]] of Object.entries(tasks)) {
      if (unchanged(base, delivery) && archivedScore(poolScores, base) !== null) {
        rows[k] = row(base, poolScores, delivery, { score: null }, { score: null });
      }
    }
    const nUnchanged = Object.keys(rows).length;
    const partial = join(cell, "scores.partial.jsonl");
    if (isFile(partial) && !values.redo) {
      for (const line of readFileSync(partial, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as { key: string; row: Record<string, unknown> };
          if (Object.hasOwn(tasks, rec.key) && !Object.hasOwn(rows, rec.key)) {
            const [, base, poolScores, delivery] = tasks[rec.key];
            const old = rec.row;
            rows[rec.key] = row(
              base,
              poolScores,
              delivery,
              { score: old.base_regraded as number | null, error: undefined },
              { score: old.out_graded as number | null, error: old.error as string | undefined },
            );
          }
        } catch {
          continue;
        }
      }
      console.log(`resuming: ${Object.keys(rows).length - nUnchanged} tasks already graded`);
    } else if (isFile(partial)) {
      unlinkSync(partial);
    }

    const jobs: GradeJob[] = Object.entries(tasks)
      .filter(([k]) => !Object.hasOwn(rows, k))
      .map(([, [ws, base, , delivery]]) => [benchName, ws, base, Boolean(delivery.valid)] as GradeJob);

    console.log(
      `${jobs.length} tasks to grade; ${nUnchanged} delivered unchanged (the base stands)`,
    );

    const mod = await grade.loadGradeModule(benchName);
    const hasBatch = typeof mod.gradeBatch === "function" && batch > 1;

    // Results arrive as each task finishes, so every one reaches scores.partial.jsonl at once and a
    // run that dies mid-cell resumes from what was graded. (Awaiting the whole pool first, as this
    // did, wrote nothing until the last task was done.)
    async function* results(): AsyncGenerator<[string, GradeResult, GradeResult]> {
      if (hasBatch) {
        yield* gradeBatched(grade, benchName, jobs, batch, workers);
        return;
      }
      yield* iteratePool(jobs, workers, async (job) => gradeTask(grade, job));
    }

    for await (const [key, gBase, gOut] of results()) {
      const [, base, poolScores, delivery] = tasks[key];
      const rowOut = row(base, poolScores, delivery, gBase, gOut);
      rows[key] = rowOut;
      appendFileSync(
        partial,
        JSON.stringify({ key, row: rowOut }, (_, v) => (typeof v === "bigint" ? String(v) : v)) + "\n",
      );
      console.log(
        `${key.slice(0, 44).padEnd(44)} select ${rowOut.select} regraded ${rowOut.base_regraded} ` +
          `out ${rowOut.out_graded} final ${rowOut.final}`,
      );
    }
  }

  const summary = summarize(cellName, rows, unfinished);
  writeJson(join(cell, "scores.json"), { summary, tasks: rows, unfinished });

  if (values.json) {
    console.log(JSON.stringify(summary));
    return 0;
  }
  const health = graderHealth(rows);
  if (health) console.log("\n" + health);
  console.log(`\n${cellName}: ${summary.n_scored} scored, ${summary.n_unfinished} unfinished`);
  if (summary.n_scored) {
    console.log(
      `  single rollout ${(summary.single_rollout as number).toFixed(4)} | select ${(summary.select as number).toFixed(4)} | ` +
        `final ${(summary.final as number).toFixed(4)} | oracle ${(summary.oracle as number).toFixed(4)}`,
    );
    for (const name of ["select", "final"] as const) {
      const gain = summary[`${name}_gain`] as number;
      const ci = summary[`${name}_gain_ci95`] as [number, number];
      console.log(
        `  ${name.padEnd(6)} gain ${gain >= 0 ? "+" : ""}${gain.toFixed(4)}  CI95 [${ci[0] >= 0 ? "+" : ""}${ci[0].toFixed(4)}, ${ci[1] >= 0 ? "+" : ""}${ci[1].toFixed(4)}]`,
      );
    }
    console.log(
      `  revised ${summary.n_revised} | invalid deliveries ${summary.n_invalid_delivery}`,
    );
  }
  return 0;
}

if (isMain(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
