import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

// The grader reads VERIHARNESS_BENCH_ROOT when first imported; the stand-in checkout has no tasks.
const BENCH_ROOT = resolve(import.meta.dir, "fixtures", "verify-core", "bench");

async function loadWsb() {
  const prev = process.env.VERIHARNESS_BENCH_ROOT;
  process.env.VERIHARNESS_BENCH_ROOT = BENCH_ROOT;
  try {
    return await import("../harness/grade/wsb.ts");
  } finally {
    if (prev === undefined) delete process.env.VERIHARNESS_BENCH_ROOT;
    else process.env.VERIHARNESS_BENCH_ROOT = prev;
  }
}

describe("wsb gradeBatch", () => {
  test("a task named __proto__ without metadata gets its own error entry, as every other key does", async () => {
    const { gradeBatch } = await loadWsb();
    // No TASKS/<key>/metadata.json exists for either key, so this needs no Docker and no judge.
    const res = gradeBatch([
      ["__proto__", "/nowhere", null],
      ["constructor", "/nowhere", null],
    ]);
    expect(Object.keys(res).sort()).toEqual(["__proto__", "constructor"]);
    const own = Object.getOwnPropertyDescriptor(res, "__proto__")?.value as { score: unknown; error: string };
    expect(own.score).toBeNull();
    expect(own.error).toContain("no tasks/__proto__/metadata.json");
    expect(Object.entries(res).map(([k]) => k).sort()).toEqual(["__proto__", "constructor"]);
  });
});
