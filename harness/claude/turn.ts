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
 * One verifier turn through Claude Code (`claude -p`): the command line, the retry loop, the sessions.
 *
 * The harness contract is the same as for pi. A turn runs in the task workspace, reads the rollouts and
 * writes records; the driver judges the turn by those files. This module differs from the pi path in how
 * the turn is started: the message goes to stdin and the charter to a file (a mission with mounted skills
 * is longer than the 32 767-character Windows command line), and the stream of events goes to a transcript
 * file the driver reads back.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, fileSize } from "../fsutil.js";
import { runWithBudget } from "../runtime.js";
import { classifyFailure } from "./errors.js";
import { claudeConfigDir, findPersisted, movePersisted } from "./persisted.js";
import { claudeOwnRecord, parseStream, type StreamInit, type StreamResult } from "./stream.js";

/** The settings every turn adds: no hook of the user's or of a plugin runs. */
const SETTINGS = '{"disableAllHooks":true}';

export interface ClaudeArgsInput {
  model: string;
  /** Claude Code tool names, comma-separated (`--tools`). */
  tools: string;
  session: { mode: "new" | "resume"; id: string };
  /** A file holding the charter; appended to Claude Code's own system prompt. */
  charterFile: string;
  /** Directories outside the workspace the verifier may read (the skills). */
  addDirs: readonly string[];
}

/**
 * The arguments of a verifier turn, after the command that names the executable. Isolation is in these
 * flags: no user, project or local settings, no MCP server but those of `--settings` (none), no hook,
 * only the named tools. `announce` logs a warning when the session still reports an MCP server or a
 * plugin. The prompt is not here: it is stdin.
 */
export function claudeArgs(input: ClaudeArgsInput): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    input.model,
    ...(input.session.mode === "new" ? ["--session-id", input.session.id] : ["--resume", input.session.id]),
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--settings",
    SETTINGS,
    "--tools",
    input.tools,
    "--permission-mode",
    "bypassPermissions",
    "--append-system-prompt-file",
    input.charterFile,
    ...input.addDirs.flatMap((d) => ["--add-dir", d]),
  ];
}

