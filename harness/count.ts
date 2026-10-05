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
 * Parse an option made only of decimal digits as a safe integer of at least `min`. Returns
 * `undefined` for anything else: a sign, a fraction, an exponent, spaces, an empty string, or a
 * digit string so long that `Number` turns it into `Infinity` or rounds it to a different integer.
 * An unbounded `--jobs`, `--cell-cap`, `--lane-max` or `--limit` would otherwise pass a plain
 * `/^\d+$/` test and remove the bound that the option exists to set.
 */
export function parseCount(raw: string, min = 0): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min ? n : undefined;
}
