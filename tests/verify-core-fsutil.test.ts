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

import { assertNoLinkBelow, assertNoSymlinks, copyDeliverable, copyTree, SymlinkError } from "../harness/fsutil.ts";
import { canLinkFiles, linkDir } from "./fixtures/links.ts";
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

  test.skipIf(!canLinkFiles)("rejects a file symlink and does not copy the file it points at", () => {
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

  test.skipIf(!canLinkFiles)("refuses a file symlink, names it, and copies nothing", () => {
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

/** The path a SymlinkError names, or null when `run` throws nothing. */
function refused(run: () => void): string | null {
  try {
    run();
    return null;
  } catch (e) {
    if (e instanceof SymlinkError) return e.path;
    throw e;
  }
}

describe("assertNoLinkBelow", () => {
  test("passes for a plain path, and stops at a step that does not exist", () => {
    expect(refused(() => assertNoLinkBelow(tmp, "bundle"))).toBeNull();
    expect(refused(() => assertNoLinkBelow(tmp, "bundle/answer.md"))).toBeNull();
    expect(refused(() => assertNoLinkBelow(tmp, "missing/deeper"))).toBeNull();
  });

  test("refuses a link at a step above the last one", () => {
    const ws = join(tmp, "ws");
    mkdirSync(join(ws, "rollouts"), { recursive: true });
    linkDir(src, join(ws, "out"));
    linkDir(host, join(ws, "rollouts", "r1"));
    expect(refused(() => assertNoLinkBelow(ws, "out/deliverables"))).toBe("out");
    expect(refused(() => assertNoLinkBelow(ws, "rollouts/r1/deliverables"))).toBe("rollouts/r1");
  });

  test("refuses a dangling link: lstat sees the link, not its target", () => {
    linkDir(join(tmp, "nowhere"), join(src, "gone"));
    expect(refused(() => assertNoLinkBelow(tmp, "bundle"))).toBe("bundle/gone");
    expect(refused(() => assertNoLinkBelow(tmp, "bundle/gone/deeper"))).toBe("bundle/gone");
  });

  // On POSIX a backslash is part of a name. Splitting there made up two steps that do not exist,
  // and the check ended without walking the directory.
  test.skipIf(process.platform === "win32")("a backslash in a POSIX name is part of the name", () => {
    mkdirSync(join(tmp, "we\\ird"));
    linkDir(host, join(tmp, "we\\ird", "deep"));
    expect(refused(() => assertNoLinkBelow(tmp, "we\\ird"))).toBe("we\\ird/deep");
  });

  test("refuses the last step when it is a link", () => {
    const ws = join(tmp, "ws");
    mkdirSync(join(ws, "out"), { recursive: true });
    linkDir(src, join(ws, "out", "deliverables"));
    expect(refused(() => assertNoLinkBelow(ws, "out/deliverables"))).toBe("out/deliverables");
  });

  test.skipIf(!canLinkFiles)("refuses a file link at the last step", () => {
    mkdirSync(join(tmp, "trajectory"));
    symlinkSync(join(host, "secret.txt"), join(tmp, "trajectory", "agent.json"), "file");
    expect(refused(() => assertNoLinkBelow(tmp, "trajectory/agent.json"))).toBe("trajectory/agent.json");
  });

  test("refuses a link under the last step, named from the root and never by its host path", () => {
    linkDir(host, join(src, "sub", "deep"));
    expect(refused(() => assertNoLinkBelow(tmp, "bundle"))).toBe("bundle/sub/deep");
    let message = "";
    try {
      assertNoLinkBelow(tmp, "bundle");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/symlink: bundle\/sub\/deep$/);
    expect(message).not.toContain(tmp);
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

  // An empty answer.md ends an APEX grade before its runner starts, so a grader that follows the
  // link answers "empty answer.md" here instead of refusing.
  test("apex grade() refuses a bundle root that is a link", () => {
    const elsewhere = join(tmp, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "answer.md"), "");
    linkDir(elsewhere, join(tmp, "linked-bundle"));
    const r = runGrader("apex", "grade", ["apex-task", join(tmp, "linked-bundle")]);
    expect(r.score).toBeNull();
    expect(r.error).toContain("symlink: linked-bundle");
  });

  test.skipIf(!canLinkFiles)("apex grade() refuses a linked answer.md and does not read it", () => {
    writeFileSync(join(host, "empty.md"), "");
    rmSync(join(src, "answer.md"));
    symlinkSync(join(host, "empty.md"), join(src, "answer.md"), "file");
    const r = runGrader("apex", "grade", ["apex-task", src]);
    expect(r.score).toBeNull();
    expect(r.error).toContain("symlink: bundle/answer.md");
  });

  // WSB copies the trace from <bundle>/../trajectory/agent.json when it is given none.
  test("wsb grade() refuses a linked trace directory", () => {
    const traces = join(tmp, "traces");
    mkdirSync(traces);
    writeFileSync(join(traces, "agent.json"), SECRET);
    linkDir(traces, join(tmp, "trajectory"));
    const r = runGrader("wsb", "grade", ["sym-task", src]);
    expect(r.score).toBeNull();
    expect(r.error).toContain("symlink: trajectory");
  });

  test("wsb gradeBatch() refuses a linked trace per item", () => {
    const traces = join(tmp, "traces");
    mkdirSync(traces);
    writeFileSync(join(traces, "agent.json"), SECRET);
    linkDir(traces, join(tmp, "trajectory"));
    const out = runGrader("wsb", "gradeBatch", [[["sym-task", src, join(tmp, "trajectory", "agent.json")]]]);
    expect(out["sym-task"].score).toBeNull();
    expect(out["sym-task"].error).toContain("symlink: trajectory");
  });

  // "not-a-key" is a key SB2 rejects before it looks at the bundle, so only a check that runs
  // before the grader can answer with a refusal.
  test("gradeDeliverables() refuses a linked bundle before the grader runs", () => {
    linkDir(src, join(tmp, "linked-bundle"));
    const r = runGrader("index", "gradeDeliverables", ["sb2", "not-a-key", join(tmp, "linked-bundle")]);
    expect(r.score).toBeNull();
    expect(r.error).toContain("symlink: linked-bundle");
  });
});
