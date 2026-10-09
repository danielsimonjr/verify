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
    expect(hit.stderr).toContain("known: fable, opus, haiku, sonnet");
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
      const hit = await runner(["--cells", `wb:${pool}`, "--lane", "fable", "--run-name", "r"]);
      expect(hit.code).toBe(2);
      expect(hit.stderr).toMatch(/pool/);
      expect(hit.runs).toEqual([]);
    });
  }

  test("ordinary names are accepted", async () => {
    for (const ok of ["run1", "Run-2026.10.04_a", "0", "a.b"]) {
      const { result } = await captureStderr(() =>
        within(
          main(["--cells", "sb2:flash", "--run-name", ok, "--env", "none"], {
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

describe("runner --cell-cap", () => {
  // A cap of 0 or NaN makes `inUseCell < cellCap` false forever: the cell never starts and the
  // loop wakes every 3 s for nothing. An unknown key is a typo that would silently do nothing.
  const bad = [
    "sb2=0",
    "sb2=abc",
    "sb2=",
    "sb2",
    "=3",
    "nosuch=3",
    "sb2=1.5",
    "sb2=-1",
    "sb2=3=4",
    "sb2=1e2",
    "sb2=2,wb=0",
    "default=0",
    "SB2=3",
    `sb2=${"9".repeat(400)}`,
    "default=9007199254740993",
  ];
  for (const spec of bad) {
    test(`rejects ${JSON.stringify(spec.slice(0, 40))}`, async () => {
      const hit = await runner(["--cells", "sb2:flash", "--run-name", "r", "--cell-cap", spec]);
      expect(hit.code).toBe(2);
      expect(hit.stderr).toMatch(/--cell-cap/);
      expect(hit.runs).toEqual([]);
    });
  }

  test("accepts bench keys and default, with spaces and a trailing comma", async () => {
    const { result } = await captureStderr(() =>
      within(
        main(["--cells", "sb2:flash", "--run-name", "r", "--env", "none", "--cell-cap", "sb2=2, default=3,"], {
          dataDir: sb.dataDir,
          runsDir: sb.runsDir,
          driverCommand: () => [process.execPath, "-e", ""],
        }),
        5000,
      ),
    );
    expect(result).toBe(1); // the empty driver writes no finish.json; the caps were accepted
    const run = JSON.parse(readFileSync(join(sb.runsDir, "r", "sb2_flash", "run.json"), "utf8"));
    expect(run.cell_cap).toBe(2);
  });
});

describe("runner --role", () => {
  test("a bad --role exits 2 and schedules nothing", async () => {
    const hit = await runner(["--cells", "sb2:flash", "--run-name", "r", "--env", "none", "--role", "boss=ollama:m"]);
    expect(hit.code).toBe(2);
    expect(hit.stderr).toMatch(/unknown role 'boss'/);
    expect(hit.runs).toEqual([]);
  });

  test("a role option the driver refuses is refused before any task starts", async () => {
    const hit = await runner([
      "--cells", "sb2:flash", "--run-name", "r", "--env", "none",
      "--role", "reviewer=claude-code:claude-opus-5-5", "--role-context-size", "reviewer=8192",
    ]);
    expect(hit.code).toBe(2);
    expect(hit.stderr).toMatch(/--role-context-size reviewer: not supported with claude-code/);
    expect(hit.runs).toEqual([]);
  });

  test("the role options reach every driver and the roles are recorded in run.json", async () => {
    const { result } = await captureStderr(() =>
      within(
        main(
          [
            "--cells", "sb2:flash", "--run-name", "r", "--env", "none",
            "--role", "checker=ollama:qwen3.5:9b", "--role-base-url", "checker=http://h:11434",
            "--role-context-size", "checker=32768", "--role", "reviewer=claude-code:claude-opus-5-5",
          ],
          { dataDir: sb.dataDir, runsDir: sb.runsDir, driverCommand: () => [process.execPath, "-e", ""] },
        ),
        5000,
      ),
    );
    expect(result).toBe(1); // the empty driver writes no finish.json; the roles were accepted
    const run = JSON.parse(readFileSync(join(sb.runsDir, "r", "sb2_flash", "run.json"), "utf8"));
    expect(run.driver_args).toEqual(
      expect.arrayContaining([
        "--role", "checker=ollama:qwen3.5:9b", "--role-base-url", "checker=http://h:11434",
        "--role-context-size", "checker=32768", "--role", "reviewer=claude-code:claude-opus-5-5",
      ]),
    );
    expect(run.roles).toEqual({
      checker: { provider: "ollama", model: "qwen3.5:9b", baseUrl: "http://h:11434", contextSize: 32768 },
      reviewer: { provider: "claude-code", model: "claude-opus-5-5" },
    });
  });
});

describe("runner numeric options", () => {
  // Number("abc") is NaN and every one of these then fails quietly: a lane max of NaN or 0 starts
  // no task, and a NaN --sample or --fraction means "no sampling": the whole task set runs.
  const bad: [string, string][] = [
    ["--max-fable", "0"],
    ["--max-fable", "abc"],
    ["--max-opus", "-1"],
    ["--max-opus", "2.5"],
    ["--limit", "-1"],
    ["--limit", "x"],
    ["--sample", "1.5"],
    ["--sample", "-3"],
    ["--sample", "ten"],
    ["--fraction", "abc"],
    ["--fraction", "NaN"],
    ["--fraction", "1.5"],
    ["--fraction", "-0.1"],
    ["--fraction", ""],
    ["--skip-inflight", "x"],
    ["--skip-inflight", "-5"],
    ["--turn-timeout", "0"],
    ["--turn-timeout", "abc"],
    ["--task-timeout", "-1"],
  ];
  for (const [flag, value] of bad) {
    test(`${flag} ${JSON.stringify(value)} is rejected`, async () => {
      const hit = await runner(["--cells", "sb2:flash", "--run-name", "r", flag, value]);
      expect(hit.code).toBe(2);
      expect(hit.stderr).toContain(flag);
      expect(hit.runs).toEqual([]);
    });
  }

  test("valid values are accepted and recorded", async () => {
    const { result } = await captureStderr(() =>
      within(
        main(
          [
            "--cells", "sb2:flash", "--run-name", "r", "--env", "none",
            "--max-fable", "3", "--max-opus", "4", "--limit", "5", "--sample", "0", "--fraction", "1",
            "--skip-inflight", "0", "--turn-timeout", "60", "--task-timeout", "600",
          ],
          { dataDir: sb.dataDir, runsDir: sb.runsDir, driverCommand: () => [process.execPath, "-e", ""] },
        ),
        5000,
      ),
    );
    expect(result).toBe(1);
    const run = JSON.parse(readFileSync(join(sb.runsDir, "r", "sb2_flash", "run.json"), "utf8"));
    expect(run.lane_max).toMatchObject({ fable: 3, opus: 4 });
    expect(run.driver_args).toEqual(expect.arrayContaining(["--turn-timeout", "60", "--task-timeout", "600"]));
  });
});
