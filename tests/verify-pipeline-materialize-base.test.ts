import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main as materializeMain } from "../harness/materialize/main.ts";
import {
  Rollout,
  Task,
  UsageError,
  copyFile,
  copyTree,
  parseCliArgs,
  runCli,
  writeTask,
} from "../harness/materialize/base.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vp-base-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function taskWith(key: string): Task {
  const t = new Task(key, "spec");
  for (const seed of ["a", "b"]) {
    const r = new Rollout(seed, 1);
    r.texts = [["answer.md", `answer ${seed}`]];
    t.rollouts[seed] = r;
  }
  return t;
}

describe("leak blocklist uses the file NAME, not the whole path", () => {
  test("copyFile refuses grades.json given a native absolute path", () => {
    const src = join(root, "grades.json");
    writeFileSync(src, "{}");
    expect(() => copyFile(src, join(root, "out", "grades.json"))).toThrow(/leak blocklist/);
  });

  test("a blocklist word in a parent directory does not block an ordinary file", () => {
    mkdirSync(join(root, "golden-set"));
    const src = join(root, "golden-set", "notes.txt");
    writeFileSync(src, "x");
    const dst = join(root, "out", "notes.txt");
    copyFile(src, dst);
    expect(readFileSync(dst, "utf8")).toBe("x");
  });

  test("copyTree skips answer-key files and keeps the rest", () => {
    mkdirSync(join(root, "in", "sub"), { recursive: true });
    writeFileSync(join(root, "in", "grades.json"), "{}");
    writeFileSync(join(root, "in", "sub", "RUBRICS.json"), "{}");
    writeFileSync(join(root, "in", "sub", "keep.txt"), "k");
    copyTree(join(root, "in"), join(root, "out"));
    expect(existsSync(join(root, "out", "sub", "keep.txt"))).toBe(true);
    expect(existsSync(join(root, "out", "grades.json"))).toBe(false);
    expect(existsSync(join(root, "out", "sub", "RUBRICS.json"))).toBe(false);
  });
});

describe("writeTask path segments", () => {
  test.each(["..", ".", "", "a/b", "a\\b"])("rejects task key %p and deletes nothing", async (key) => {
    const pool = join(root, "bench", "pool");
    mkdirSync(join(pool, "tasks"), { recursive: true });
    writeFileSync(join(pool, "meta.json"), "{}");
    await expect(writeTask("bench", "pool", taskWith(key), root)).rejects.toThrow(/single path segment/);
    expect(existsSync(join(pool, "meta.json"))).toBe(true);
  });

  test("writes the documented layout for a good key", async () => {
    const meta = (await writeTask("bench", "pool", taskWith("t1"), root)) as {
      rollouts: Record<string, { seed: string; score: number | null }>;
    };
    expect(Object.keys(meta.rollouts)).toEqual(["r01", "r02"]);
    expect(readFileSync(join(root, "bench", "pool", "tasks", "t1", "rollouts", "r01", "deliverables", "answer.md"), "utf8")).toBe(
      "answer a",
    );
  });
});

describe("parseCliArgs", () => {
  const pools = ["flash", "opus"];
  test("accepts the documented flags", () => {
    const a = parseCliArgs(["--pool", "opus", "--only", "k1", "--only", "k2", "--limit", "3"], pools);
    expect(a.poolList).toEqual(["opus"]);
    expect([...a.only!]).toEqual(["k1", "k2"]);
    expect(a.limit).toBe(3);
  });
  test("defaults to every pool and no limit", () => {
    const a = parseCliArgs([], pools);
    expect(a.poolList).toEqual(pools);
    expect(a.only).toBeNull();
    expect(a.limit).toBeUndefined();
  });
  test.each([
    [["--limit", "abc"], /--limit/],
    [["--limit", "-1"], /--limit/],
    [["--limit", "1.5"], /--limit/],
    [["--limit"], /needs a value/],
    [["--pool"], /needs a value/],
    [["--pool", "nope"], /invalid --pool/],
    [["--bogus"], /unknown argument/],
  ])("rejects %p", (argv, msg) => {
    expect(() => parseCliArgs(argv as string[], pools)).toThrow(UsageError);
    expect(() => parseCliArgs(argv as string[], pools)).toThrow(msg as RegExp);
  });
});

