import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as config from "../harness/config.ts";
import {
  POSIX_ARG_LIMIT,
  WINDOWS_COMMAND_LINE_LIMIT,
  fitsCommandLine,
  piCommandFor,
  planPiCommand,
  windowsCommandLineLength,
} from "../harness/driver.ts";
import { runWithBudget } from "../harness/runtime.ts";
import { STUB_PI, makeRig, piHappyRules, type Rig } from "./fixtures/verify-claude-code/rig.ts";

let rig: Rig;
beforeEach(() => {
  rig = makeRig();
});
afterEach(() => rig.cleanup());

describe("the operating system's limit on one command line", () => {
  // The failure these tests guard against: the pi turn put the whole message and the whole charter on the
  // command line, and a task with mounted skills has a message of about 75 KB. This is what the platform does
  // with such a line. It is the control for everything below: if it did not fail here, there would be nothing to fix.
  const tooLong = process.platform === "win32" ? 40_000 : 140_000;

  test("a command line over the limit does not start, and one under it does", async () => {
    const run = (size: number) =>
      runWithBudget([process.execPath, "-e", "0", "x".repeat(size)], { cwd: rig.root, env: process.env, budgetMs: 30_000 });
    const over = await run(tooLong);
    expect(over.spawnError).toBeDefined();
    expect(over.code).toBeNull();
    const under = await run(20_000);
    expect(under.spawnError).toBeUndefined();
    expect(under.code).toBe(0);
  });

  test("windowsCommandLineLength counts the quotes Node adds and the characters it escapes", () => {
    expect(windowsCommandLineLength(["a"])).toBe(3);
    expect(windowsCommandLineLength(["a", "b"])).toBe(7);
    // A space makes Node quote the argument; each quote or backslash in it can double.
    expect(windowsCommandLineLength(["a b"])).toBeGreaterThanOrEqual(5);
    expect(windowsCommandLineLength(['"'])).toBeGreaterThan(windowsCommandLineLength(["x"]));
    expect(windowsCommandLineLength(["\\\\"])).toBeGreaterThan(windowsCommandLineLength(["xx"]));
  });

  test("fitsCommandLine uses the limit of the platform it is asked about", () => {
    const line = [process.execPath, "-p", "--", "m".repeat(50_000)];
    expect(fitsCommandLine(line, "win32")).toBe(false);
    expect(fitsCommandLine(line, "linux")).toBe(true);
    expect(fitsCommandLine([process.execPath, "m".repeat(POSIX_ARG_LIMIT)], "linux")).toBe(false);
    expect(fitsCommandLine([process.execPath, "m".repeat(WINDOWS_COMMAND_LINE_LIMIT)], "win32")).toBe(false);
    expect(fitsCommandLine([process.execPath, "m".repeat(1000)], "win32")).toBe(true);
  });
});

