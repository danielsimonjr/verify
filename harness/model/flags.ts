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

import { isClaudeCodeProvider } from "../claude/provider.js";
import { canonicalLocalProvider } from "./config.js";

/** Split `--key=value` into `--key` `value`. Repeated calls leave an already-split argv unchanged. */
export function normalizeArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      const key = arg.slice(0, eq);
      const value = arg.slice(eq + 1);
      if (key.length > 2) out.push(key);
      if (value !== "") out.push(value);
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** Last value wins, including a later `--flag=value` form. */
export function flagValue(argv: string[], flag: string): string | undefined {
  const normalized = normalizeArgv(argv);
  let found: string | undefined;
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] !== flag) continue;
    const next = normalized[i + 1];
    found = next === undefined || next.startsWith("--") ? undefined : next;
  }
  return found;
}

/**
 * Append `extra` flags, dropping any earlier copy of the same flag (and its value).
 * `--key=value` is normalized first, so an override written that way still replaces the lane flag.
 * Switching a lane onto a local provider, or onto Claude Code, also drops the lane's `--thinking`
 * value: most local models reject a thinking level and Claude Code has no such flag, so carrying it
 * would fail the turn for a reason that does not mention the model.
 */
export function withModelOverride(base: string[], extra: string[]): string[] {
  const extraNorm = normalizeArgv(extra);
  const baseNorm = normalizeArgv(base);
  const extraFlags = new Set(extraNorm.filter((arg) => arg.startsWith("--")));
  const dropThinking =
    extraFlags.has("--provider") &&
    !extraFlags.has("--thinking") &&
    (canonicalLocalProvider(flagValue(extraNorm, "--provider")) !== undefined ||
      isClaudeCodeProvider(flagValue(extraNorm, "--provider")));
  const out: string[] = [];
  for (let i = 0; i < baseNorm.length; i++) {
    const arg = baseNorm[i]!;
    if ((dropThinking && arg === "--thinking") || extraFlags.has(arg)) {
      const next = baseNorm[i + 1];
      if (next !== undefined && !next.startsWith("--")) i++;
      continue;
    }
    out.push(arg);
  }
  return [...out, ...extraNorm];
}
