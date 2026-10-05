import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeFailure, run } from "../harness/grade/proc.ts";

const RT = process.execPath; // bun under `bun test`, node otherwise: both take `-e`
const sh = (code: string, extra: Record<string, unknown> = {}) =>
  run(RT, ["-e", code], { timeoutMs: 20_000, env: process.env, ...extra });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vp-proc-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("run", () => {
  test("captures stdout, stderr and the exit status", async () => {
    const r = await sh("process.stdout.write('out'); process.stderr.write('err'); process.exit(3)");
    expect([r.status, r.stdout, r.stderr, r.timedOut, r.truncated]).toEqual([3, "out", "err", false, false]);
  });

  test("writes the input to stdin and reads multi-byte output back whole", async () => {
    const r = await sh("process.stdin.pipe(process.stdout)", { input: "héllo €" });
    expect(r.stdout).toBe("héllo €");
  });

  test("keeps stdout past spawnSync's 1 MiB default (the multi-MB HF task list)", async () => {
    const r = await sh("process.stdout.write('x'.repeat(3 * 1024 * 1024))");
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBe(3 * 1024 * 1024);
  });

  test("a stdout cap stops a runaway writer and says so", async () => {
    const r = await sh("for (;;) process.stdout.write('x'.repeat(65536))", { maxStdout: 1024 * 1024 });
    expect(r.truncated).toBe(true);
    expect(describeFailure(r, "w")).toMatch(/output too large/);
  });

  test("a command that cannot start is an error with a reason, not an empty message", async () => {
    const r = await run("vp-no-such-command-xyz", [], { timeoutMs: 5_000 });
    expect(r.error).toBeDefined();
    expect(describeFailure(r, "grader")).toMatch(/^grader: .*(ENOENT|not found)/);
  });

  test("a timeout kills the process, reports it, and returns promptly", async () => {
    const t0 = Date.now();
    const r = await sh("setTimeout(() => {}, 60000)", { timeoutMs: 400 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(8_000);
    expect(describeFailure(r, "runner")).toBe("runner: timed out after 400 ms");
  });

  test("a timeout kills the grandchildren too, not only the child's pid", async () => {
    const pidFile = join(dir, "grandchild.pid");
    const parent =
      "const {spawn}=require('node:child_process');const fs=require('node:fs');" +
      "const c=spawn(process.execPath,['-e','setTimeout(()=>{},25000)'],{stdio:'ignore'});" +
      "fs.writeFileSync(process.env.PID_FILE,String(c.pid));setTimeout(()=>{},60000)";
    let pid = 0;
    try {
      const r = await sh(parent, { timeoutMs: 2_500, env: { ...process.env, PID_FILE: pidFile } });
      expect(r.timedOut).toBe(true);
      expect(existsSync(pidFile)).toBe(true);
      pid = Number(readFileSync(pidFile, "utf8"));
      expect(pid).toBeGreaterThan(0);
      // Give the OS a moment to reap the killed processes.
      for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
      expect(alive(pid)).toBe(false);
    } finally {
      if (pid && alive(pid)) process.kill(pid, "SIGKILL"); // never leave the probe running
    }
  });

  test("onTimeout runs when the timeout fires", async () => {
    let called = false;
    await sh("setTimeout(() => {}, 60000)", {
      timeoutMs: 300,
      onTimeout: async () => {
        called = true;
      },
    });
    expect(called).toBe(true);
  });

  test("does not block the event loop while the child runs", async () => {
    let ticks = 0;
    const iv = setInterval(() => ticks++, 20);
    try {
      await sh("setTimeout(() => {}, 600)");
    } finally {
      clearInterval(iv);
    }
    // spawnSync would hold the loop for the whole 600 ms: zero or one tick.
    expect(ticks).toBeGreaterThanOrEqual(5);
  });
});

describe("describeFailure", () => {
  const base = { status: 0, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false, timeoutMs: 1000 };
  test.each([
    [{ ...base, status: 2 }, /^x: exit 2$/],
    [{ ...base, status: null, signal: "SIGKILL" as const }, /^x: killed by SIGKILL$/],
    [{ ...base, status: 0 }, /^x: exit 0 without a result$/],
    [{ ...base, status: 1, stderr: "boom\n" }, /^x: exit 1: boom$/],
    [{ ...base, status: null, timedOut: true, timeoutMs: 1_800_000 }, /^x: timed out after 1800 s$/],
  ])("%j is never an empty message", (r, re) => {
    expect(describeFailure(r, "x")).toMatch(re);
  });

  test("keeps only the tail of a long stderr", () => {
    const msg = describeFailure({ ...base, status: 1, stderr: "a".repeat(5000) + "END" }, "x", 20);
    expect(msg.endsWith("END")).toBe(true);
    expect(msg.length).toBeLessThan(60);
  });
});
