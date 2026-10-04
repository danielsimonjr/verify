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
import { join, resolve } from "node:path";

import { assertNoSymlinks, copyTree, SymlinkError } from "../harness/fsutil.ts";

// Each grader call runs in a subprocess (tests/fixtures/verify-core/run-grader.ts) with its own
// environment: the stand-in bench checkout, a scratch staging directory, and an EMPTY PATH so no
// `docker` or `python3` can start. A grader must refuse a symlinked bundle before it gets near a
// container or a judge; if a regression lets one through, the spawn fails with ENOENT instead of
// reaching a real daemon.
const BENCH_ROOT = resolve(import.meta.dir, "fixtures", "verify-core", "bench");
const RUN_GRADER = resolve(import.meta.dir, "fixtures", "verify-core", "run-grader.ts");

function guardedEnv(stageDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VERIHARNESS_BENCH_ROOT: BENCH_ROOT,
    VERIHARNESS_TMP: stageDir,
  };
  for (const k of Object.keys(env)) if (k.toLowerCase() === "path") env[k] = "";
  return env;
}

function runGrader(bench: string, fn: string, args: unknown[]): Record<string, any> {
  const stageDir = join(tmp, "stage");
  mkdirSync(stageDir, { recursive: true });
  const r = spawnSync(process.execPath, [RUN_GRADER, bench, fn, JSON.stringify(args)], {
    encoding: "utf8",
    env: guardedEnv(stageDir),
  });
  const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) {
    throw new Error(`grader subprocess gave no result (status ${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
  return JSON.parse(line.slice("RESULT ".length));
}

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
      expect(r.error?.message ?? "").toContain("ENOENT");
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
