import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { GradeResult } from "../harness/grade/index.ts";
import { main, type GradeApi } from "../harness/score.ts";
import { canLinkFiles } from "./fixtures/links.ts";

const scratch = mkdtempSync(join(tmpdir(), "vd-score-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;

type TaskSpec = { key: string; base?: string; finish?: Record<string, unknown> | null; scores?: Record<string, number | null> };

/** A data root plus a `b_pool` cell with one workspace per task. Returns the cell and data root. */
function makeCell(tasks: TaskSpec[]): { cell: string; data: string } {
  const root = join(scratch, `case${counter++}`);
  const data = join(root, "data");
  const cell = join(root, "runs", "b_pool");
  mkdirSync(join(data, "b", "pool"), { recursive: true });
  mkdirSync(cell, { recursive: true });
  // No prototype: `meta["__proto__"] = ...` on a plain object would set the prototype, not a key.
  const meta: Record<string, unknown> = Object.create(null);
  for (const t of tasks) {
    meta[t.key] = { rollouts: Object.fromEntries(Object.entries(t.scores ?? { r1: 0.5, r2: 0.7 }).map(([r, score]) => [r, { score }])) };
    const ws = join(cell, t.key);
    mkdirSync(join(ws, "rollouts", "r1", "deliverables"), { recursive: true });
    mkdirSync(join(ws, "out", "deliverables"), { recursive: true });
    writeFileSync(join(ws, "rollouts", "r1", "deliverables", "f.txt"), "base");
    writeFileSync(join(ws, "out", "deliverables", "f.txt"), "revised");
    if (t.finish !== null) {
      const finish = t.finish ?? { base: t.base ?? "r1", repair: { valid: true, changed: ["f.txt"] } };
      writeFileSync(join(ws, "finish.json"), JSON.stringify(finish));
    }
  }
  writeFileSync(join(data, "b", "pool", "meta.json"), JSON.stringify(meta));
  return { cell, data };
}

/** The bundle being graded is the delivered one (<ws>/out/deliverables), not a rollout's. */
const isOut = (dir: string): boolean => dir.endsWith(join("out", "deliverables"));

function graders(grade: (key: string, dir: string) => Promise<GradeResult>): GradeApi {
  return {
    loadGradeModule: async () => ({ grade: () => ({ score: null }) }),
    gradeDeliverables: async (_bench, key, dir) => grade(key, dir),
    preflight: async () => "",
  };
}

async function quiet<T>(run: () => Promise<T>): Promise<{ result: T; err: string }> {
  const log = spyOn(console, "log").mockImplementation(() => {});
  let err = "";
  const write = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    err += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  try {
    return { result: await run(), err };
  } finally {
    log.mockRestore();
    write.mockRestore();
  }
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

function readScores(cell: string): { summary: Record<string, unknown>; tasks: Record<string, Record<string, unknown>>; unfinished: string[] } {
  return JSON.parse(readFileSync(join(cell, "scores.json"), "utf8"));
}

describe("score: progress is persisted as tasks finish", () => {
  test("a finished task is in scores.partial.jsonl while a slower one is still grading", async () => {
    const { cell, data } = makeCell([{ key: "fast" }, { key: "slow" }]);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const partial = join(cell, "scores.partial.jsonl");
    const text = () => (existsSync(partial) ? readFileSync(partial, "utf8") : "");

    const run = quiet(() =>
      main([cell, "--workers", "2"], {
        dataRoot: data,
        grade: graders(async (key, dir) => {
          if (key === "slow") await gate;
          return { score: isOut(dir) ? 0.9 : 0.6 };
        }),
      }),
    );
    const sawFast = await waitFor(() => text().includes('"key":"fast"'), 4000);
    const slowYet = text().includes('"key":"slow"');
    release();
    const { result } = await run;

    expect(sawFast).toBe(true);
    expect(slowYet).toBe(false);
    expect(result).toBe(0);
    expect(text()).toContain('"key":"slow"');
    expect(Object.keys(readScores(cell).tasks).sort()).toEqual(["fast", "slow"]);
  }, 20_000);

  test("batched graders persist a task as soon as both its batches have landed", async () => {
    const { cell, data } = makeCell(["t1", "t2", "t3", "t4"].map((key) => ({ key })));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const partial = join(cell, "scores.partial.jsonl");
    const text = () => (existsSync(partial) ? readFileSync(partial, "utf8") : "");
    const api: GradeApi = {
      preflight: async () => "",
      gradeDeliverables: async () => ({ score: 0.5 }),
      loadGradeModule: async () => ({
        grade: () => ({ score: null }),
        gradeBatch: async (items: [string, string, string | null][]) => {
          // The second delivered batch (t3, t4) is the slow one.
          if (isOut(items[0]![1]) && items[0]![0] === "t3") await gate;
          return Object.fromEntries(items.map(([key, dir]) => [key, { score: isOut(dir) ? 0.9 : 0.6 }]));
        },
      }),
    };
    const run = quiet(() => main([cell, "--batch", "2", "--workers", "4"], { dataRoot: data, grade: api }));
    const sawFirstPair = await waitFor(() => text().includes('"key":"t1"') && text().includes('"key":"t2"'), 4000);
    const secondPairYet = text().includes('"key":"t3"');
    release();
    const { result } = await run;
    expect(sawFirstPair).toBe(true);
    expect(secondPairYet).toBe(false);
    expect(result).toBe(0);
    expect(Object.keys(readScores(cell).tasks)).toEqual(["t1", "t2", "t3", "t4"]);
  }, 20_000);

  test("batched grading keeps tasks named __proto__ and constructor", async () => {
    const keys = ["__proto__", "constructor", "t1"];
    const { cell, data } = makeCell(keys.map((key) => ({ key })));
    const api: GradeApi = {
      preflight: async () => "",
      gradeDeliverables: async () => ({ score: 0.5 }),
      loadGradeModule: async () => ({
        grade: () => ({ score: null }),
        gradeBatch: async (items: [string, string, string | null][]) =>
          Object.fromEntries(items.map(([key, dir]) => [key, { score: isOut(dir) ? 0.9 : 0.6 }])),
      }),
    };
    const { result } = await quiet(() => main([cell, "--batch", "2", "--workers", "2"], { dataRoot: data, grade: api }));
    expect(result).toBe(0);
    const scored = readScores(cell);
    expect(Object.keys(scored.tasks).sort()).toEqual(["__proto__", "constructor", "t1"]);
    expect(scored.unfinished).toEqual([]);
    expect(Object.getOwnPropertyDescriptor(scored.tasks, "__proto__")?.value).toMatchObject({ out_graded: 0.9, base_regraded: 0.6 });
    const partial = readFileSync(join(cell, "scores.partial.jsonl"), "utf8");
    for (const key of keys) expect(partial).toContain(`"key":"${key}"`);
  }, 20_000);

  test("the bootstrap CI does not depend on the order in which tasks finish grading", async () => {
    const keys = ["t1", "t2", "t3", "t4", "t5", "t6"];
    const outScore: Record<string, number> = { t1: 0.2, t2: 0.9, t3: 0.4, t4: 0.7, t5: 0.1, t6: 0.6 };
    const ciWith = async (delayOf: (key: string) => number): Promise<unknown> => {
      const { cell, data } = makeCell(keys.map((key) => ({ key })));
      const api = graders(async (key, dir) => {
        if (isOut(dir)) await new Promise((r) => setTimeout(r, delayOf(key)));
        return { score: isOut(dir) ? outScore[key]! : 0.5 };
      });
      const { result } = await quiet(() => main([cell, "--workers", "6"], { dataRoot: data, grade: api }));
      expect(result).toBe(0);
      const { summary } = readScores(cell);
      return [summary.select_gain_ci95, summary.final_gain_ci95];
    };
    const forward = await ciWith((key) => 20 * keys.indexOf(key));
    const reverse = await ciWith((key) => 20 * (keys.length - keys.indexOf(key)));
    expect(reverse).toEqual(forward);
  }, 30_000);

  test("the arithmetic: final = select + (out - base_regraded), clamped to [0, 1]", async () => {
    const { cell, data } = makeCell([{ key: "a", scores: { r1: 0.5, r2: 0.7 } }]);
    await quiet(() =>
      main([cell], { dataRoot: data, grade: graders(async (_k, dir) => ({ score: isOut(dir) ? 0.9 : 0.6 })) }),
    );
    const row = readScores(cell).tasks.a!;
    expect(row.select).toBe(0.5);
    expect(row.base_regraded).toBe(0.6);
    expect(row.out_graded).toBe(0.9);
    expect(row.final).toBeCloseTo(0.8, 10);
  });
});

// The verifier writes its whole workspace, and a link it makes there resolves on the host when a
// grader reads it. Each side of a task is refused, ungraded, when a link sits on any step of what
// its grader reads: the bundle, or the base rollout's trace.
describe("score: a link in a workspace is refused, not followed", () => {
  /** Replace `<ws>/<rel>` with a link to a directory elsewhere that a grader could read. */
  function linkAway(ws: string, rel: string): void {
    const target = join(scratch, `elsewhere${counter++}`);
    mkdirSync(join(target, "deliverables"), { recursive: true });
    writeFileSync(join(target, "deliverables", "f.txt"), "elsewhere");
    writeFileSync(join(target, "f.txt"), "elsewhere");
    writeFileSync(join(target, "agent.json"), "{}");
    const at = join(ws, ...rel.split("/"));
    rmSync(at, { recursive: true, force: true });
    mkdirSync(dirname(at), { recursive: true });
    symlinkSync(target, at, "junction");
  }

  const baseDir = (ws: string) => join(ws, "rollouts", "r1", "deliverables");
  const outDir = (ws: string) => join(ws, "out", "deliverables");

  /** Score a cell whose one task is "t", with graders that record each directory they are given. */
  async function scoreOne(cell: string, data: string): Promise<{ row: Record<string, unknown>; seen: string[] }> {
    const seen: string[] = [];
    const api = graders(async (_key, dir) => {
      seen.push(dir);
      return { score: isOut(dir) ? 0.9 : 0.6 };
    });
    await quiet(() => main([cell], { dataRoot: data, grade: api }));
    return { row: readScores(cell).tasks.t!, seen };
  }

  // [where the link is, the side or sides it stops]. Both sides are given the base rollout's trace,
  // so a link on its path stops both.
  const cases: [string, "out" | "base" | "both"][] = [
    ["out", "out"],
    ["out/deliverables", "out"],
    ["out/deliverables/sub", "out"],
    ["rollouts/r1/deliverables", "base"],
    ["rollouts/r1", "both"],
    ["rollouts/r1/trajectory", "both"],
  ];
  for (const [rel, side] of cases) {
    test(`a link at ${rel} stops ${side === "both" ? "both sides" : `the ${side} side`}, and its grader never sees the path`, async () => {
      const { cell, data } = makeCell([{ key: "t" }]);
      const ws = join(cell, "t");
      linkAway(ws, rel);
      const { row, seen } = await scoreOne(cell, data);
      expect(row.error).toContain(`symlink: ${rel}`);
      expect(row.base_regraded).toBe(side === "out" ? 0.6 : null);
      expect(row.out_graded).toBe(side === "base" ? 0.9 : null);
      const graded = { out: [baseDir(ws)], base: [outDir(ws)], both: [] }[side];
      expect(seen).toEqual(graded);
    });
  }

  test("a dangling link stops its side too", async () => {
    const { cell, data } = makeCell([{ key: "t" }]);
    const ws = join(cell, "t");
    rmSync(outDir(ws), { recursive: true, force: true });
    symlinkSync(join(scratch, `nowhere${counter++}`), outDir(ws), "junction");
    const { row, seen } = await scoreOne(cell, data);
    expect(row.error).toContain("symlink: out/deliverables");
    expect(row).toMatchObject({ base_regraded: 0.6, out_graded: null });
    expect(seen).toEqual([baseDir(ws)]);
  });

  test.skipIf(!canLinkFiles)("a file link inside the delivered bundle stops the out side", async () => {
    const { cell, data } = makeCell([{ key: "t" }]);
    const ws = join(cell, "t");
    const secret = join(scratch, `secret${counter++}.txt`);
    writeFileSync(secret, "elsewhere");
    symlinkSync(secret, join(outDir(ws), "g.txt"), "file");
    const { row, seen } = await scoreOne(cell, data);
    expect(row.error).toContain("symlink: out/deliverables/g.txt");
    expect(row).toMatchObject({ base_regraded: 0.6, out_graded: null });
    expect(seen).toEqual([baseDir(ws)]);
  });

  test("a trace that is a plain file is not refused", async () => {
    const { cell, data } = makeCell([{ key: "t" }]);
    const ws = join(cell, "t");
    mkdirSync(join(ws, "rollouts", "r1", "trajectory"));
    writeFileSync(join(ws, "rollouts", "r1", "trajectory", "agent.json"), "{}");
    const { row, seen } = await scoreOne(cell, data);
    expect(row).toMatchObject({ base_regraded: 0.6, out_graded: 0.9, error: null });
    expect(seen).toEqual([baseDir(ws), outDir(ws)]);
  });

  test("batched grading refuses each linked side and grades the rest", async () => {
    const { cell, data } = makeCell(["a", "b", "c"].map((key) => ({ key })));
    linkAway(join(cell, "a"), "out");
    linkAway(join(cell, "b"), "rollouts/r1/deliverables");
    const seen: string[] = [];
    const api: GradeApi = {
      preflight: async () => "",
      gradeDeliverables: async () => {
        throw new Error("a batched bench is not graded one task at a time");
      },
      loadGradeModule: async () => ({
        grade: () => ({ score: null }),
        gradeBatch: async (items: [string, string, string | null][]) => {
          for (const [, dir] of items) seen.push(dir);
          return Object.fromEntries(items.map(([key, dir]) => [key, { score: isOut(dir) ? 0.9 : 0.6 }]));
        },
      }),
    };
    await quiet(() => main([cell, "--batch", "2", "--workers", "2"], { dataRoot: data, grade: api }));
    const { tasks } = readScores(cell);
    expect(tasks.a).toMatchObject({ base_regraded: 0.6, out_graded: null });
    expect(tasks.a!.error).toContain("symlink: out");
    expect(tasks.b).toMatchObject({ base_regraded: null, out_graded: 0.9 });
    expect(tasks.b!.error).toContain("symlink: rollouts/r1/deliverables");
    expect(tasks.c).toMatchObject({ base_regraded: 0.6, out_graded: 0.9, error: null });
    const ws = (key: string) => join(cell, key);
    expect(seen.sort()).toEqual([baseDir(ws("a")), outDir(ws("b")), baseDir(ws("c")), outDir(ws("c"))].sort());
  });
});

describe("score: argument validation", () => {
  test.each([
    ["--workers", "abc"],
    ["--workers", "0"],
    ["--workers", "2.5"],
    ["--batch", "x"],
    ["--batch", "-1"],
  ])("%s %s is refused with exit 2 and a message", async (flag, value) => {
    const { cell, data } = makeCell([{ key: "a" }]);
    const { result, err } = await quiet(() =>
      main([cell, flag, value], { dataRoot: data, grade: graders(async () => ({ score: 0.5 })) }),
    );
    expect(result).toBe(2);
    expect(err).toContain(flag);
    expect(existsSync(join(cell, "scores.json"))).toBe(false);
  });

  test("a cell name without <bench>_<pool> is refused", async () => {
    const root = join(scratch, `case${counter++}`);
    const cell = join(root, "nounderscore");
    mkdirSync(cell, { recursive: true });
    const { result, err } = await quiet(() => main([cell], { dataRoot: root, grade: graders(async () => ({ score: 0.5 })) }));
    expect(result).toBe(2);
    expect(err).toContain("<bench>_<pool>");
  });
});

describe("score: finish.json base names", () => {
  test("a base that climbs out of rollouts/ is not a rollout", async () => {
    const { cell, data } = makeCell([
      { key: "ok" },
      { key: "up", finish: { base: "r1/..", repair: {} } },
      { key: "up2", finish: { base: "..", repair: {} } },
    ]);
    await quiet(() => main([cell, "--select-only"], { dataRoot: data, grade: graders(async () => ({ score: 0.5 })) }));
    const scores = readScores(cell);
    expect(Object.keys(scores.tasks)).toEqual(["ok"]);
    expect(scores.unfinished.sort()).toEqual(["up", "up2"]);
  });

  test("a missing finish.json is unfinished", async () => {
    const { cell, data } = makeCell([{ key: "ok" }, { key: "none-yet", finish: null }]);
    await quiet(() => main([cell, "--select-only"], { dataRoot: data, grade: graders(async () => ({ score: 0.5 })) }));
    expect(readScores(cell).unfinished).toEqual(["none-yet"]);
  });
});

describe("score: rows keep every column, as the Python wrote them", () => {
  test("base none stores select as null, not a missing key", async () => {
    const { cell, data } = makeCell([{ key: "n", finish: { base: "none", repair: { valid: true } } }]);
    await quiet(() => main([cell, "--select-only"], { dataRoot: data, grade: graders(async () => ({ score: 0.5 })) }));
    const row = readScores(cell).tasks.n!;
    expect("select" in row).toBe(true);
    expect(row.select).toBeNull();
    expect(row.final).toBeNull();
  });

  test("a task named like an Object property is not a task of the pool", async () => {
    const { cell, data } = makeCell([{ key: "real" }]);
    mkdirSync(join(cell, "constructor", "rollouts"), { recursive: true });
    mkdirSync(join(cell, "toString"), { recursive: true });
    const { result } = await quiet(() =>
      main([cell, "--select-only"], { dataRoot: data, grade: graders(async () => ({ score: 0.5 })) }),
    );
    expect(result).toBe(0);
    expect(Object.keys(readScores(cell).tasks)).toEqual(["real"]);
  });
});
