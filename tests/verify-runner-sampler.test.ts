import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fractionCount, main, seededSample } from "../harness/runner.ts";
import { addTask, makeSandbox, type Sandbox } from "./fixtures/verify-runner/sandbox.ts";

// [4178276779] The expected values in sampler.json come from CPython's own random module
// (tests/fixtures/verify-runner/gen_sampler_fixture.py). The tests need no Python.
interface Fixture {
  generator: string;
  mt32: { seed: string; first: number[] }[];
  randbelow: { seed: string; n: number; draws: number[] }[];
  sample: { seed: string; n: number; k: number; branch: "pool" | "set"; expected: number[] }[];
  fraction_count: { n: number; fraction: number; count: number }[];
  select: { n: number; seed: number; sample: number; fraction: number; keys: string[] }[];
}

const fx = JSON.parse(
  readFileSync(new URL("./fixtures/verify-runner/sampler.json", import.meta.url), "utf8"),
) as Fixture;

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("the fixture", () => {
  test("covers both branches of random.sample and a seed wider than 64 bits", () => {
    expect(new Set(fx.sample.map((c) => c.branch))).toEqual(new Set(["pool", "set"]));
    expect(fx.sample.some((c) => BigInt(c.seed) > 2n ** 64n)).toBe(true);
    expect(fx.sample.some((c) => BigInt(c.seed) < 0n)).toBe(true);
  });
});

describe("PyRandom reproduces CPython's Mersenne Twister", () => {
  test("getrandbits(32) matches for every seed width", async () => {
    const { PyRandom } = await import("../harness/pyrandom.ts");
    for (const row of fx.mt32) {
      const rng = new PyRandom(BigInt(row.seed));
      expect(Array.from({ length: row.first.length }, () => rng.getrandbits(32))).toEqual(row.first);
    }
  });

  test("randbelow redraws on rejection exactly as _randbelow does", async () => {
    const { PyRandom } = await import("../harness/pyrandom.ts");
    for (const row of fx.randbelow) {
      const rng = new PyRandom(BigInt(row.seed));
      expect(row.draws.map(() => rng.randbelow(row.n))).toEqual(row.draws);
    }
  });

  test("sample(range(n), k) matches in the pool and set branches", async () => {
    const { PyRandom } = await import("../harness/pyrandom.ts");
    for (const c of fx.sample) {
      const got = new PyRandom(BigInt(c.seed)).sample(range(c.n), c.k);
      expect(got, `seed=${c.seed} n=${c.n} k=${c.k} (${c.branch})`).toEqual(c.expected);
    }
  });

  test("sample rejects a size larger than the population, as Python does", async () => {
    const { PyRandom } = await import("../harness/pyrandom.ts");
    expect(() => new PyRandom(0).sample([1, 2, 3], 4)).toThrow(RangeError);
    expect(() => new PyRandom(0).sample([1, 2, 3], -1)).toThrow(RangeError);
  });
});

describe("runner selection", () => {
  test("seededSample picks the same elements as random.Random(seed).sample", () => {
    for (const c of fx.sample) {
      const seed = Number(c.seed);
      if (!Number.isSafeInteger(seed)) continue; // a CLI seed is a JS number
      expect(seededSample(range(c.n), c.k, seed), `seed=${c.seed} n=${c.n} k=${c.k}`).toEqual(c.expected);
    }
  });

  test("--fraction rounds half to even like Python's round()", () => {
    for (const row of fx.fraction_count) {
      expect(fractionCount(row.n, row.fraction), `n=${row.n} fraction=${row.fraction}`).toBe(row.count);
    }
    // 25 * 0.1 = 2.5: Python picks 2, Math.round picks 3.
    expect(fractionCount(25, 0.1)).toBe(2);
  });

  describe("--sample and --fraction choose the tasks Python chose", () => {
    let sb: Sandbox;
    beforeEach(() => {
      sb = makeSandbox();
    });
    afterEach(() => sb.cleanup());

    for (const row of fx.select) {
      test(`n=${row.n} seed=${row.seed} sample=${row.sample} fraction=${row.fraction}`, async () => {
        for (let i = 0; i < row.n; i++) addTask(sb.dataDir, "sb2", "flash", `t${String(i).padStart(2, "0")}`);
        const argv = ["--cells", "sb2:flash", "--run-name", "run", "--seed", String(row.seed)];
        if (row.sample) argv.push("--sample", String(row.sample));
        if (row.fraction) argv.push("--fraction", String(row.fraction));

        const code = await main(argv, {
          dataDir: sb.dataDir,
          runsDir: sb.runsDir,
          // Selection is what is under test: the stand-in driver does nothing.
          driverCommand: () => [process.execPath, "-e", ""],
        });

        expect(code).toBe(1); // no finish.json from the empty driver; the tasks were still launched
        const run = JSON.parse(readFileSync(join(sb.runsDir, "run", "sb2_flash", "run.json"), "utf8"));
        expect(run.keys).toEqual(row.keys);
      }, 20_000);
    }
  });
});
