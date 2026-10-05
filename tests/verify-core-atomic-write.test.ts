import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureDir, renameReplacing, writeFileAtomic, writeText } from "../harness/fsutil.ts";

/** A rename that fails with `code` for its first `failures` calls, then succeeds. */
function flakyRename(code: string, failures: number) {
  const calls: string[] = [];
  const rename = (from: string, to: string) => {
    calls.push(`${from}->${to}`);
    if (calls.length <= failures) {
      throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
    }
  };
  return { rename, calls };
}

describe("renameReplacing", () => {
  test.each(["EPERM", "EACCES", "EBUSY"])("retries %s on Windows until the target is released", (code) => {
    const { rename, calls } = flakyRename(code, 2);
    renameReplacing("a.tmp", "a", { rename, platform: "win32", budgetMs: 5000 });
    expect(calls).toHaveLength(3);
  });

  test("throws any other error at once", () => {
    const { rename, calls } = flakyRename("ENOENT", 1);
    expect(() => renameReplacing("a.tmp", "a", { rename, platform: "win32" })).toThrow(/ENOENT/);
    expect(calls).toHaveLength(1);
  });

  test("does not retry EPERM off Windows, where it is permanent", () => {
    const { rename, calls } = flakyRename("EPERM", 1);
    expect(() => renameReplacing("a.tmp", "a", { rename, platform: "linux" })).toThrow(/EPERM/);
    expect(calls).toHaveLength(1);
  });

  test("gives up after its budget and throws the last error", () => {
    const { rename, calls } = flakyRename("EPERM", Number.POSITIVE_INFINITY);
    const start = Date.now();
    expect(() => renameReplacing("a.tmp", "a", { rename, platform: "win32", budgetMs: 150 })).toThrow(/EPERM/);
    expect(calls.length).toBeGreaterThan(1);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe("writeFileAtomic", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vc-atomic-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("replaces an existing file and leaves no temp file", () => {
    const path = join(dir, "sub", "meta.json");
    writeFileAtomic(path, "old");
    writeFileAtomic(path, "new");
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(readdirSync(join(dir, "sub"))).toEqual(["meta.json"]);
  });

  // Bun on Windows throws EEXIST for a recursive mkdir of "." or ".." (oven-sh/bun#44576), so a
  // relative path whose directory is the cwd failed there and worked under Node.
  test("accepts a relative path in the current directory", () => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      writeFileAtomic("meta.json", "a");
      writeText("notes.txt", "b");
      ensureDir(".");
      ensureDir("..");
    } finally {
      process.chdir(cwd);
    }
    expect(readFileSync(join(dir, "meta.json"), "utf8")).toBe("a");
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("b");
  });

  test("removes its temp file when the rename fails for good", () => {
    const path = join(dir, "meta.json");
    const { rename } = flakyRename("EPERM", Number.POSITIVE_INFINITY);
    expect(() => writeFileAtomic(path, "x", { rename, platform: "win32", budgetMs: 50 })).toThrow(/EPERM/);
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });
});
