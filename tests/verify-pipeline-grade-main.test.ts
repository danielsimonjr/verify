import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../harness/grade/main.ts";

let root: string;
let savedRoot: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vp-gmain-"));
  savedRoot = process.env.VERIHARNESS_BENCH_ROOT;
  process.env.VERIHARNESS_BENCH_ROOT = root; // an empty bench: no benchmark data exists in it
});
afterEach(() => {
  if (savedRoot === undefined) delete process.env.VERIHARNESS_BENCH_ROOT;
  else process.env.VERIHARNESS_BENCH_ROOT = savedRoot;
  rmSync(root, { recursive: true, force: true });
});

async function run(argv: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  const err = process.stderr.write.bind(process.stderr);
  const log = console.log;
  let stderr = "";
  let stdout = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  console.log = (...a: unknown[]) => {
    stdout += a.join(" ") + "\n";
  };
  try {
    return { code: await main(argv), stderr, stdout };
  } finally {
    process.stderr.write = err;
    console.log = log;
  }
}

describe("grade CLI arguments", () => {
  test.each([
    [["sb2", "Debugging__x", "/d", "--jsn"], /unknown option --jsn/],
    [["sb2", "Debugging__x", "/d", "extra"], /usage: veriharness grade/],
    [["sb2", "Debugging__x"], /usage: veriharness grade/],
    [[], /usage: veriharness grade/],
    [["nope", "k", "/d"], /unknown bench: nope/],
  ])("%p is a usage error (exit 2)", async (argv, re) => {
    const r = await run(argv as string[]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(re as RegExp);
    expect(r.stdout).toBe("");
  });

  test("--json may stand anywhere among the arguments", async () => {
    const r = await run(["--json", "sb2", "Visualization__x", "/d"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ score: null, grader: "sb2/evaluation.py+recalc" });
  });

  test("plain output is the score and the error", async () => {
    const r = await run(["sb2", "Visualization__x", "/d"]);
    expect(r.stdout).toBe("null  category Visualization not wrapped (needs VLM checklist path)\n");
  });
});

describe("grade CLI failures", () => {
  test("a grader that throws is reported with its message and exit 1, not an unhandled rejection", async () => {
    // The empty bench has no Template dataset.json: the grader throws.
    const r = await run(["sb2", "Template__x", "/d"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^grade: .*dataset\.json/);
  });
});
