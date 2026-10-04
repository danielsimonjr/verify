import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGrader } from "./fixtures/verify-core/grader-process.ts";

let tmp: string;
let bundle: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vc-wb-"));
  bundle = join(tmp, "bundle");
  mkdirSync(bundle);
  writeFileSync(join(bundle, "answer.md"), "ok");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("wb grade() without Docker", () => {
  // The subprocess PATH holds only an empty directory, so `docker` cannot be started. imageFor() read
  // spawnSync(...).stdout.split(), and stdout is null when the binary is missing: the grader
  // crashed with a TypeError instead of reporting that no image is available.
  test("reports no local env image instead of crashing", () => {
    const r = runGrader(tmp, "wb", "grade", ["office__alpha", bundle]);
    expect(r.score).toBeNull();
    expect(r.error).toBe("no local env image for alpha");
  });
});