describe("planPiCommand", () => {
  const flags = ["--tools", "read,bash", "--session-dir", "/ws/session", "--system-prompt", "the charter"];
  const files: Record<string, string> = {};
  const writeFile = (name: string, text: string): string => {
    files[name] = text;
    return `/ws/session/${name}`;
  };
  const plan = (over: Partial<Parameters<typeof planPiCommand>[0]> = {}) => {
    for (const k of Object.keys(files)) delete files[k];
    return planPiCommand({
      piCommand: ["pi"],
      flags,
      message: "short message",
      continueSession: false,
      canPipe: true,
      writeFile,
      platform: "win32",
      ...over,
    });
  };

  test("a message that fits goes on the command line, as it always did", () => {
    expect(plan()).toEqual({ cmd: ["pi", "-p", ...flags, "--", "short message"], via: "argv" });
    expect(plan({ continueSession: true }).cmd).toEqual(["pi", "-p", ...flags, "-c", "--", "short message"]);
    expect(Object.keys(files)).toEqual([]);
  });

  test("on Windows a message over the limit goes to stdin, and the command line holds no message", () => {
    const message = "m".repeat(75_000);
    const p = plan({ message });
    expect(p.via).toBe("stdin");
    expect(p.input).toBe(message);
    expect(p.cmd).toEqual(["pi", "-p", ...flags]);
    expect(fitsCommandLine(p.cmd, "win32")).toBe(true);
  });

  test("on Linux the limit is per argument: 75 KB fits, 150 KB does not", () => {
    expect(plan({ platform: "linux", message: "m".repeat(75_000) }).via).toBe("argv");
    const big = "m".repeat(150_000);
    const p = plan({ platform: "linux", message: big });
    expect(p.via).toBe("stdin");
    expect(p.input).toBe(big);
  });

  test("where stdin cannot reach pi (the jail, a container) the message goes in a file named by an @ argument", () => {
    const message = "m".repeat(75_000);
    const p = plan({ message, canPipe: false });
    expect(p.via).toBe("file");
    expect(p.input).toBeUndefined();
    expect(p.cmd.slice(-2)).toEqual(["--", "@/ws/session/turn-message.md"]);
    expect(files["turn-message.md"]).toBe(message);
    expect(fitsCommandLine(p.cmd, "win32")).toBe(true);
  });

  test("a continuing turn keeps -c with every way of carrying the message", () => {
    const message = "m".repeat(75_000);
    expect(plan({ message, continueSession: true }).cmd).toContain("-c");
    expect(plan({ message, continueSession: true, canPipe: false }).cmd).toContain("-c");
  });

  test("when the flags alone are too long, the charter goes to a file pi reads as a path", () => {
    const charter = "c".repeat(40_000);
    const bigFlags = ["--tools", "read", "--session-dir", "/ws/session", "--system-prompt", charter];
    const p = plan({ flags: bigFlags, message: "m".repeat(75_000) });
    expect(p.via).toBe("stdin");
    expect(p.cmd[p.cmd.indexOf("--system-prompt") + 1]).toBe("/ws/session/system-prompt.md");
    expect(files["system-prompt.md"]).toBe(charter);
    expect(fitsCommandLine(p.cmd, "win32")).toBe(true);
  });

  test("when nothing makes the line fit, it says so with the sizes instead of failing to start", () => {
    const skills = Array.from({ length: 4000 }, (_, i) => ["--skill", `/skills/evidence-number-${i}`]).flat();
    expect(() => plan({ flags: [...flags, ...skills], message: "m".repeat(75_000) })).toThrow(
      /pi command line is too long to start \(\d+ characters; win32 allows 32767\)/,
    );
  });

  test("the old command line, with the message and the charter in it, did not fit; the planned one does", () => {
    const message = "m".repeat(75_000);
    const old = ["pi", "-p", ...flags, "--", message];
    expect(windowsCommandLineLength(old)).toBeGreaterThan(WINDOWS_COMMAND_LINE_LIMIT);
    expect(windowsCommandLineLength(plan({ message }).cmd)).toBeLessThan(WINDOWS_COMMAND_LINE_LIMIT);
  });
});

describe("how pi is started", () => {
  test("a pi the user named is run as given, on every platform", () => {
    expect(piCommandFor("/opt/pi/bin/pi", "win32")).toEqual(["/opt/pi/bin/pi"]);
    expect(piCommandFor("/opt/pi/bin/pi", "linux")).toEqual(["/opt/pi/bin/pi"]);
  });

  test("the default install is run directly off Windows", () => {
    expect(piCommandFor(config.PI_BIN, "linux")).toEqual([config.PI_BIN]);
    expect(piCommandFor(config.PI_BIN, "darwin")).toEqual([config.PI_BIN]);
  });

  test("on Windows the default install runs its entry script with Node, because .bin/pi is a shell script", () => {
    expect(config.PI_CLI_JS.replace(/\\/g, "/")).toMatch(/vendor\/node_modules\/@danielsimonjr\/pi\/dist\/bundle\/cli\.js$/);
    const cmd = piCommandFor(config.PI_BIN, "win32");
    if (existsSync(config.PI_CLI_JS)) {
      expect(cmd).toHaveLength(2);
      expect(cmd[1]).toBe(config.PI_CLI_JS);
    } else {
      // pi is not installed in this checkout: nothing to redirect.
      expect(cmd).toEqual([config.PI_BIN]);
    }
  });
});

