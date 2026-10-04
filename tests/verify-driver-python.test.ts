import { describe, expect, test } from "bun:test";

import { python3, pythonFinder } from "../harness/runtime.ts";

type Call = { cmd: string; args: string[]; timeout: number | undefined };
type Reply = { status: number | null; stdout: string };

/** A stand-in for spawnSync: each command name maps to its reply; an unknown name is "not installed". */
function fakeRun(replies: Record<string, Reply>) {
  const calls: Call[] = [];
  const run = ((cmd: string, args: string[], opts: { timeout?: number }) => {
    calls.push({ cmd, args, timeout: opts.timeout });
    return replies[cmd] ?? { status: null, stdout: "" };
  }) as never;
  return { run, calls };
}

describe("pythonFinder", () => {
  test("returns the interpreter path the probe printed", () => {
    const { run } = fakeRun({ python3: { status: 0, stdout: "/usr/bin/python3\n" } });
    expect(pythonFinder(run)()).toBe("/usr/bin/python3");
  });

  test("falls through a python3 that exists but does not work (the Windows Store stub exits 9009)", () => {
    const { run, calls } = fakeRun({
      python3: { status: 9009, stdout: "" },
      python: { status: 0, stdout: "C:\\Python313\\python.exe\n" },
    });
    expect(pythonFinder(run)()).toBe("C:\\Python313\\python.exe");
    expect(calls.map((c) => c.cmd)).toEqual(["python3", "python"]);
  });

  test("tries the py launcher with -3 after python3 and python", () => {
    const { run, calls } = fakeRun({ py: { status: 0, stdout: "C:\\Python314\\python.exe\n" } });
    expect(pythonFinder(run)()).toBe("C:\\Python314\\python.exe");
    expect(calls.at(-1)).toMatchObject({ cmd: "py", args: expect.arrayContaining(["-3"]) });
  });

  test("a probe that prints nothing is not an interpreter", () => {
    const { run } = fakeRun({ python3: { status: 0, stdout: "  \n" }, python: { status: 0, stdout: "/opt/py/bin/python\n" } });
    expect(pythonFinder(run)()).toBe("/opt/py/bin/python");
  });

  test("every probe has a time limit, so a hung interpreter cannot hang the grader", () => {
    const { run, calls } = fakeRun({});
    pythonFinder(run)();
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) {
      expect(c.timeout).toBeGreaterThan(0);
      expect(c.timeout).toBeLessThanOrEqual(60_000);
    }
  });

  test("the probe refuses Python 2", () => {
    const { run, calls } = fakeRun({});
    pythonFinder(run)();
    expect(calls[0]!.args.join(" ")).toContain("version_info");
  });

  test("with no interpreter at all it answers python3, so the caller's own error names it", () => {
    const { run } = fakeRun({});
    expect(pythonFinder(run)()).toBe("python3");
  });

  test("a found interpreter is probed once, however many graders ask", () => {
    const { run, calls } = fakeRun({ python3: { status: 0, stdout: "/usr/bin/python3\n" } });
    const find = pythonFinder(run);
    for (let i = 0; i < 5; i++) find();
    expect(calls).toHaveLength(1);
  });

  test("a miss is not remembered: an interpreter installed later is found", () => {
    const replies: Record<string, Reply> = {};
    const { run } = fakeRun(replies);
    const find = pythonFinder(run);
    expect(find()).toBe("python3");
    replies.python3 = { status: 0, stdout: "/usr/bin/python3\n" };
    expect(find()).toBe("/usr/bin/python3");
  });
});

describe("python3", () => {
  test("is the shared finder and gives a stable answer", () => {
    expect(python3()).toBe(python3());
    expect(python3().length).toBeGreaterThan(0);
  });
});
