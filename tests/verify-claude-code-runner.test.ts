import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as config from "../harness/config.ts";
import { flagsForLane, main } from "../harness/runner.ts";
import { addTask, captureStderr, makeSandbox, type Sandbox } from "./fixtures/verify-runner/sandbox.ts";

const STUB = fileURLToPath(new URL("./fixtures/verify-claude-code/stub-lane-driver.mjs", import.meta.url));

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

const stubDriver = (sleepMs: number) => (ws: string, flags: string[]) => [process.execPath, STUB, ws, String(sleepMs), JSON.stringify(flags)];

interface Launch {
  startedAt: number;
  flags: string[];
}
const launchOf = (cell: string, key: string): Launch => JSON.parse(readFileSync(join(sb.runsDir, "run", cell, key, "launch.json"), "utf8"));

/** Run the runner over `keys` of one cell with the stand-in driver; returns the exit code and what it printed. */
async function run(
  cell: string,
  keys: string[],
  flags: string[],
  { sleepMs = 30, env = {} as Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const [bench, pool] = cell.split(":") as [string, string];
  for (const k of keys) addTask(sb.dataDir, bench, pool, k);
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    before[k] = process.env[k];
    process.env[k] = v;
  }
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...parts: unknown[]) => void lines.push(parts.map(String).join(" "));
  try {
    const { result, stderr } = await captureStderr(() =>
      main(["--cells", cell, "--run-name", "run", ...flags], {
        dataDir: sb.dataDir,
        runsDir: sb.runsDir,
        driverCommand: stubDriver(sleepMs),
        pollMs: 20,
      }),
    );
    return { code: result, stdout: lines.join("\n"), stderr };
  } finally {
    console.log = realLog;
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The `lane max {...}` object the runner announced. */
function laneMax(stdout: string): Record<string, number> {
  const m = /lane max (\{[^}]*\})/.exec(stdout);
  expect(m).not.toBeNull();
  return JSON.parse(m![1]!);
}

/** The largest number of drivers that ran at the same instant. */
function peak(cell: string, keys: string[]): number {
  const spans = keys.map((k) => {
    const finish = JSON.parse(readFileSync(join(sb.runsDir, "run", cell, k, "finish.json"), "utf8")) as { finishedAt: number };
    return [launchOf(cell, k).startedAt, finish.finishedAt] as const;
  });
  return Math.max(...spans.map(([t]) => spans.filter(([a, b]) => a <= t && t < b).length));
}

describe("the Claude Code lanes", () => {
  test("every lane names a full model id, so a run does not move with an alias", () => {
    expect(config.LANES.fable).toEqual(["--provider", "claude-code", "--model", "claude-fable-5-1"]);
    expect(config.LANES.opus).toEqual(["--provider", "claude-code", "--model", "claude-opus-5-5"]);
    expect(config.LANES.haiku).toEqual(["--provider", "claude-code", "--model", "claude-haiku-5-5"]);
    expect(config.LANES.sonnet).toEqual(["--provider", "claude-code", "--model", "claude-sonnet-5-5"]);
    expect(flagsForLane("haiku", ["--contract", "artifact"])).toEqual([
      "--provider",
      "claude-code",
      "--model",
      "claude-haiku-5-5",
      "--contract",
      "artifact",
    ]);
  });

  test("the four lanes are fable, opus, haiku and sonnet, and each runs Claude Code", () => {
    expect(Object.keys(config.LANES)).toEqual(["fable", "opus", "haiku", "sonnet"]);
    for (const flags of Object.values(config.LANES)) expect(flags.slice(0, 2)).toEqual(["--provider", "claude-code"]);
  });

  test("a cell on the haiku lane gives its driver the provider, the model and --env none", async () => {
    const { code } = await run("sb2:haiku", ["t1"], ["--env", "none"]);
    expect(code).toBe(0);
    const { flags } = launchOf("sb2_haiku", "t1");
    expect(flags.slice(flags.indexOf("--provider"), flags.indexOf("--provider") + 4)).toEqual([
      "--provider",
      "claude-code",
      "--model",
      "claude-haiku-5-5",
    ]);
    expect(flags.slice(flags.indexOf("--env"), flags.indexOf("--env") + 2)).toEqual(["--env", "none"]);
  });

  test("--env reaches the driver of the fable lane too", async () => {
    await run("sb2:flash", ["t1"], ["--env", "none"]);
    const { flags } = launchOf("sb2_flash", "t1");
    expect(flags.slice(flags.indexOf("--env"), flags.indexOf("--env") + 2)).toEqual(["--env", "none"]);
  });

  test("an archived flash pool runs on the fable lane, and --lane overrides that", async () => {
    const { code, stdout } = await run("sb2:flash", ["t1"], ["--env", "none"]);
    expect(code).toBe(0);
    const { flags } = launchOf("sb2_flash", "t1");
    expect(flags.slice(flags.indexOf("--provider"), flags.indexOf("--provider") + 4)).toEqual([
      "--provider",
      "claude-code",
      "--model",
      "claude-fable-5-1",
    ]);
    expect(JSON.parse(readFileSync(join(sb.runsDir, "run", "sb2_flash", "run.json"), "utf8")).lane).toBe("fable");
    expect(stdout).toContain("sb2/flash");
    sb.cleanup();
    sb = makeSandbox();
    await run("sb2:flash", ["t1"], ["--env", "none", "--lane", "haiku"]);
    expect(launchOf("sb2_flash", "t1").flags).toContain("claude-haiku-5-5");
  });

});

