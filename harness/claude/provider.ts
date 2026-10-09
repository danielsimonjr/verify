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

/** The `claude-code` provider: the names a user types and the tools a verifier turn may use. */

export const CLAUDE_CODE_PROVIDER = "claude-code";

/** Exit code of a driver whose task stopped on a subscription usage limit (EX_TEMPFAIL). */
export const USAGE_LIMIT_EXIT = 75;

/** True for `--provider claude-code`, however it is cased. Local providers and pi's own providers are not. */
export function isClaudeCodeProvider(name: string | undefined): boolean {
  return name?.trim().toLowerCase() === CLAUDE_CODE_PROVIDER;
}

/**
 * The pi tool each Claude Code tool stands in for. A contract names pi tools (`TOOLS` in the driver);
 * the Claude Code runtime enables the Claude Code names of the same set, so a verifier can do the same
 * things under either runtime. `find` and `ls` both become `Glob`.
 */
export const PI_TO_CLAUDE_TOOL: Readonly<Record<string, string>> = {
  read: "Read",
  bash: "Bash",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
  edit: "Edit",
  write: "Write",
};

/** A comma-separated pi tool list as the comma-separated Claude Code tools for `--tools`. */
export function claudeTools(piTools: string): string {
  const out: string[] = [];
  for (const raw of piTools.split(",")) {
    const pi = raw.trim();
    if (pi === "") continue;
    // Own keys only: 'constructor' or '__proto__' must not reach Object.prototype.
    const tool = Object.hasOwn(PI_TO_CLAUDE_TOOL, pi) ? PI_TO_CLAUDE_TOOL[pi] : undefined;
    if (tool === undefined) {
      throw new Error(`no Claude Code tool for the pi tool '${pi}' (known: ${Object.keys(PI_TO_CLAUDE_TOOL).join(", ")})`);
    }
    if (!out.includes(tool)) out.push(tool);
  }
  return out.join(",");
}

/** Driver and model-check options that configure a local model server or pi; Claude Code has no such knob. */
export const UNSUPPORTED_WITH_CLAUDE_CODE = [
  "thinking",
  "base-url",
  "context-size",
  "temperature",
  "max-tokens",
  "top-p",
  "request-timeout",
] as const;
