// The sb2 grader's lookups, run in-process against one fixed bench root. Every case returns before
// any container or comparison would start, so nothing here needs docker or Python.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "vp-sb2g-"));
const saved = process.env.VERIHARNESS_BENCH_ROOT;
process.env.VERIHARNESS_BENCH_ROOT = root;
const data = join(root, "benchmarks", "sb2", "official", "data");
mkdirSync(join(data, "Debugging"), { recursive: true });
mkdirSync(join(data, "Financial_Model"), { recursive: true });
writeFileSync(
  join(data, "Debugging", "dataset.json"),
  JSON.stringify([{ id: "t__1", spreadsheet_path: "x.xlsx", golden_response_path: "g.xlsx", answer_position: "A1" }]),
);
writeFileSync(join(data, "Financial_Model", "dataset.json"), "{not json"); // Template has no dataset.json at all
const empty = join(root, "empty");
mkdirSync(empty);

const sb2 = await import("../harness/grade/sb2.ts");

afterAll(() => {
  if (saved === undefined) delete process.env.VERIHARNESS_BENCH_ROOT;
  else process.env.VERIHARNESS_BENCH_ROOT = saved;
  rmSync(root, { recursive: true, force: true });
});

describe("sb2 grade lookups", () => {
  test('a task id that contains "__" is looked up whole (split at the first separator only)', async () => {
    // key.split("__", 2)[1] was "t", which is no task id at all.
    expect(await sb2.grade("Debugging__t__1", empty)).toMatchObject({
      score: 0,
      error: "no t__1_output.xlsx in deliverables",
    });
  });

  test("an unknown task id says so", async () => {
    expect(await sb2.grade("Debugging__nope", empty)).toMatchObject({ score: null, error: "unknown task id nope" });
  });

  test("an inherited property name is not a task id", async () => {
    // A plain-object lookup found Object.prototype.constructor and went on to grade it.
    expect(await sb2.grade("Debugging__constructor", empty)).toMatchObject({ error: "unknown task id constructor" });
  });

  test("a category the grader does not wrap scores null, not zero", async () => {
    expect(await sb2.grade("Visualization__x", empty)).toMatchObject({
      score: null,
      error: "category Visualization not wrapped (needs VLM checklist path)",
    });
  });

  test("a key without the separator is a bad key, not an undefined task id", async () => {
    expect((await sb2.grade("Debugging", empty)).error).toMatch(/bad sb2 key "Debugging"/);
  });

  test("a missing dataset.json is an error that names the file, not 'every task id is unknown'", async () => {
    await expect(sb2.grade("Template__x", empty)).rejects.toThrow(/Template.*dataset\.json/);
  });

  test("a corrupt dataset.json is an error that names the file", async () => {
    await expect(sb2.grade("Financial_Model__x", empty)).rejects.toThrow(/invalid JSON in .*dataset\.json/);
  });
});