describe("--env none applies to every cell, and the runner warns about the cells that lose the jail", () => {
  test("a pi cell next to a Claude Code cell is named in a warning", async () => {
    addTask(sb.dataDir, "sb2", "flash", "t1");
    // No shipped lane runs pi, so the test makes the fable lane (which checks the flash pool) a pi lane for this one run.
    const shipped = config.LANES.fable;
    config.LANES.fable = ["--provider", "ollama", "--model", "qwen"];
    let result;
    try {
      result = await run("sb2:haiku", ["t1"], ["--cells", "sb2:flash", "--env", "none"]);
    } finally {
      config.LANES.fable = shipped;
    }
    const { code, stderr } = result;
    expect(code).toBe(0);
    const warning = stderr.split(String.fromCharCode(10)).filter((l) => l.includes("WARNING"));
    expect(warning).toHaveLength(1);
    expect(warning[0]).toContain("sb2:flash");
    expect(warning[0]).not.toContain("sb2:haiku");
    expect(warning[0]).toMatch(/without the jail/);
  });

  test("no warning when every cell runs Claude Code, or when no cell does", async () => {
    const only = await run("sb2:haiku", ["t1"], ["--env", "none"]);
    expect(only.stderr).not.toContain("WARNING");
    const pi = await run("sb2:flash", ["t2"], ["--env", "none"]);
    expect(pi.stderr).not.toContain("WARNING");
  });
});

