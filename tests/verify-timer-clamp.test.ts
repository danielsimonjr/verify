import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { deriveImages } from "../harness/env/derive.ts";
import { run } from "../harness/grade/proc.ts";
import { HttpClient } from "../harness/model/http.ts";
import { MAX_TIMER_MS } from "../harness/timer.ts";

// Node fires a timer at once when its delay is above 2^31-1 ms (with a TimeoutOverflowWarning); Bun
// does not. The shipped CLI runs on Node, so under Bun the test records the delays instead.
const realSetTimeout = globalThis.setTimeout;
let delays: number[] = [];

beforeEach(() => {
  delays = [];
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    delays.push(Number(ms ?? 0));
    return (realSetTimeout as (...a: unknown[]) => unknown)(fn, ms, ...rest);
  }) as unknown as typeof setTimeout;
});
afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
});

const tooLong = 2 ** 31;
const overflowing = (): number[] => delays.filter((d) => d > MAX_TIMER_MS);

describe("a caller-supplied timeout never exceeds the timer limit", () => {
  test("HttpClient request timeout", async () => {
    const client = new HttpClient({
      timeoutMs: tooLong,
      retries: 0,
      fetch: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    });
    await client.send("http://127.0.0.1:9/x", {});
    expect(delays.length).toBeGreaterThan(0);
    expect(overflowing()).toEqual([]);
  });

  test("grade run: the run timer and the stop timer", async () => {
    const r = await run(process.execPath, ["-e", "0"], { timeoutMs: tooLong, stopWaitMs: tooLong, env: process.env });
    expect(r.status).toBe(0);
    expect(delays.length).toBeGreaterThan(0);
    expect(overflowing()).toEqual([]);
  });

  test("grade run: the stop wait that starts when the run times out", async () => {
    const r = await run(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], {
      timeoutMs: 300,
      stopWaitMs: tooLong,
      env: process.env,
    });
    expect(r.timedOut).toBe(true);
    expect(delays).toContain(300);
    expect(overflowing()).toEqual([]);
  });

  test("env-derive build timeout", async () => {
    const docker = [process.execPath, "-e", "process.exit(process.argv.join(' ').includes('inspect') ? 1 : 0)"];
    const lines = await deriveImages(["base:1"], 1, docker, tooLong);
    expect(lines[0]).toMatch(/: ok$/);
    expect(delays.length).toBeGreaterThan(0);
    expect(overflowing()).toEqual([]);
  });
});
