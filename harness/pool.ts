// Copyright 2026 The VeriHarness Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/** Bounded concurrency for async work (replaces Python thread/process pools). */

/**
 * Worker count for a pool. A bound that is not a number is a caller bug and is refused: it used
 * to become zero workers, so nothing ran and the caller got back an array of holes. Zero,
 * negative and fractional bounds fall back to the nearest usable count; Infinity is unbounded.
 */
function poolSize(concurrency: number): number {
  if (Number.isNaN(concurrency)) {
    throw new RangeError("concurrency must be a number, got NaN");
  }
  return Math.max(1, Math.floor(concurrency));
}

/**
 * Run `fn` over `items` with at most `concurrency` in flight and return the results in input
 * order. On the first failure no further item starts; the call waits for the items already
 * running, then rejects with that first error, so nothing it began outlives it.
 */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = poolSize(concurrency);
  const out: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (!failed) {
      const idx = next++;
      if (idx >= items.length) return;
      try {
        out[idx] = await fn(items[idx]!, idx);
      } catch (e) {
        if (!failed) {
          failed = true;
          firstError = e;
        }
        return;
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw firstError;
  return out;
}

/**
 * Like `mapPool`, but yields each result when it completes, in completion order, so a caller
 * can record progress while slower items are still running. A failure is thrown after the
 * results that completed; a consumer that stops early still waits for the items it started.
 */
export async function* iteratePool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): AsyncGenerator<R, void, undefined> {
  const n = poolSize(concurrency);
  const ready: R[] = [];
  let next = 0;
  let running = 0;
  let stopped = false;
  let failure: { error: unknown } | null = null;
  let wake: (() => void) | null = null;
  const poke = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };
  const launch = (): void => {
    while (!stopped && running < n && next < items.length) {
      const idx = next++;
      running++;
      let started: Promise<R>;
      try {
        started = fn(items[idx]!, idx);
      } catch (error) {
        // A non-async fn that throws before returning its promise is still a failed item.
        started = Promise.reject(error);
      }
      void started
        .then(
          (r) => {
            ready.push(r);
          },
          (error: unknown) => {
            stopped = true;
            failure ??= { error };
          },
        )
        .finally(() => {
          running--;
          launch();
          poke();
        });
    }
  };
  launch();
  try {
    while (true) {
      while (ready.length) yield ready.shift()!;
      if (running === 0 && (stopped || next >= items.length)) break;
      await new Promise<void>((r) => {
        wake = r;
      });
    }
  } finally {
    stopped = true;
    while (running > 0) {
      await new Promise<void>((r) => {
        wake = r;
      });
    }
  }
  if (failure) throw (failure as { error: unknown }).error;
}

export async function mapPoolSettled<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return mapPool(items, concurrency, async (item, index) => {
    try {
      return { status: "fulfilled" as const, value: await fn(item, index) };
    } catch (reason) {
      return { status: "rejected" as const, reason };
    }
  });
}
