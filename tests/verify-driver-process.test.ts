import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { descendantsOf, killProcessTree, runWithBudget } from "../harness/runtime.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "verify-driver");
const scratch = mkdtempSync(join(tmpdir(), "vd-process-"));
const grandchildren: number[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

function grandchildPid(tag: string): number {
  const pid = Number(readFileSync(`${tag}.pid`, "utf8"));
  grandchildren.push(pid);
  return pid;
}

afterAll(() => {
  // A failing test must not leave its fixtures running.
  for (const pid of grandchildren) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe("runWithBudget", () => {
  test("a timed-out turn dies as a whole tree, including a detached grandchild, and returns", async () => {
    const tag = join(scratch, "timeout");
    const run = await runWithBudget([process.execPath, join(FIXTURES, "turn_child.mjs"), tag], {
      cwd: scratch,
      env: process.env,
      budgetMs: 2500,
    });
    // The test is only meaningful if the grandchild really started.
    expect(existsSync(`${tag}.pid`)).toBe(true);
    const gc = grandchildPid(tag);
    expect(run.timedOut).toBe(true);
    expect(await waitFor(() => !alive(gc), 5000)).toBe(true);
  }, 20_000);

  test("onKill runs on a timeout so a named container can be removed", async () => {
    let killed = 0;
    const tag = join(scratch, "onkill");
    await runWithBudget([process.execPath, join(FIXTURES, "turn_child.mjs"), tag], {
      cwd: scratch,
      env: process.env,
      budgetMs: 1500,
      onKill: () => {
        killed++;
      },
    });
    grandchildPid(tag);
    expect(killed).toBe(1);
  }, 20_000);

  test("a missing binary is reported, not swallowed", async () => {
    const run = await runWithBudget(["definitely-not-a-binary-verify-driver"], {
      cwd: scratch,
      env: process.env,
      budgetMs: 5000,
    });
    expect(run.code).toBeNull();
    expect(run.timedOut).toBe(false);
    expect(run.spawnError).toMatch(/ENOENT/);
  });

  test("a clean exit reports its code and nothing else", async () => {
    const ok = await runWithBudget([process.execPath, "-e", "process.exit(0)"], {
      cwd: scratch,
      env: process.env,
      budgetMs: 10_000,
    });
    expect(ok).toMatchObject({ code: 0, timedOut: false });
    expect(ok.spawnError).toBeUndefined();
    const bad = await runWithBudget([process.execPath, "-e", "process.stderr.write('boom'); process.exit(3)"], {
      cwd: scratch,
      env: process.env,
      budgetMs: 10_000,
    });
    expect(bad).toMatchObject({ code: 3, timedOut: false, stderr: "boom" });
  });

  test("stderr is bounded to a tail instead of growing without limit", async () => {
    const tag = join(scratch, "noisy");
    const run = await runWithBudget([process.execPath, join(FIXTURES, "turn_child.mjs"), tag, "noisy"], {
      cwd: scratch,
      env: process.env,
      budgetMs: 2500,
      stderrTailChars: 4096,
    });
    grandchildPid(tag);
    expect(run.stderr.length).toBeLessThanOrEqual(4096);
    expect(run.stderr.endsWith("END-OF-NOISE\n")).toBe(true);
  }, 20_000);

  test("a budget above the timer limit does not fire at once", async () => {
    const run = await runWithBudget([process.execPath, "-e", "setTimeout(() => process.exit(0), 300)"], {
      cwd: scratch,
      env: process.env,
      budgetMs: 3e9,
    });
    expect(run).toMatchObject({ code: 0, timedOut: false });
  });

  test("a budget that is not a positive number is refused", async () => {
    for (const bad of [Number.NaN, 0, -5]) {
      await expect(
        runWithBudget([process.execPath, "-e", "0"], { cwd: scratch, env: process.env, budgetMs: bad }),
      ).rejects.toThrow(/budget/);
    }
  });

  test("the turn tree does not outlive a driver that exits mid-turn", async () => {
    const tag = join(scratch, "orphan");
    const parent = spawnSync(process.execPath, [join(FIXTURES, "turn_orphan_parent.ts"), tag], {
      cwd: scratch,
      timeout: 30_000,
      encoding: "utf8",
    });
    expect(parent.status).toBe(1);
    expect(existsSync(`${tag}.pid`)).toBe(true);
    const gc = grandchildPid(tag);
    expect(await waitFor(() => !alive(gc), 5000)).toBe(true);
  }, 45_000);
});

describe("killProcessTree", () => {
  test("ignores a pid that is not a positive integer", () => {
    expect(() => killProcessTree(0)).not.toThrow();
    expect(() => killProcessTree(-1)).not.toThrow();
    expect(() => killProcessTree(Number.NaN)).not.toThrow();
  });
});

describe("descendantsOf", () => {
  const table = [
    "    1     0",
    "  100     1",
    "  200   100",
    "  201   100",
    "  300   200",
    "  400     1",
    "garbage line",
    "  500   500",
  ].join("\n");

  test("lists every descendant, deepest first, and nothing else", () => {
    expect(descendantsOf(100, table)).toEqual([300, 200, 201]);
    expect(descendantsOf(400, table)).toEqual([]);
  });

  test("survives a self-parented entry", () => {
    expect(descendantsOf(500, table)).toEqual([]);
  });
});
