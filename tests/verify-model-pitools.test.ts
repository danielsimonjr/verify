import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunOptions, RunResult } from "../harness/grade/proc.ts";
import { makePiTools, PI_TOOL_BINARY, provideWithPi, type Provide } from "../harness/model/pitools.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vpitools-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const exe = process.platform === "win32" ? ".exe" : "";

describe("which binary a pi tool needs", () => {
  test("find needs fd and grep needs rg; the other tools need none", () => {
    expect(PI_TOOL_BINARY).toEqual({ find: "fd", grep: "rg" });
  });
});

describe("provide", () => {
  test("asks for the binaries of the tools offered, once, and keeps a tool whose binary came back", async () => {
    const asked: string[][] = [];
    const provide: Provide = async (binaries) => {
      asked.push([...binaries]);
      return Object.fromEntries(binaries.map((b) => [b, `/cache/${b}`]));
    };
    const tools = makePiTools({ provide, cacheDir: join(root, "cache") });
    const got = await tools.provide("read,grep,find,ls");
    expect(got).toEqual({ tools: "read,grep,find,ls", dropped: [] });
    expect(asked).toEqual([["rg", "fd"]]);
  });

  test("drops a tool whose binary could not be provided, and says which", async () => {
    const provide: Provide = async (binaries) => Object.fromEntries(binaries.map((b) => [b, b === "fd" ? null : b]));
    const tools = makePiTools({ provide, cacheDir: join(root, "cache") });
    const got = await tools.provide("read,grep,find,ls");
    expect(got.tools).toBe("read,grep,ls");
    expect(got.dropped).toEqual([{ tool: "find", binary: "fd" }]);
  });

  test("a list of tools that need no binary never reaches the provider", async () => {
    let calls = 0;
    const provide: Provide = async () => {
      calls++;
      return {};
    };
    const tools = makePiTools({ provide, cacheDir: join(root, "cache") });
    expect(await tools.provide("read,bash,ls")).toEqual({ tools: "read,bash,ls", dropped: [] });
    expect(calls).toBe(0);
  });

  test("concurrent callers share one provisioning, which is the race this module removes", async () => {
    let calls = 0;
    const provide: Provide = async (binaries) => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return Object.fromEntries(binaries.map((b) => [b, b]));
    };
    const tools = makePiTools({ provide, cacheDir: join(root, "cache") });
    const all = await Promise.all([1, 2, 3, 4].map(() => tools.provide("read,grep,find")));
    expect(all.every((a) => a.tools === "read,grep,find")).toBe(true);
    expect(calls).toBe(1);
  });

  test("a binary asked for before is not asked for again by a later call", async () => {
    const asked: string[][] = [];
    const provide: Provide = async (binaries) => {
      asked.push([...binaries]);
      return Object.fromEntries(binaries.map((b) => [b, b]));
    };
    const tools = makePiTools({ provide, cacheDir: join(root, "cache") });
    await tools.provide("grep");
    await tools.provide("grep,find");
    expect(asked).toEqual([["rg"], ["fd"]]);
  });

  test("a provider that throws drops its tools instead of failing the run", async () => {
    const provide: Provide = async () => {
      throw new Error("no network");
    };
    const tools = makePiTools({ provide, cacheDir: join(root, "cache") });
    const got = await tools.provide("read,find");
    expect(got.tools).toBe("read");
    expect(got.dropped).toEqual([{ tool: "find", binary: "fd" }]);
  });
});

describe("seed", () => {
  const cache = () => join(root, "cache");
  function cacheHolds(...names: string[]): void {
    mkdirSync(cache(), { recursive: true });
    for (const n of names) writeFileSync(join(cache(), n), `bytes of ${n}`);
  }

  test("copies each cached binary into <dir>/bin, and only the binaries", () => {
    cacheHolds(`fd${exe}`, `rg${exe}`, "fd-v10.zip", "notes.txt");
    mkdirSync(join(cache(), "extract_tmp_fd_1"));
    const home = join(root, "home");
    makePiTools({ provide: async () => ({}), cacheDir: cache() }).seed(home);
    expect(readdirSync(join(home, "bin")).sort()).toEqual([`fd${exe}`, `rg${exe}`]);
    expect(readFileSync(join(home, "bin", `fd${exe}`), "utf8")).toBe(`bytes of fd${exe}`);
  });

  test("leaves a binary the directory already holds", () => {
    cacheHolds(`fd${exe}`);
    const home = join(root, "home");
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(join(home, "bin", `fd${exe}`), "mine");
    makePiTools({ provide: async () => ({}), cacheDir: cache() }).seed(home);
    expect(readFileSync(join(home, "bin", `fd${exe}`), "utf8")).toBe("mine");
  });

  test("does nothing for the cache's own directory or an empty cache", () => {
    makePiTools({ provide: async () => ({}), cacheDir: cache() }).seed(join(root, "home"));
    expect(existsSync(join(root, "home"))).toBe(false);
    cacheHolds(`fd${exe}`);
    makePiTools({ provide: async () => ({}), cacheDir: cache() }).seed(root);
    expect(existsSync(join(root, "bin"))).toBe(false);
  });
});

describe("provideWithPi", () => {
  const ok = (stdout: string): RunResult => ({ status: 0, signal: null, stdout, stderr: "", timedOut: false, truncated: false, timeoutMs: 1 });

  test("runs pi's own tool manager in the cache's agent dir and reads the JSON it prints", async () => {
    const seen: { cmd: string; args: string[]; opts: RunOptions }[] = [];
    const run = async (cmd: string, args: string[], opts: RunOptions): Promise<RunResult> => {
      seen.push({ cmd, args, opts });
      return ok(`some download notice\n${JSON.stringify({ rg: "/agent/bin/rg", fd: null })}\n`);
    };
    const got = await provideWithPi(["rg", "fd"], { run, toolsManager: "/pi/dist/utils/tools-manager.js", agentDir: "/agent", node: "node" });
    expect(got).toEqual({ rg: "/agent/bin/rg", fd: null });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.cmd).toBe("node");
    expect(seen[0]!.args.slice(-3)).toEqual(["/pi/dist/utils/tools-manager.js", "rg", "fd"]);
    expect(seen[0]!.opts.env?.PI_CODING_AGENT_DIR).toBe("/agent");
    expect(seen[0]!.opts.timeoutMs).toBeGreaterThan(0);
  });

  test("a helper that fails, times out or prints no JSON gives no binary at all", async () => {
    const dead = [
      { status: 1, signal: null, stdout: "", stderr: "boom", timedOut: false, truncated: false, timeoutMs: 1 },
      { status: null, signal: null, stdout: "", stderr: "", timedOut: true, truncated: false, timeoutMs: 1 },
      ok("not json"),
    ] satisfies RunResult[];
    for (const r of dead) {
      const got = await provideWithPi(["fd"], { run: async () => r, toolsManager: "/t.js", agentDir: "/a", node: "node" });
      expect(got).toEqual({ fd: null });
    }
  });
});