describe("runCli persistence and laziness", () => {
  const silence = async <T>(fn: () => Promise<T>): Promise<T> => {
    const log = console.log;
    console.log = () => {};
    try {
      return await fn();
    } finally {
      console.log = log;
    }
  };

  test("a crash mid-pool keeps the meta of every task already written", async () => {
    function* tasks(): Generator<Task> {
      yield taskWith("t1");
      throw new Error("boom on t2");
    }
    await expect(silence(() => runCli("bench", ["pool"], () => tasks(), [], root))).rejects.toThrow(/boom/);
    const metaFile = join(root, "bench", "pool", "meta.json");
    expect(existsSync(metaFile)).toBe(true);
    const meta = JSON.parse(readFileSync(metaFile, "utf8"));
    expect(Object.keys(meta)).toEqual(["t1"]);
    expect(Object.keys(meta.t1.rollouts)).toEqual(["r01", "r02"]);
  });

  test("a task that fails while being written does not orphan the earlier task's marker", async () => {
    const bad = taskWith("t2");
    bad.workspace.push([join(root, "does-not-exist.txt"), "x.txt"]);
    await expect(silence(() => runCli("bench", ["pool"], () => [taskWith("t1"), bad], [], root))).rejects.toThrow(/ENOENT/);
    const pool = join(root, "bench", "pool");
    // t1 carries a marker, so meta.json MUST already hold it, or a resume skips it for ever.
    expect(existsSync(join(pool, ".done", "t1"))).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(join(pool, "meta.json"), "utf8")))).toEqual(["t1"]);
  });

  test("a marker without a meta entry is re-materialized, not skipped", async () => {
    const pool = join(root, "bench", "pool");
    mkdirSync(join(pool, ".done"), { recursive: true });
    writeFileSync(join(pool, ".done", "t1"), "");
    await silence(() => runCli("bench", ["pool"], () => [taskWith("t1")], [], root));
    const meta = JSON.parse(readFileSync(join(pool, "meta.json"), "utf8"));
    expect(Object.keys(meta)).toEqual(["t1"]);
    expect(existsSync(join(pool, "tasks", "t1", "rollouts", "r01"))).toBe(true);
  });

  test("a marker WITH a meta entry is skipped", async () => {
    const pool = join(root, "bench", "pool");
    mkdirSync(join(pool, ".done"), { recursive: true });
    writeFileSync(join(pool, ".done", "t1"), "");
    writeFileSync(join(pool, "meta.json"), JSON.stringify({ t1: { rollouts: {} } }));
    await silence(() => runCli("bench", ["pool"], () => [taskWith("t1")], [], root));
    expect(existsSync(join(pool, "tasks", "t1"))).toBe(false);
  });

  test("--limit stops pulling tasks: a failure after the limit is never reached", async () => {
    function* tasks(): Generator<Task> {
      yield taskWith("t1");
      throw new Error("must not be pulled");
    }
    await silence(() => runCli("bench", ["pool"], () => tasks(), ["--limit", "1"], root));
    const meta = JSON.parse(readFileSync(join(root, "bench", "pool", "meta.json"), "utf8"));
    expect(Object.keys(meta)).toEqual(["t1"]);
  });

  test("a task with fewer than two rollouts is skipped", async () => {
    const t = new Task("lonely", "spec");
    t.rollouts.a = new Rollout("a", 1);
    await silence(() => runCli("bench", ["pool"], () => [t], [], root));
    expect(existsSync(join(root, "bench", "pool", "tasks", "lonely"))).toBe(false);
  });
});

describe("materialize main", () => {
  test("a bad flag is a usage error (exit 2), not a stack trace", async () => {
    const err = process.stderr.write.bind(process.stderr);
    let seen = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      seen += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await materializeMain(["sb2", "--limit", "abc"])).toBe(2);
    } finally {
      process.stderr.write = err;
    }
    expect(seen).toMatch(/--limit must be a non-negative integer/);
  });
});
