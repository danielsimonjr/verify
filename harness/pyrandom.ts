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

/**
 * CPython's `random.Random(seed).sample` and `round`, reproduced exactly.
 *
 * Runs are compared across seeds, so `--sample N --seed S` must choose the same tasks the
 * Python harness chose. That needs CPython's own generator (MT19937, seeded by
 * `init_by_array` from the seed's 32-bit words) and its own sampling algorithm, not just
 * any seeded shuffle. The expected values in tests/fixtures/verify-runner/sampler.json
 * come from CPython itself.
 */

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

/** The 32-bit words of |seed|, least significant first; at least one, as `random_seed` builds them. */
function seedWords(seed: number | bigint): number[] {
  if (typeof seed === "number" && !Number.isSafeInteger(seed)) {
    throw new RangeError(`seed must be an integer, got ${seed}`);
  }
  let n = BigInt(seed);
  if (n < 0n) n = -n;
  const words: number[] = [];
  do {
    words.push(Number(n & 0xffffffffn));
    n >>= 32n;
  } while (n > 0n);
  return words;
}

export class PyRandom {
  private readonly mt = new Uint32Array(N);
  private index = N;

  /** Seed like `random.Random(seed)` for an int seed; a negative seed uses its absolute value. */
  constructor(seed: number | bigint) {
    this.initByArray(seedWords(seed));
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = mt[i - 1]!;
      mt[i] = (Math.imul(1812433253, prev ^ (prev >>> 30)) + i) >>> 0;
    }
    this.index = N;
  }

  private initByArray(key: number[]): void {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k > 0; k--) {
      const prev = mt[i - 1]!;
      mt[i] = ((mt[i]! ^ Math.imul(prev ^ (prev >>> 30), 1664525)) + key[j]! + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1]!;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const prev = mt[i - 1]!;
      mt[i] = ((mt[i]! ^ Math.imul(prev ^ (prev >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1]!;
        i = 1;
      }
    }
    mt[0] = 0x80000000;
    this.index = N;
  }

  private regenerate(): void {
    const mt = this.mt;
    const twist = (y: number) => (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
    let kk = 0;
    for (; kk < N - M; kk++) {
      const y = ((mt[kk]! & UPPER_MASK) | (mt[kk + 1]! & LOWER_MASK)) >>> 0;
      mt[kk] = (mt[kk + M]! ^ twist(y)) >>> 0;
    }
    for (; kk < N - 1; kk++) {
      const y = ((mt[kk]! & UPPER_MASK) | (mt[kk + 1]! & LOWER_MASK)) >>> 0;
      mt[kk] = (mt[kk + (M - N)]! ^ twist(y)) >>> 0;
    }
    const y = ((mt[N - 1]! & UPPER_MASK) | (mt[0]! & LOWER_MASK)) >>> 0;
    mt[N - 1] = (mt[M - 1]! ^ twist(y)) >>> 0;
    this.index = 0;
  }

  /** The next tempered 32-bit output (`genrand_uint32`). */
  private nextUint32(): number {
    if (this.index >= N) this.regenerate();
    let y = this.mt[this.index++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** `getrandbits(k)` for 1 <= k <= 32: the top k bits of one output. */
  getrandbits(k: number): number {
    if (!Number.isInteger(k) || k < 1 || k > 32) {
      throw new RangeError(`getrandbits supports 1..32 bits, got ${k}`);
    }
    return this.nextUint32() >>> (32 - k);
  }

  /** `_randbelow(n)`: an integer in [0, n), drawn by rejection from n.bit_length() bits. */
  randbelow(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > 0xffffffff) {
      throw new RangeError(`randbelow needs an integer in 1..2^32-1, got ${n}`);
    }
    const bits = 32 - Math.clz32(n);
    let r = this.getrandbits(bits);
    while (r >= n) r = this.getrandbits(bits);
    return r;
  }

  /** `sample(population, k)`: k distinct elements in selection order, population unchanged. */
  sample<T>(population: readonly T[], k: number): T[] {
    const n = population.length;
    if (!Number.isInteger(k) || k < 0 || k > n) {
      throw new RangeError("Sample larger than population or is negative");
    }
    const result: T[] = new Array(k);
    // CPython picks the cheaper of an n-item pool and a k-item set: 21 + 4**ceil(log4(3k))
    // for k > 5. The smallest power of 4 that is >= 3k is that same value, without a float log.
    let setsize = 21;
    if (k > 5) {
      let table = 1;
      while (table < k * 3) table *= 4;
      setsize += table;
    }
    if (n <= setsize) {
      const pool = [...population];
      for (let i = 0; i < k; i++) {
        const j = this.randbelow(n - i);
        result[i] = pool[j]!;
        pool[j] = pool[n - i - 1]!; // move the unselected item into the vacancy
      }
    } else {
      const selected = new Set<number>();
      for (let i = 0; i < k; i++) {
        let j = this.randbelow(n);
        while (selected.has(j)) j = this.randbelow(n);
        selected.add(j);
        result[i] = population[j]!;
      }
    }
    return result;
  }
}

/** Python's `round(x)` for a float: nearest integer, ties to the even one (`round(2.5) == 2`). */
export function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}
