import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "../harness/runner.ts";
import { addTask, makeSandbox, writeXlsx, type Sandbox } from "./fixtures/verify-runner/sandbox.ts";

const STUB = fileURLToPath(new URL("./fixtures/verify-runner/stub-driver.mjs", import.meta.url));

let sb: Sandbox;

beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

/** The stub driver sleeps `sleepMs` per task and contacts no model. */
const stubDriver = (sleepMs: number) => (ws: string) => [process.execPath, STUB, ws, String(sleepMs)];

interface Launch {
  views: string[];
  startedAt: number;
  finishedAt: number;
}

function launchOf(cell: string, key: string): Launch {
  const ws = join(sb.runsDir, "run", cell, key);
  const launch = JSON.parse(readFileSync(join(ws, "launch.json"), "utf8"));
  const finish = JSON.parse(readFileSync(join(ws, "finish.json"), "utf8"));
  return { views: launch.views, startedAt: launch.startedAt, finishedAt: finish.finishedAt };
}

/** The largest number of [start, finish] intervals that were open at the same instant. */
function peakOverlap(runs: Launch[]): number {
  const events = runs.flatMap((r) => [
    { t: r.startedAt, d: 1 },
    { t: r.finishedAt, d: -1 },
  ]);
  events.sort((a, b) => a.t - b.t || a.d - b.d);
  let open = 0;
  let peak = 0;
  for (const e of events) {
    open += e.d;
    peak = Math.max(peak, open);
  }
  return peak;
}

describe("runner scheduling", () => {
  // [4178276738] renderViews is async. runTask discarded the promises and blocked in spawnSync
  // right after, so the views could not finish until the driver had exited: the verifier ran
  // without the evidence files the renders were meant to create.
  test("views are rendered before the driver starts", async () => {
    const dir = addTask(sb.dataDir, "sb2", "flash", "t1");
    await writeXlsx(join(dir, "workspace", "book.xlsx"));
    await writeXlsx(join(dir, "rollouts", "r01", "result.xlsx"));

    const code = await main(["--cells", "sb2:flash", "--run-name", "run", "--env", "none"], {
      dataDir: sb.dataDir,
      runsDir: sb.runsDir,
      driverCommand: stubDriver(50),
    });

    expect(code).toBe(0);
    expect(launchOf("sb2_flash", "t1").views.sort()).toEqual([
      "rollouts/r01/result.xlsx.cells.tsv",
      "workspace/book.xlsx.cells.tsv",
    ]);
  }, 20_000);

  // [4178276762] runTask blocked in spawnSync until the whole driver finished. A worker runs
  // synchronously up to its first await, so no other task could start meanwhile: the lane and
  // cell concurrency collapsed to one task at a time.
  test("tasks overlap: four 1 s drivers finish in about one second, not four", async () => {
    const keys = ["t1", "t2", "t3", "t4"];
    for (const k of keys) addTask(sb.dataDir, "sb2", "flash", k);

    const t0 = Date.now();
    const code = await main(["--cells", "sb2:flash", "--run-name", "run", "--env", "none", "--lane-max", "fable=4"], {
      dataDir: sb.dataDir,
      runsDir: sb.runsDir,
      driverCommand: stubDriver(1000),
    });
    const wall = Date.now() - t0;

    expect(code).toBe(0);
    const runs = keys.map((k) => launchOf("sb2_flash", k));
    expect(peakOverlap(runs)).toBe(4);
    expect(wall).toBeLessThan(2500); // serial would be at least 4000
  }, 20_000);

  test("the cell cap bounds how many tasks run at once", async () => {
    const keys = ["t1", "t2", "t3", "t4", "t5", "t6"];
    for (const k of keys) addTask(sb.dataDir, "sb2", "flash", k);

    const code = await main(["--cells", "sb2:flash", "--run-name", "run", "--env", "none", "--cell-cap", "sb2=2"], {
      dataDir: sb.dataDir,
      runsDir: sb.runsDir,
      driverCommand: stubDriver(300),
      pollMs: 50,
    });

    expect(code).toBe(0);
    const runs = keys.map((k) => launchOf("sb2_flash", k));
    expect(peakOverlap(runs)).toBe(2);
  }, 20_000);

  test("an explicit known --lane runs a pool that names no lane", async () => {
    addTask(sb.dataDir, "sb2", "mine", "t1");
    const code = await main(["--cells", "sb2:mine", "--lane", "fable", "--run-name", "run", "--env", "none"], {
      dataDir: sb.dataDir,
      runsDir: sb.runsDir,
      driverCommand: stubDriver(10),
    });
    expect(code).toBe(0);
    expect(launchOf("sb2_mine", "t1").views).toEqual([]);
  }, 20_000);

  test("a driver that never writes finish.json is reported, not hidden", async () => {
    addTask(sb.dataDir, "sb2", "flash", "t1");
    const code = await main(["--cells", "sb2:flash", "--run-name", "run", "--env", "none"], {
      dataDir: sb.dataDir,
      runsDir: sb.runsDir,
      driverCommand: (ws) => [process.execPath, "-e", "process.exit(3)", ws],
    });
    expect(code).toBe(1);
  }, 20_000);
});