describe("a pi task through the stand-in pi", () => {
  const ARGS = ["--provider", "stub", "--model", "stub-model", "--env", "none"];
  const piCommand = [process.execPath, STUB_PI];

  /** A skill whose text is longer than any command line the platforms accept. */
  function bigSkill(bytes: number): string {
    const dir = join(rig.root, "skills", "evidence-big");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: evidence-big\ndescription: a long skill\n---\n${"filler line\n".repeat(Math.ceil(bytes / 12))}`);
    return dir;
  }

  test("a mission with skills too long for a command line reaches pi on stdin, and every record lands", async () => {
    rig.script(piHappyRules(rig.ws));
    const skill = bigSkill(200_000);
    const code = await rig.run([...ARGS, "--skill", skill], {}, { piCommand });
    expect(code).toBe(0);
    const calls = rig.piCalls();
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.via).toBe("stdin");
      expect(call.message.length).toBeGreaterThan(200_000);
      expect(call.longestArgument).toBeLessThan(20_000);
      expect(call.argv).toContain("-p");
      expect(call.argv.at(-1)).not.toBe("--");
    }
    const finish = JSON.parse(readFileSync(join(rig.ws, "finish.json"), "utf8"));
    expect(finish.repair.valid).toBe(true);
  }, 60_000);

  test("a short mission still goes on the command line", async () => {
    rig.script(piHappyRules(rig.ws));
    expect(await rig.run([...ARGS, "--no-skills"], {}, { piCommand })).toBe(0);
    for (const call of rig.piCalls()) {
      expect(call.via).toBe("argv");
      expect(call.stdin).toBe("");
      expect(call.argv.at(-1)).toBe(call.message);
    }
  });

  // C7. The retry path asked whether a session file existed with readdirSync on the session directory, which
  // throws when a failed start left the directory absent. The guard is in hasSessionFile; this runs the whole
  // retry through a pi that fails once and removes its session directory, as a crash during start can.
  test("a transient failure that leaves no session directory is retried without -c, not crashed", async () => {
    rig.script([
      {
        match: "# Discrimination",
        times: 1,
        action: { removeSessionDir: true, stderr: "API Error: 529 overloaded_error", exit: 1 },
      },
      ...piHappyRules(rig.ws),
    ]);
    expect(await rig.run([...ARGS, "--no-skills"], {}, { piCommand })).toBe(0);
    const attempts = rig.piCalls().filter((c) => c.message.includes("# Discrimination"));
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.argv).not.toContain("-c");
    expect(attempts[1]!.argv).not.toContain("-c");
    expect(rig.log()).toContain("transient provider error; retrying in 0s");
  });

  test("when pi saved a session before it failed, the retry continues it with -c", async () => {
    // The first attempt exits before pi writes its transcript, so a session file is put there beforehand.
    const dir = join(rig.ws, "session", "elim");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "earlier.jsonl"), "{}\n");
    rig.script([
      { match: "# Discrimination", times: 1, action: { stderr: "API Error: 529 overloaded_error", exit: 1 } },
      ...piHappyRules(rig.ws),
    ]);
    expect(await rig.run([...ARGS, "--no-skills"], {}, { piCommand })).toBe(0);
    const attempts = rig.piCalls().filter((c) => c.message.includes("# Discrimination"));
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.argv).not.toContain("-c");
    expect(attempts[1]!.argv).toContain("-c");
  });

  // Only Windows has a line limit that a long --skill list exceeds: Linux accepts the same task.
  test.skipIf(process.platform !== "win32")("a command line that cannot be made to fit is a clean failure of the turn, with the reason in the log", async () => {
    rig.script(piHappyRules(rig.ws));
    // Long folder names keep the count low. 1,500 short ones took 8.5 s to create and up to 6.2 s to
    // delete on Windows, and the delete ran in the cleanup hook, which has 5 s.
    const root = join(rig.root, "many");
    const dirOf = (i: number) => join(root, `evidence-${String(i).padStart(4, "0")}-${"x".repeat(100)}`);
    const perSkill = windowsCommandLineLength(["--skill", dirOf(0)]) + 1;
    const many = Array.from({ length: Math.ceil((1.5 * WINDOWS_COMMAND_LINE_LIMIT) / perSkill) }, (_, i) => {
      const dir = dirOf(i);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: s${i}\ndescription: d\nphase: none\n---\nx`);
      return dir;
    });
    // The --skill flags alone are over the limit, so neither stdin nor a charter file can make the line fit.
    expect(windowsCommandLineLength(many.flatMap((d) => ["--skill", d]))).toBeGreaterThan(WINDOWS_COMMAND_LINE_LIMIT);
    try {
      const argv = [...ARGS, ...many.flatMap((d) => ["--skill", d])];
      expect(await rig.run(argv, {}, { piCommand })).toBe(1);
      expect(rig.log()).toContain("pi did not start: the pi command line is too long to start");
      expect(rig.piCalls()).toHaveLength(0);
    } finally {
      // Inside this test's own bound, not the cleanup hook's.
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
