import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

import { partition } from "../harness/fsutil.ts";
import { wbTaskName } from "../harness/env/index.ts";

// The grader modules read VERIHARNESS_BENCH_ROOT when they are first imported. Point it at a
// stand-in checkout so no real benchmark, Docker daemon or Python interpreter is needed.
const BENCH_ROOT = resolve(import.meta.dir, "fixtures", "verify-core", "bench");

async function importWithBenchRoot<T>(load: () => Promise<T>): Promise<T> {
  const prev = process.env.VERIHARNESS_BENCH_ROOT;
  process.env.VERIHARNESS_BENCH_ROOT = BENCH_ROOT;
  try {
    return await load();
  } finally {
    if (prev === undefined) delete process.env.VERIHARNESS_BENCH_ROOT;
    else process.env.VERIHARNESS_BENCH_ROOT = prev;
  }
}

describe("partition (Python str.partition semantics)", () => {
  test("splits at the FIRST separator and keeps the rest intact", () => {
    expect(partition("office__beta__gamma", "__")).toEqual(["office", "beta__gamma"]);
    expect(partition("office__alpha", "__")).toEqual(["office", "alpha"]);
  });
  test("no separator gives the whole string and an empty tail", () => {
    expect(partition("office", "__")).toEqual(["office", ""]);
  });
  test("a trailing separator gives an empty tail", () => {
    expect(partition("office__", "__")).toEqual(["office", ""]);
  });
});

describe("env wbTaskName", () => {
  test("takes everything after the first __ in the workspace directory name", () => {
    expect(wbTaskName(join("data", "wb_flash", "office__alpha"))).toBe("alpha");
  });
  test("keeps a task name that itself contains __", () => {
    expect(wbTaskName(join("data", "wb_flash", "office__beta__gamma"))).toBe("beta__gamma");
  });
  test("falls back to the directory name when there is no domain prefix", () => {
    expect(wbTaskName(join("data", "wb_flash", "alpha"))).toBe("alpha");
  });
});

describe("grade/wb key parsing", () => {
  const missing = join(BENCH_ROOT, "no-such-deliverables-dir");

  // grade() checks the key, then the task dir, then the deliverables dir, and only then reaches
  // Docker. A nonexistent deliverables dir therefore proves the task dir was found, with no
  // container, proxy or judge involved.
  test("office__alpha resolves tasks/alpha", async () => {
    const wb = await importWithBenchRoot(() => import("../harness/grade/wb.ts"));
    const r = await wb.grade("office__alpha", missing);
    expect(r.error).toBe(`no deliverables dir ${missing}`);
  });

  test("office__beta__gamma resolves tasks/beta__gamma, not tasks/gamma", async () => {
    const wb = await importWithBenchRoot(() => import("../harness/grade/wb.ts"));
    const r = await wb.grade("office__beta__gamma", missing);
    expect(r.error).toBe(`no deliverables dir ${missing}`);
  });

  test("an unknown task reports the directory it looked in", async () => {
    const wb = await importWithBenchRoot(() => import("../harness/grade/wb.ts"));
    const r = await wb.grade("office__nope", missing);
    expect(r.score).toBeNull();
    expect(r.error).toContain(join("tasks", "nope"));
  });

  test("an unknown domain is reported as such", async () => {
    const wb = await importWithBenchRoot(() => import("../harness/grade/wb.ts"));
    const r = await wb.grade("bogus__alpha", missing);
    expect(r.error).toBe("unknown domain bogus");
  });

  test("a key with no task part is rejected, not looked up as tasks/", async () => {
    const wb = await importWithBenchRoot(() => import("../harness/grade/wb.ts"));
    const r = await wb.grade("office", missing);
    expect(r.score).toBeNull();
    expect(r.error).toContain("malformed key");
  });
});

describe("grade/jb key parsing", () => {
  test("analyst__model__build finds the rubrics of task model__build", async () => {
    const jb = await importWithBenchRoot(() => import("../harness/grade/jb.ts"));
    const hit = jb.rubricsFor("analyst__model__build");
    expect(hit).not.toBeNull();
    expect(hit!.replace(/\\/g, "/")).toEndWith("analyst/model__build/task_folder/RUBRICS.json");
  });

  test("a task that does not exist has no rubrics", async () => {
    const jb = await importWithBenchRoot(() => import("../harness/grade/jb.ts"));
    expect(jb.rubricsFor("analyst__model")).toBeNull();
    expect(jb.rubricsFor("analyst")).toBeNull();
  });
});