describe("a lane that runs Claude Code needs --env none, and the runner says so before any task", () => {
  for (const env of [[], ["--env", "jail"], ["--env", "native"], ["--env", "native-full"]]) {
    test(`refused with ${env.length ? env.join(" ") : "no --env"}`, async () => {
      const { code, stderr } = await run("sb2:haiku", ["t1"], env);
      expect(code).toBe(2);
      expect(stderr).toContain("lane haiku");
      expect(stderr).toContain("needs --env none");
      expect(existsSync(join(sb.runsDir, "run", "sb2_haiku", "t1"))).toBe(false);
    });
  }

  test("a hosted lane overridden onto claude-code is refused the same way", async () => {
    const { code, stderr } = await run("sb2:flash", ["t1"], ["--provider", "claude-code", "--model", "claude-haiku-4-5-20251001"]);
    expect(code).toBe(2);
    expect(stderr).toContain("needs --env none");
  });

  test("an override onto claude-code drops the lane's --thinking and refuses a setting it cannot honour", async () => {
    const ok = await run("sb2:opus", ["t1"], ["--provider", "claude-code", "--model", "claude-sonnet-5-5", "--env", "none"]);
    expect(ok.code).toBe(0);
    expect(launchOf("sb2_opus", "t1").flags).not.toContain("--thinking");

    const bad = await run("sb2:opus", ["t2"], ["--provider", "claude-code", "--model", "claude-sonnet-5-5", "--env", "none", "--temperature", "0.2"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("--temperature not supported with --provider claude-code");
  });

  test("an unknown --env value is refused", async () => {
    const { code, stderr } = await run("sb2:haiku", ["t1"], ["--env", "container"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--env must be one of");
  });
});

describe("concurrency caps", () => {
  test("the defaults: haiku and sonnet start at 4, fable and opus at 2", async () => {
    const { stdout } = await run("sb2:haiku", ["t1"], ["--env", "none"]);
    expect(laneMax(stdout)).toEqual({ fable: 2, opus: 2, haiku: 4, sonnet: 4 });
  });

  test("--lane-max raises one lane, takes a list, and may repeat", async () => {
    let r = await run("sb2:haiku", ["t1"], ["--env", "none", "--lane-max", "haiku=6"]);
    expect(laneMax(r.stdout)).toMatchObject({ haiku: 6, sonnet: 4, fable: 2 });
    sb.cleanup();
    sb = makeSandbox();
    r = await run("sb2:haiku", ["t1"], ["--env", "none", "--lane-max", "haiku=3,sonnet=5", "--lane-max", "opus=7"]);
    expect(laneMax(r.stdout)).toEqual({ fable: 2, opus: 7, haiku: 3, sonnet: 5 });
  });

  test("--max-fable and --max-opus work, and --lane-max wins over them", async () => {
    const r = await run("sb2:flash", ["t1"], ["--env", "none", "--max-fable", "3", "--max-opus", "4"]);
    expect(laneMax(r.stdout)).toMatchObject({ fable: 3, opus: 4 });
    sb.cleanup();
    sb = makeSandbox();
    const w = await run("sb2:flash", ["t1"], ["--env", "none", "--max-fable", "3", "--lane-max", "fable=6"]);
    expect(laneMax(w.stdout).fable).toBe(6);
  });

  for (const bad of ["fish=2", "flash=2", "haiku", "haiku=", "haiku=0", "haiku=-1", "haiku=2.5", "haiku=two", "=3", `haiku=${"9".repeat(400)}`, "haiku=9007199254740993"]) {
    test(`--lane-max ${bad.slice(0, 30)} is an argument error`, async () => {
      const { code, stderr } = await run("sb2:haiku", ["t1"], ["--env", "none", "--lane-max", bad]);
      expect(code).toBe(2);
      expect(stderr).toContain("--lane-max");
    });
  }

  test("the cap holds: five drivers on the haiku lane never run more than four at once", async () => {
    const keys = ["t1", "t2", "t3", "t4", "t5"];
    const { code } = await run("sb2:haiku", keys, ["--env", "none", "--cell-cap", "sb2=8"], { sleepMs: 500 });
    expect(code).toBe(0);
    expect(peak("sb2_haiku", keys)).toBe(4);
  }, 30_000);

  test("--lane-max haiku=2 holds the lane to two at once", async () => {
    const keys = ["t1", "t2", "t3", "t4", "t5"];
    const { code } = await run("sb2:haiku", keys, ["--env", "none", "--lane-max", "haiku=2", "--cell-cap", "sb2=8"], { sleepMs: 500 });
    expect(code).toBe(0);
    expect(peak("sb2_haiku", keys)).toBe(2);
  }, 30_000);
});

describe("a usage limit stops the lane", () => {
  test("the driver that exits 75 is a usage-limit, and the tasks still queued are lane-stopped and never started", async () => {
    const keys = ["t1", "t2", "t3", "t4"];
    const { code, stdout } = await run("sb2:haiku", keys, ["--env", "none", "--lane-max", "haiku=1"], {
      env: { STUB_LIMIT_KEYS: "t1" },
    });
    expect(code).toBe(1);
    expect(stdout).toContain("t1: usage-limit");
    for (const k of ["t2", "t3", "t4"]) {
      expect(stdout).toContain(`${k}: lane-stopped`);
      expect(existsSync(join(sb.runsDir, "run", "sb2_haiku", k, "launch.json"))).toBe(false);
    }
    expect(stdout).toContain('done: {"usage-limit":1,"lane-stopped":3}');
  }, 30_000);

  test("another lane keeps running", async () => {
    for (const k of ["s1", "s2"]) addTask(sb.dataDir, "sb2", "sonnet", k);
    const { code, stdout } = await run("sb2:haiku", ["h1", "h2"], ["--env", "none", "--cells", "sb2:sonnet", "--lane-max", "haiku=1"], {
      env: { STUB_LIMIT_KEYS: "h1" },
    });
    expect(code).toBe(1);
    expect(stdout).toContain("h1: usage-limit");
    expect(stdout).toContain("h2: lane-stopped");
    expect(stdout).toContain("s1: ok");
    expect(stdout).toContain("s2: ok");
  }, 30_000);

  test("an ordinary failure does not stop the lane", async () => {
    const keys = ["t1", "t2", "t3"];
    const { code, stdout } = await run("sb2:haiku", keys, ["--env", "none", "--lane-max", "haiku=1"], {
      env: { STUB_FAIL_KEYS: "t1" },
    });
    expect(code).toBe(1);
    expect(stdout).toContain("t1: no-finish(rc=1)");
    expect(stdout).toContain("t2: ok");
    expect(stdout).toContain("t3: ok");
    expect(stdout).not.toContain("lane-stopped");
  }, 30_000);
});
