import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HARNESS_DIR, REPO, findRepoRoot } from "../harness/config.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vp-config-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("findRepoRoot", () => {
  test("is the directory itself when it holds a package.json", () => {
    writeFileSync(join(root, "package.json"), "{}");
    expect(findRepoRoot(root)).toBe(root);
  });

  test("walks up from src/ (one level) and from dist/harness/ (two levels) to the same root", () => {
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, "harness"), { recursive: true });
    mkdirSync(join(root, "dist", "harness"), { recursive: true });
    expect(findRepoRoot(join(root, "harness"))).toBe(root);
    // The built config.js lives two levels down; dirname(dirname(...)) was `dist/`, which has no assets.
    expect(findRepoRoot(join(root, "dist", "harness"))).toBe(root);
  });

  test("the nearest package.json wins", () => {
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, "inner"));
    writeFileSync(join(root, "inner", "package.json"), "{}");
    expect(findRepoRoot(join(root, "inner"))).toBe(join(root, "inner"));
  });
});

describe("the real repository", () => {
  test("REPO is the package root and holds the assets the harness reads at run time", () => {
    expect(existsSync(join(REPO, "package.json"))).toBe(true);
    expect(existsSync(join(HARNESS_DIR, "grade", "sb2_compare.py"))).toBe(true);
    expect(existsSync(join(HARNESS_DIR, "benchmarks", "apex", "eval_configs.json"))).toBe(true);
  });
});
