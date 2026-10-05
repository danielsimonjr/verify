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
 * The environment of a verifier started from inside a Claude Code session.
 *
 * `veriharness` can be started by a tool a Claude Code session runs, so its environment may carry the
 * variables that Claude Code puts into every process it starts. A verifier that inherits them is not the
 * same program as one started from a terminal: it believes it is a child of that session, it may try to
 * reach that session's IDE or message channel, and (Claude Code 2.1) a child-session marker changes
 * whether the transcript is saved. The harness needs the saved transcript: `--resume` reads it.
 */

/**
 * The variables that name or reach one running Claude Code session. Claude Code puts `CLAUDECODE`,
 * `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ATTENDED` and `CLAUDE_PID`
 * into every process it starts, and `AI_AGENT`, `CLAUDE_EFFORT` and `TRACEPARENT` when they apply. The
 * others name the session's own entry point and executable, its IDE port and its message channel.
 * Settings such as `CLAUDE_CODE_MAX_OUTPUT_TOKENS` or `CLAUDE_CODE_GIT_BASH_PATH` are the user's
 * configuration, not session markers, and are kept.
 *
 * `CLAUDE_CODE_MESSAGING_TOKEN` is not an Anthropic credential: it opens the parent session's message
 * socket, and a verifier's `Bash` tool would otherwise be able to read it.
 */
export const SESSION_MARKERS: readonly string[] = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_PID",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "AI_AGENT",
  "CLAUDE_EFFORT",
  "TRACEPARENT",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_HOST_WORKTREE",
  "CLAUDE_CODE_HOST_WORKTREE_FENCE",
  "CLAUDE_CODE_PLUGIN_DIRS",
  "CLAUDE_CODE_CHROME_MCP_ORG_DENIED",
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_SAFE_MODE",
  "CLAUDE_CODE_RESTRICTED",
];

/**
 * Families of session variables that Claude Code's own fresh-session clean-up removes by prefix: the
 * background-session credentials (`CLAUDE_BG_RV_AUTH`, `CLAUDE_BG_PTY_AUTH`,
 * `CLAUDE_BG_SOCKET_TOKENS_PATH`), the remote bridge, the host worktree and the evaluation harness. No
 * login or provider variable starts with one of these, and a test asserts it.
 */
export const SESSION_MARKER_PREFIXES: readonly string[] = [
  "CLAUDE_BG_",
  "CLAUDE_CODE_BRIDGE_",
  "CLAUDE_CODE_HOST_",
  "CLAUDE_CODE_EVAL_",
];

/**
 * What is never stripped, however the list above changes: the login and the choice of provider. A test
 * asserts that no entry of `SESSION_MARKERS` is in this list and that no entry of this list starts with one of
 * `SESSION_MARKER_PREFIXES`.
 */
export const KEPT_VARIABLES: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_GIT_BASH_PATH",
];

const MARKER_SET = new Set(SESSION_MARKERS.map((n) => n.toUpperCase()));

function isSessionMarker(name: string): boolean {
  const upper = name.toUpperCase();
  return MARKER_SET.has(upper) || SESSION_MARKER_PREFIXES.some((p) => upper.startsWith(p));
}

/** A copy of `env` without the session markers. Names are compared upper-cased: Windows ignores case. */
export function withoutSessionMarkers(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !isSessionMarker(name)));
}

/**
 * The settings every turn adds: no hook of the user's or of a plugin runs; auto-memory is off (with
 * `--setting-sources ""` no setting enables or disables it, and it is on by default, so a verifier
 * could read and write the user's own memory folder); and a usage limit fails the turn instead of
 * pausing it until the limit lifts. `CLAUDE_CODE_DISABLE_AUTO_MEMORY` in the environment backs up
 * `autoMemoryEnabled`.
 */
export const VERIFIER_SETTINGS = JSON.stringify({
  disableAllHooks: true,
  autoMemoryEnabled: false,
  autoContinueAtUsageLimit: false,
});

/**
 * The environment of a verifier or check session: no session markers, and auto-memory off. The name is
 * set last and with the exact spelling the CLI reads, so a lower-case copy in the host's environment
 * cannot win on Windows.
 */
export function claudeSessionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = Object.fromEntries(
    Object.entries(withoutSessionMarkers(env)).filter(([n]) => n.toUpperCase() !== "CLAUDE_CODE_DISABLE_AUTO_MEMORY"),
  );
  out.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  return out;
}