/** The tail of `path` from byte `from`, at most `maxBytes` of it. */
function readTail(path: string, from: number, maxBytes: number): string {
  const size = statSync(path).size;
  const start = Math.max(from, size - maxBytes);
  const len = size - start;
  if (len <= 0) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** The head of `path` from byte `from`, at most `maxBytes` of it. */
function readHead(path: string, from: number, maxBytes: number): string {
  const len = Math.min(statSync(path).size - from, maxBytes);
  if (len <= 0) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, from);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export interface ClaudeRuntimeOptions {
  ws: string;
  /** The executable and any leading arguments, e.g. `["claude"]` or `[process.execPath, "stub.mjs"]`. */
  command: readonly string[];
  model: string;
  /** Claude Code tool names, comma-separated. */
  tools: string;
  charterFile: string;
  addDirs: readonly string[];
  /** The environment of every turn: already free of grader-only variables and session markers. */
  env: NodeJS.ProcessEnv;
  /** Epoch seconds after which no turn starts. */
  deadline: number;
  /** Seconds to wait before each retry of a transient failure; its length is the retry count. */
  backoff: readonly number[];
  log: (message: string) => void;
  /** Replaced by tests so a retry does not wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** A session directory under `<ws>/session` and the session ids created in it. */
interface Created {
  uuid: string;
  dir: string;
}

/**
 * The state one task shares across its sessions: the ids of every session it created (so the saved
 * copies can be moved when the task ends) and whether a usage limit stopped it.
 */
export class ClaudeRuntime {
  readonly created: Created[] = [];
  /** The CLI's message when a turn failed on a usage limit; null otherwise. */
  usageLimit: string | null = null;
  private finished = false;
  private announced = false;

  constructor(readonly options: ClaudeRuntimeOptions) {}

  /** The session of the adjudication and repair phases; the investigations take `withSession`. */
  session(name: string): ClaudeSession {
    return new ClaudeSession(this, name);
  }

  /** Log the first `system/init` event: the model Claude Code reports, and anything the isolation should have removed. */
  announce(init: StreamInit): void {
    if (this.announced) return;
    this.announced = true;
    this.options.log(
      `claude-code ${init.version ?? "?"}: model=${init.model ?? "?"} keySource=${init.apiKeySource ?? "?"} ` +
        `tools=${init.tools.join(",")}`,
    );
    const leaked = [
      ...init.mcpServers.map((n) => `mcp server ${n}`),
      ...init.plugins.map((n) => `plugin ${n}`),
    ];
    if (leaked.length) {
      this.options.log(`WARNING: the session is not isolated: ${leaked.join(", ")}`);
    }
  }

  /**
   * Move the saved copy of each session this task created into `<ws>/session/<name>/claude-persisted/`.
   * Idempotent, and safe to call on every exit path.
   */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    const configDir = claudeConfigDir(this.options.env);
    for (const { uuid, dir } of this.created) {
      try {
        const to = movePersisted(configDir, uuid, join(dir, "claude-persisted"));
        if (to === null) this.options.log(`session ${uuid}: no saved copy to move`);
      } catch (e) {
        this.options.log(`session ${uuid}: could not move its saved copy (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  }
}

/** One lineage of Claude Code sessions: `-c` of pi becomes `--resume <id>` of the last session created here. */
export class ClaudeSession {
  readonly ws: string;
  private uuid: string | null = null;

  constructor(
    private readonly runtime: ClaudeRuntime,
    readonly name: string,
  ) {
    this.ws = runtime.options.ws;
  }

  get sessionDir(): string {
    return join(this.ws, "session", this.name);
  }

  withSession(name: string): ClaudeSession {
    return new ClaudeSession(this.runtime, name);
  }

  /** The record this session's own tool calls wrote, or null; see `claudeOwnRecord`. */
  ownRecord(record: string): string | null {
    return claudeOwnRecord(this.sessionDir, record);
  }

  /**
   * Run one turn and say whether it succeeded: exit code 0 and a final `result` event that is not an
   * error. A transient provider fault retries with the backoff, resuming the session if Claude Code saved
   * it. A usage limit does not retry: it is recorded on the runtime and the turn fails.
   */
  async turn(message: string, timeout: number, continueSession: boolean, tag = ""): Promise<boolean> {
    const o = this.runtime.options;
    const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const configDir = claudeConfigDir(o.env);
    // The limit is the account's: a nudge, or the other investigation's next turn, would only meet it again.
    if (this.runtime.usageLimit !== null) {
      o.log(`${tag}usage limit already reached; no turn started`);
      return false;
    }
    ensureDir(this.sessionDir);

    if (!continueSession || this.uuid === null) {
      this.uuid = randomUUID();
      this.runtime.created.push({ uuid: this.uuid, dir: this.sessionDir });
    }
    const uuid = this.uuid;
    const transcript = join(this.sessionDir, `${uuid}.jsonl`);

    for (let attempt = 0; attempt < o.backoff.length + 1; attempt++) {
      const budget = Math.min(timeout, o.deadline - Date.now() / 1000);
      if (!(budget > 0)) {
        o.log(`${tag}task deadline reached before turn start; skipping turn`);
        return false;
      }
      // A session exists to resume only once Claude Code has saved it; a first attempt that failed
      // before that starts the same session id again.
      const resume = findPersisted(configDir, uuid) !== null;
      o.log(
        `${tag}claude turn (continue=${resume}, attempt=${attempt + 1}, budget=${Math.floor(budget)}s, session=${uuid})`,
      );
      // A killed attempt can leave a line without its newline; the next attempt must not extend it.
      if (existsSync(transcript) && fileSize(transcript) > 0 && readTail(transcript, 0, 1) !== "\n") {
        appendFileSync(transcript, "\n");
      }
      const from = existsSync(transcript) ? fileSize(transcript) : 0;

      const run = await runWithBudget(
        [
          ...o.command,
          ...claudeArgs({
            model: o.model,
            tools: o.tools,
            session: { mode: resume ? "resume" : "new", id: uuid },
            charterFile: o.charterFile,
            addDirs: o.addDirs,
          }),
        ],
        { cwd: this.ws, env: o.env, budgetMs: budget * 1000, input: message, stdoutFile: transcript },
      );

      if (run.spawnError !== undefined) {
        o.log(`${tag}claude did not start: ${run.spawnError} (command: ${o.command[0]})`);
        return false;
      }
      if (run.timedOut) {
        o.log(`${tag}claude turn timed out after ${Math.floor(budget)}s (process tree killed)`);
        return false;
      }

      const seen = parseStream(readHead(transcript, from, 262_144));
      const { init } = seen;
      const result = parseStream(readTail(transcript, from, 1_048_576)).result;
      if (init) this.runtime.announce(init);
      const rc = run.code ?? 1;
      o.log(`${tag}claude exited rc=${rc}${summary(result)}`);
      if (rc === 0 && result !== undefined && !result.isError) return true;

      const text = [result?.text ?? "", run.stderr].filter((t) => t !== "").join("\n");
      if (rc === 0 && result === undefined) o.log(`${tag}claude exited 0 without a result event`);
      o.log(`${tag}claude failure (tail): ${text.slice(-2000)}${run.stderrCut ? " [stderr was cut to its tail]" : ""}`);
      const kind = classifyFailure(text);
      if (kind === "usage-limit") {
        this.runtime.usageLimit = (result?.text || run.stderr).trim().split("\n")[0]!.slice(0, 300);
        o.log(`${tag}usage-limit: ${this.runtime.usageLimit}; this lane stops`);
        return false;
      }
      if (kind !== "transient" || attempt === o.backoff.length) return false;
      o.log(`${tag}transient provider error; retrying in ${o.backoff[attempt]}s`);
      await sleep(o.backoff[attempt]! * 1000);
    }
    return false;
  }
}

function summary(result: StreamResult | undefined): string {
  if (result === undefined) return "";
  const parts = [`is_error=${result.isError}`];
  if (result.subtype) parts.push(`subtype=${result.subtype}`);
  if (result.numTurns !== undefined) parts.push(`turns=${result.numTurns}`);
  if (result.costUsd !== undefined) parts.push(`cost=$${result.costUsd.toFixed(4)}`);
  return ` (${parts.join(" ")})`;
}
