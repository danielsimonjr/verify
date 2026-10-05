import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gradingSettings } from "../harness/grade/apex.ts";

let root: string;
const saved: Record<string, string | undefined> = {};
const setEnv = (name: string, value: string | undefined): void => {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vp-gset-"));
  // The swapped settings file is written under os.tmpdir(): keep it in the test root.
  for (const name of ["TEMP", "TMP", "TMPDIR"]) setEnv(name, root);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("gradingSettings", () => {
  test("without APEX_JUDGE_MODEL the benchmark's own file is used in place", () => {
    setEnv("APEX_JUDGE_MODEL", undefined);
    const file = join(root, "grading_settings.json");
    expect(gradingSettings(file)).toBe(file);
  });

  test("with APEX_JUDGE_MODEL the model is swapped and every other setting is kept", () => {
    setEnv("APEX_JUDGE_MODEL", "vertex_ai/some-model");
    const file = join(root, "grading_settings.json");
    writeFileSync(file, JSON.stringify({ llm_judge_model: "gemini/old", reasoning_effort: "low", retries: 3 }));
    const out = gradingSettings(file);
    expect(out).not.toBe(file);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
      llm_judge_model: "vertex_ai/some-model",
      reasoning_effort: "low",
      retries: 3,
    });
  });

  test("a missing settings file is an error that names it, not a file holding only the model", () => {
    setEnv("APEX_JUDGE_MODEL", "vertex_ai/some-model");
    expect(() => gradingSettings(join(root, "absent.json"))).toThrow(/absent\.json/);
  });

  test("a corrupt settings file is an error that names it", () => {
    setEnv("APEX_JUDGE_MODEL", "vertex_ai/some-model");
    const file = join(root, "grading_settings.json");
    writeFileSync(file, "{not json");
    expect(() => gradingSettings(file)).toThrow(/invalid JSON in .*grading_settings\.json/);
  });
});
