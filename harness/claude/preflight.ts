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
 * Preflight for the Claude Code provider: does the CLI start, and does the login work.
 *
 * `startCheck` is what the driver runs before a task: the CLI answers `--version`, nothing more, so a
 * task does not spend a model turn on it. `modelCheck` is `veriharness model-check --provider
 * claude-code`: one isolated turn with no tools, so a missing login or an unknown model shows up before a
 * batch is staged.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithBudget } from "../runtime.js";
import { classifyFailure } from "./errors.js";
import { VERIFIER_SETTINGS, claudeSessionEnv } from "./env.js";
import { parseStream, splitPlugins, type StreamInit } from "./stream.js";

/** The executable: `--claude-bin`, else `VERIHARNESS_CLAUDE_BIN`, else `claude` from `PATH`. */
export function claudeCommand(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const bin = flag !== undefined && flag !== "" ? flag : env.VERIHARNESS_CLAUDE_BIN;
  return [bin !== undefined && bin !== "" ? bin : "claude"];
}

/** Why the CLI cannot be started, as one line a user can act on; or the version line it printed. */
export function startCheck(
  command: readonly string[],
  env: NodeJS.ProcessEnv,
): { ok: true; version: string } | { ok: false; error: string } {
  const hit = spawnSync(command[0]!, [...command.slice(1), "--version"], {
    encoding: "utf8",
    env: claudeSessionEnv(env),
    timeout: 30_000,
    windowsHide: true,
  });
  if (hit.error) {
    const code = (hit.error as NodeJS.ErrnoException).code;
    const windows =
      process.platform === "win32" && (code === "EINVAL" || code === "ENOENT")
        ? "; on Windows set VERIHARNESS_CLAUDE_BIN (or --claude-bin) to claude.exe, not a .cmd shim"
        : "";
    return {
      ok: false,
      error: `cannot run Claude Code ('${command[0]}': ${code ?? hit.error.message}); install it or set VERIHARNESS_CLAUDE_BIN${windows}`,
    };
  }
  if (hit.status !== 0) {
    return { ok: false, error: `'${command[0]} --version' exited ${hit.status}: ${(hit.stderr || hit.stdout || "").trim().slice(0, 300)}` };
  }
  const version = (hit.stdout || "").trim().split("\n")[0] ?? "";
  return { ok: true, version };
}

/** What `model-check` reports about one Claude Code turn. */
export interface ModelCheckReport {
  provider: "claude-code";
  requestedModel: string;
  /** The model Claude Code reports in its `system/init` event. */
  model: string;
  /** What `claude --version` prints. */
  cliVersion: string;
  /** Where the credential comes from, as the CLI reports it (an environment variable, a login, none). */
  keySource: string;
  tools: string[];
  /** Plugins that ship inside Claude Code (`cc-plugin-*`); they load with any settings and are not a warning. */
  builtinPlugins: string[];
  warnings: string[];
  reply: string;
}

/** Raised when the `claude` program cannot start or the check turn fails. */
export class ClaudeCheckError extends Error {}

/** The inputs of one `model-check` turn. */
export interface ModelCheckOptions {
  command: readonly string[];
  model: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** One isolated turn with no tools, prompt `Reply with OK`, nothing saved to the user's session history. */
export async function modelCheck(opts: ModelCheckOptions): Promise<ModelCheckReport> {
  const env = claudeSessionEnv(opts.env);
  const started = startCheck(opts.command, env);
  if (!started.ok) throw new ClaudeCheckError(started.error);

  const cwd = mkdtempSync(join(tmpdir(), "veriharness-claude-check-"));
  const out = join(cwd, "stdout.jsonl");
  try {
    const run = await runWithBudget(
      [
        ...opts.command,
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        opts.model,
        "--no-session-persistence",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--settings",
        VERIFIER_SETTINGS,
        "--tools",
        "",
        "--permission-mode",
        "bypassPermissions",
      ],
      { cwd, env, budgetMs: opts.timeoutMs ?? 120_000, input: "Reply with OK", stdoutFile: out },
    );
    if (run.spawnError !== undefined) throw new ClaudeCheckError(`Claude Code did not start: ${run.spawnError}`);
    if (run.timedOut) throw new ClaudeCheckError(`Claude Code did not answer within ${(opts.timeoutMs ?? 120_000) / 1000}s`);
    const { init, result } = parseStream(readFileSync(out, "utf8"));
    if (result === undefined || result.isError || run.code !== 0) {
      const text = [result?.text ?? "", run.stderr].filter((t) => t !== "").join("\n").trim();
      const kind = classifyFailure(text);
      throw new ClaudeCheckError(
        `${text || `Claude Code exited ${run.code} with no output`}${kind === "usage-limit" ? " (usage limit)" : ""}`,
      );
    }
    return report(opts, started.version, init, result.text);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function report(opts: ModelCheckOptions, cliVersion: string, init: StreamInit | undefined, reply: string): ModelCheckReport {
  const warnings: string[] = [];
  if (init === undefined) warnings.push("the turn printed no system/init event, so the model and key source are unknown");
  if (init && init.tools.length) warnings.push(`the session has tools although none were enabled: ${init.tools.join(", ")}`);
  if (init && init.mcpServers.length) warnings.push(`the session started MCP servers: ${init.mcpServers.join(", ")}`);
  const { builtin, other } = splitPlugins(init?.plugins ?? []);
  if (other.length) warnings.push(`the session loaded plugins: ${other.join(", ")}`);
  if (init?.model && init.model !== opts.model) {
    warnings.push(`asked for ${opts.model}, Claude Code reports ${init.model}`);
  }
  return {
    provider: "claude-code",
    requestedModel: opts.model,
    model: init?.model ?? "unknown",
    cliVersion,
    keySource: init?.apiKeySource ?? "unknown",
    tools: init?.tools ?? [],
    warnings,
    builtinPlugins: builtin,
    reply: reply.trim().slice(0, 200),
  };
}
