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

import { canonicalLocalProvider } from "./config.js";

export function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const next = argv[index + 1];
  if (next === undefined || next.startsWith("--")) return undefined;
  return next;
}

/**
 * Append `extra` flags, dropping any earlier copy of the same flag (and its value).
 * Switching a lane onto a local provider also drops the lane's `--thinking` value:
 * most local models reject a thinking level, and carrying it would fail the turn
 * for a reason that does not mention the model.
 */
export function withModelOverride(base: string[], extra: string[]): string[] {
  const extraFlags = new Set(extra.filter((arg) => arg.startsWith("--")));
  const dropThinking =
    extraFlags.has("--provider") &&
    !extraFlags.has("--thinking") &&
    canonicalLocalProvider(flagValue(extra, "--provider")) !== undefined;
  const out: string[] = [];
  for (let i = 0; i < base.length; i++) {
    const arg = base[i]!;
    if (dropThinking && arg === "--thinking") {
      const next = base[i + 1];
      if (next !== undefined && !next.startsWith("--")) i++;
      continue;
    }
    if (extraFlags.has(arg)) {
      const next = base[i + 1];
      if (next !== undefined && !next.startsWith("--")) i++;
      continue;
    }
    out.push(arg);
  }
  return [...out, ...extra];
}
