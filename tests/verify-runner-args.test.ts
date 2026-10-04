import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";

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
