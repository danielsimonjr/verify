import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertNoSymlinks, copyDeliverable, copyTree, SymlinkError } from "../harness/fsutil.ts";
import { guardedEnv, runGrader as runGraderIn } from "./fixtures/verify-core/grader-process.ts";

/** Run a grader in a guarded subprocess (see grader-process.ts). */
const runGrader = (bench: string, fn: string, args: unknown[]) => runGraderIn(tmp, bench, fn, args);

let tmp: string;
let src: string;
let host: string; // stands in for files outside the bundle that a link must not expose
const SECRET = "HOST-SECRET-DO-NOT-COPY";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vc-fsutil-"));
  src = join(tmp, "bundle");
  host = join(tmp, "host");
  mkdirSync(src);
  mkdirSync(host);
  writeFileSync(join(host, "secret.txt"), SECRET);
  writeFileSync(join(src, "answer.md"), "ok");
  mkdirSync(join(src, "sub"));
  writeFileSync(join(src, "sub", "table.csv"), "a,b\n");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A directory link. "junction" needs no privilege on Windows and is a plain dir symlink elsewhere. */
function linkDir(target: string, at: string): void {
  symlinkSync(target, at, "junction");
}

describe("the PATH guard", () => {
  test("blocks docker and python3 so the grader tests below cannot reach them", () => {
    const env = guardedEnv(tmp);
    for (const exe of ["docker", "python3"]) {
      const r = spawnSync(exe, ["--version"], { encoding: "utf8", env });
      // The spawn must fail and nothing may have run. Node words it "ENOENT", Bun "Executable not
      // found in $PATH"; a successful run would leave no error and a numeric exit status.
      expect(r.error, `${exe} started under the guarded PATH`).toBeDefined();
      expect(r.error!.message).toMatch(/ENOENT|not found/i);
      expect(r.status ?? null).toBeNull(); // Node: null, Bun: undefined
    }
  });
});

describe("copyTree", () => {
  test("copies a regular bundle and honours the filter", () => {
    const dst = join(tmp, "staged");
    copyTree(src, dst, (rel) => !rel.endsWith(".csv"));
    expect(readFileSync(join(dst, "answer.md"), "utf8")).toBe("ok");
    expect(existsSync(join(dst, "sub", "table.csv"))).toBe(false);
  });

  test("rejects a directory link inside the bundle and copies nothing from its target", () => {
    linkDir(host, join(src, "linked"));
    const dst = join(tmp, "staged");
    expect(() => copyTree(src, dst)).toThrow(SymlinkError);
    expect(() => copyTree(src, dst)).toThrow(/linked/);
    expect(existsSync(join(dst, "linked", "secret.txt"))).toBe(false);
  });

  test("rejects a link nested several levels down", () => {
    linkDir(host, join(src, "sub", "deep"));
    expect(() => copyTree(src, join(tmp, "staged"))).toThrow(/sub\/deep/);
  });

  test("rejects a bundle whose root is itself a link", () => {
    const root = join(tmp, "root-link");
    linkDir(src, root);
    expect(() => copyTree(root, join(tmp, "staged"))).toThrow(SymlinkError);
  });

  test.skipIf(!canLinkFilesSync())("rejects a file symlink and does not copy the file it points at", () => {
    symlinkSync(join(host, "secret.txt"), join(src, "report.txt"), "file");
    const dst = join(tmp, "staged");
    expect(() => copyTree(src, dst)).toThrow(SymlinkError);
    expect(existsSync(join(dst, "report.txt"))).toBe(false);
  });
});

describe("copyDeliverable", () => {
  test("copies a regular file", () => {
    const dst = join(tmp, "out.md");
    copyDeliverable(join(src, "answer.md"), dst);
    expect(readFileSync(dst, "utf8")).toBe("ok");
  });

  test.skipIf(!canLinkFilesSync())("refuses a file symlink, names it, and copies nothing", () => {
    symlinkSync(join(host, "secret.txt"), join(src, "report.txt"), "file");
    const dst = join(tmp, "out.txt");
    expect(() => copyDeliverable(join(src, "report.txt"), dst)).toThrow(/symlink: report\.txt/);
    expect(existsSync(dst)).toBe(false);
  });
});

describe("assertNoSymlinks", () => {
  test("passes for a plain tree and for an empty one", () => {
    expect(() => assertNoSymlinks(src)).not.toThrow();
    mkdirSync(join(tmp, "empty"));
    expect(() => assertNoSymlinks(join(tmp, "empty"))).not.toThrow();
  });
  test("names the offending path relative to the root", () => {
    linkDir(host, join(src, "sub", "deep"));
    try {
      assertNoSymlinks(src);
      throw new Error("expected SymlinkError");
    } catch (e) {
      expect(e).toBeInstanceOf(SymlinkError);
      expect((e as SymlinkError).message).toContain("sub/deep");
      expect((e as SymlinkError).message).not.toContain(tmp);
    }
  });
});

describe("graders refuse a symlinked bundle as an ungraded result", () => {
  test("wsb grade() reports it and never starts a container", () => {
    linkDir(host, join(src, "linked"));
    const r = runGrader("wsb", "grade", ["sym-task", src]);
    expect(r.score).toBeNull();
    expect(r.error).toContain("symlink");
    expect(r.error).toContain("linked");
  });

  test("wsb gradeBatch() reports it per item and does not abort the batch", () => {
    linkDir(host, join(src, "linked"));
    const out = runGrader("wsb", "gradeBatch", [[["sym-task", src, null]]]);
    expect(out["sym-task"].score).toBeNull();
    expect(out["sym-task"].error).toContain("symlink");
  });

  test("jb grade() reports it and never starts the judge", () => {
    linkDir(host, join(src, "linked"));
    const r = runGrader("jb", "grade", ["analyst__model__build", src]);
    expect(r.score).toBeNull();
    expect(r.error).toContain("symlink");
  });

  test("wb grade() reports it before it asks Docker for an image", () => {
    linkDir(host, join(src, "linked"));
    const r = runGrader("wb", "grade", ["office__alpha", src]);
    expect(r.score).toBeNull();
    expect(r.error).toContain("symlink");
  });
});

/**
 * File symlinks need Developer Mode or elevation on Windows, so probe for them. test.skipIf needs
 * its answer at declaration time, before beforeEach has made a temp dir.
 */
function canLinkFilesSync(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "vc-probe-"));
  try {
    writeFileSync(join(dir, "t"), "x");
    symlinkSync(join(dir, "t"), join(dir, "l"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
