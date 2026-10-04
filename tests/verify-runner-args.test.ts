import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { main } from "../harness/runner.ts";
import { addTask, captureStderr, makeSandbox, within, type Sandbox } from "./fixtures/verify-runner/sandbox.ts";

let sb: Sandbox;

beforeEach(() => {
  sb = makeSandbox();
  addTask(sb.dataDir, "sb2", "flash", "t1");
});
afterEach(() => sb.cleanup());

/** A stub driver that must never run in an argument test: validation has to stop first. */
const neverRun = (): string[] => {
  throw new Error("driver launched: the arguments were not rejected before scheduling");
};

async function runner(argv: string[]) {
  const { result, stderr } = await captureStderr(() =>
    within(main(argv, { dataDir: sb.dataDir, runsDir: sb.runsDir, driverCommand: neverRun }), 1500),
  );
  return { code: result, stderr, runs: readdirSync(sb.runsDir) };
}

describe("runner --lane", () => {
  // [4178276582] An unknown lane left the scheduler with undefined counters and caps, so its
  // capacity test was never true and the loop slept forever without launching any work.
  test("an unknown --lane exits 2 and schedules nothing", async () => {
    const hit = await runner(["--cells", "sb2:flash", "--run-name", "r", "--lane", "nope"]);
    expect(hit.code).toBe(2);
    expect(hit.stderr).toMatch(/unknown lane 'nope'/);
    expect(hit.stderr).toContain("flash");
    expect(hit.runs).toEqual([]);
  });

  test("inherited object keys are not lanes", async () => {
    for (const lane of ["constructor", "toString", "__proto__"]) {
      const hit = await runner(["--cells", "sb2:flash", "--run-name", "r", "--lane", lane]);
      expect(hit.code).toBe(2);
    }
  });

  test("a pool that names no lane still needs --lane, and inherited keys do not count as pools", async () => {
    const hit = await runner(["--cells", "sb2:mine", "--run-name", "r"]);
    expect(hit.code).toBe(2);
    expect(hit.stderr).toMatch(/names no lane/);
    const inherited = await runner(["--cells", "sb2:constructor", "--run-name", "r"]);
    expect(inherited.code).toBe(2);
    expect(inherited.stderr).toMatch(/names no lane/);
  });
});

describe("runner --seed", () => {
  // The sampler needs an integer seed, as the original argparse type=int required. Number()
  // turned a typo into NaN and the run went on with a seed nobody chose.
  for (const bad of ["abc", "1.5", "", "1e3", "0x10", "9007199254740993"]) {
    test(`rejects '${bad}'`, async () => {
      const hit = await runner(["--cells", "sb2:flash", "--run-name", "r", "--seed", bad]);
      expect(hit.code).toBe(2);
      expect(hit.stderr).toMatch(/--seed/);
      expect(hit.runs).toEqual([]);
    });
  }
});

describe("runner path segments", () => {
  // run_name and each cell pool are joined under the runs and data directories, and runTask
  // removes an existing task workspace there. A value that is not one path segment reaches
  // outside them.
  test("a --run-name that climbs out of the runs dir deletes nothing outside it", async () => {
    // <root>/outside/sb2_flash/t1 is where "../outside" would resolve a task workspace.
    const victim = join(sb.outside, "sb2_flash", "t1");
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "precious.txt"), "keep");

    const hit = await runner(["--cells", "sb2:flash", "--run-name", "../outside"]);

    expect(existsSync(join(victim, "precious.txt"))).toBe(true);
    expect(readFileSync(join(victim, "precious.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(sb.outside, "sb2_flash", "run.json"))).toBe(false);
    expect(hit.code).toBe(2);
    expect(hit.stderr).toMatch(/--run-name/);
  });

  const badSegments = ["..", ".", "../x", "a/b", "a\b", ".hidden", "", "x y", "x\0y", "/abs", "C:\abs", "-x"];
  for (const name of badSegments) {
    test(`--run-name ${JSON.stringify(name)} is rejected`, async () => {
      const hit = await runner(["--cells", "sb2:flash", "--run-name", name]);
      expect(hit.code).toBe(2);
      expect(hit.runs).toEqual([]);
    });
  }

  // The pool names a data directory (<data>/<bench>/<pool>/tasks) and, with --lane, no lane.
  for (const pool of ["..", "../x", "a/b", "a\b", ".hidden", "a:b", ""]) {
    test(`a cell pool ${JSON.stringify(pool)} is rejected`, async () => {
      addTask(sb.dataDir, "sb2", "x", "t1"); // <data>/sb2/../x/tasks resolves here
      const hit = await runner(["--cells", `wb:${pool}`, "--lane", "flash", "--run-name", "r"]);
      expect(hit.code).toBe(2);
      expect(hit.stderr).toMatch(/pool/);
      expect(hit.runs).toEqual([]);
    });
  }

  test("ordinary names are accepted", async () => {
    for (const ok of ["run1", "Run-2026.10.04_a", "0", "a.b"]) {
      const { result } = await captureStderr(() =>
        within(
          main(["--cells", "sb2:flash", "--run-name", ok], {
            dataDir: sb.dataDir,
            runsDir: sb.runsDir,
            driverCommand: () => [process.execPath, "-e", ""],
          }),
          5000,
        ),
      );
      expect(result, ok).toBe(1); // the empty driver writes no finish.json; the name was accepted
    }
  });
});
