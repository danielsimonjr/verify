import { describe, expect, test } from "bun:test";

import { iteratePool, mapPool, mapPoolSettled } from "../harness/pool.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("mapPool", () => {
  test("keeps input order and never exceeds the concurrency bound", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapPool([30, 5, 20, 1, 10], 2, async (ms, i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(ms);
      inFlight--;
      return i * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40]);
    expect(peak).toBe(2);
  });

  test("a concurrency that is not a number is refused instead of running nothing", async () => {
    let ran = 0;
    await expect(
      mapPool([1, 2, 3], Number.NaN, async () => {
        ran++;
      }),
    ).rejects.toThrow(/concurrency/);
    expect(ran).toBe(0);
  });

  test("an unbounded pool runs everything at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool([1, 2, 3, 4], Number.POSITIVE_INFINITY, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(10);
      inFlight--;
    });
    expect(peak).toBe(4);
  });

  test("zero, negative and fractional bounds fall back to a usable worker count", async () => {
    for (const bound of [0, -3, 1.5]) {
      expect(await mapPool([1, 2], bound, async (x) => x)).toEqual([1, 2]);
    }
  });

  test("after a failure no new item starts, and the call waits for work already running", async () => {
    const started: number[] = [];
    let slowFinished = false;
    const items = Array.from({ length: 10 }, (_, i) => i);
    const err = await mapPool(items, 2, async (i) => {
      started.push(i);
      if (i === 0) throw new Error("boom");
      await sleep(80);
      slowFinished = true;
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("boom");
    // Item 1 was already running; nothing after it may start once item 0 has failed.
    expect(started).toEqual([0, 1]);
    // The rejection arrives only after that running item has finished.
    expect(slowFinished).toBe(true);
  });
});

describe("mapPoolSettled", () => {
  test("reports every outcome and never rejects", async () => {
    const out = await mapPoolSettled([1, 2, 3], 2, async (x) => {
      if (x === 2) throw new Error("two");
      return x;
    });
    expect(out.map((o) => o.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});

describe("iteratePool", () => {
  test("yields each result as it completes, not when the slowest one does", async () => {
    const seen: number[] = [];
    const gate = { release: () => {} };
    const slow = new Promise<void>((r) => (gate.release = r));
    const it = iteratePool([0, 1, 2], 3, async (i) => {
      if (i === 0) await slow;
      return i;
    });
    const first = await it.next();
    seen.push(first.value as number);
    const second = await it.next();
    seen.push(second.value as number);
    // 1 and 2 are out while 0 is still blocked.
    expect(seen.sort()).toEqual([1, 2]);
    gate.release();
    const third = await it.next();
    expect(third.value).toBe(0);
    expect((await it.next()).done).toBe(true);
  });

  test("bounds concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const got: number[] = [];
    for await (const v of iteratePool([1, 2, 3, 4, 5, 6], 2, async (x) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(10);
      inFlight--;
      return x;
    })) {
      got.push(v);
    }
    expect(got.sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(peak).toBe(2);
  });

  test("a failure surfaces after the results that did complete, and stops new work", async () => {
    const started: number[] = [];
    const got: number[] = [];
    let err: unknown;
    try {
      for await (const v of iteratePool([0, 1, 2, 3, 4, 5], 2, async (i) => {
        started.push(i);
        if (i === 1) {
          await sleep(5);
          throw new Error("grader died");
        }
        await sleep(40);
        return i;
      })) {
        got.push(v);
      }
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toBe("grader died");
    expect(got).toEqual([0]);
    expect(started.length).toBeLessThan(6);
  });

  test("a consumer that stops early still waits for running work", async () => {
    let started = 0;
    let finished = 0;
    const it = iteratePool([0, 1, 2, 3], 2, async (i) => {
      started++;
      await sleep(i === 0 ? 5 : 60);
      finished++;
      return i;
    });
    await it.next();
    await it.return(undefined);
    // return() must not resolve while anything it started is still running, and must start nothing new.
    expect(finished).toBe(started);
    expect(started).toBe(3);
  });

  test("a concurrency that is not a number is refused", async () => {
    await expect(iteratePool([1], Number.NaN, async (x) => x).next()).rejects.toThrow(/concurrency/);
  });

  test("a function that throws before returning a promise is a failed item, not a crash", async () => {
    const boom = (): Promise<number> => {
      throw new Error("sync throw");
    };
    await expect(iteratePool([1, 2], 2, boom).next()).rejects.toThrow("sync throw");
    await expect(mapPool([1, 2], 2, boom)).rejects.toThrow("sync throw");
  });
});
