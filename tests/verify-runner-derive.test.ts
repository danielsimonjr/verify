import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { STACK, deriveImages, main } from "../harness/env/derive.ts";
import { captureStderr } from "./fixtures/verify-runner/sandbox.ts";

const STUB = fileURLToPath(new URL("./fixtures/verify-runner/stub-docker.mjs", import.meta.url));

let dir: string;
let logFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vr-derive-"));
  logFile = join(dir, "docker.log");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The stub docker as an argv prefix; it contacts no daemon. */
function stubDocker(opts: { sleepMs?: number; barrier?: number; existing?: string[]; fail?: string[] } = {}): string[] {
  return [
    process.execPath,
    STUB,
    `--sleep-ms=${opts.sleepMs ?? 0}`,
    `--barrier=${opts.barrier ?? 0}`,
    `--existing=${(opts.existing ?? []).join(",")}`,
    `--fail=${(opts.fail ?? []).join(",")}`,
    `--log=${logFile}`,
  ];
}

interface Event {
  pid: number;
  t: number;
  ev: "start" | "end" | "gave-up";
  tag: string;
  dockerfile?: string;
}

function events(): Event[] {
  try {
    return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** The most builds that were open at once. */
function peakBuilds(): number {
  let open = 0;
  let peak = 0;
  const builds = events().filter((e) => e.ev !== "gave-up");
  for (const e of builds.sort((a, b) => a.t - b.t || (a.ev === "end" ? -1 : 1))) {
    open += e.ev === "start" ? 1 : -1;
    peak = Math.max(peak, open);
  }
  return peak;
}

const bases = (n: number) => Array.from({ length: n }, (_, i) => `registry.example/team/task${i}:latest`);

describe("env-derive builds", () => {
  // [4178276686] build() blocked in spawnSync, so the async callback never yielded and mapPool
  // could not overlap anything: --jobs 8 still built one image at a time. The barrier holds every
  // build until four have started, so the count does not depend on the host's speed; a serial pool
  // reaches 1.
  test("--jobs 4 runs four builds at once", async () => {
    const lines = await deriveImages(bases(4), 4, stubDocker({ barrier: 4 }));

    expect(lines).toEqual([0, 1, 2, 3].map((i) => `vh/task${i}: ok`));
    expect(peakBuilds()).toBe(4);
    expect(events().some((e) => e.ev === "gave-up")).toBe(false);
  }, 20_000);

  // The barrier makes the first two builds overlap; the sleep keeps each build open long enough
  // that a pool which ignored --jobs would show more than two.
  test("--jobs bounds how many builds run at once", async () => {
    await deriveImages(bases(6), 2, stubDocker({ barrier: 2, sleepMs: 300 }));
    expect(events().filter((e) => e.ev === "start")).toHaveLength(6);
    expect(peakBuilds()).toBe(2);
  }, 20_000);

  test("reports exists, ok and FAILED per image, in input order", async () => {
    const [a, b, c] = bases(3);
    const lines = await deriveImages([a!, b!, c!], 3, stubDocker({ existing: ["vh/task0"], fail: ["vh/task2"], sleepMs: 50 }));

    expect(lines[0]).toBe("vh/task0: exists");
    expect(lines[1]).toBe("vh/task1: ok");
    expect(lines[2]).toMatch(/^vh\/task2: FAILED .*boom: vh\/task2/s);
    // An image that already exists is not rebuilt.
    expect(events().filter((e) => e.ev === "start").map((e) => e.tag).sort()).toEqual(["vh/task1", "vh/task2"]);
  }, 20_000);

  test("keeps only the last 200 characters of a failing build's stderr", async () => {
    const [line] = await deriveImages(bases(1), 1, stubDocker({ fail: ["vh/task0"] }));
    expect(line!.length).toBeLessThanOrEqual("vh/task0: FAILED ".length + 200);
    expect(line).toContain("boom: vh/task0");
  }, 20_000);

  test("sends the task image plus the tool stack as the Dockerfile on stdin", async () => {
    await deriveImages(["registry.example/team/task0:latest"], 1, stubDocker());
    const [start] = events();
    expect(start!.dockerfile).toBe(
      `FROM registry.example/team/task0:latest\nRUN python3 -m pip install --no-cache-dir -q ${STACK} || pip install --no-cache-dir -q ${STACK} || true\n`,
    );
  }, 20_000);

  test("a build past its timeout is reported FAILED and the docker process is killed", async () => {
    // The stub must start and record its pid before the kill. 300 ms was shorter than a Bun start on
    // a loaded Windows host, and then no event was recorded at all.
    const lines = await deriveImages(bases(1), 1, stubDocker({ sleepMs: 60_000 }), 2_000);
    expect(lines[0]).toMatch(/^vh\/task0: FAILED .*timed out/);

    const evs = events();
    expect(evs.map((e) => e.ev)).toEqual(["start"]); // it started, and was killed before it ended
    expect(() => process.kill(evs[0]!.pid, 0)).toThrow(); // no such process
  }, 20_000);

  test("a missing docker binary is a per-image failure, not a crash", async () => {
    const lines = await deriveImages(bases(2), 2, ["vr-no-such-docker-binary"]);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatch(/^vh\/task\d: FAILED /);
  }, 20_000);
});

describe("env-derive --jobs", () => {
  // Number("abc") is NaN; mapPool then starts no workers, builds nothing and exits 0.
  for (const bad of ["abc", "0", "-2", "1.5", "", "9".repeat(400), "9007199254740993"]) {
    test(`rejects '${bad.slice(0, 20)}' (${bad.length} chars)`, async () => {
      const { result, stderr } = await captureStderr(() => main(["--jobs", bad]));
      expect(result).toBe(2);
      expect(stderr).toMatch(/--jobs/);
    });
  }

  test("rejects --jobs with no value", async () => {
    const { result } = await captureStderr(() => main(["--jobs"]));
    expect(result).toBe(2);
  });
});
