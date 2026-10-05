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
 * Claude Code's `--output-format stream-json` events: the turn's outcome, and the verifier's own record.
 *
 * The driver appends each turn's stdout to `<ws>/session/<name>/<uuid>.jsonl`, one JSON event per line.
 * Two events matter to the harness. `system/init` says which model, CLI version and key source the
 * session really used. `result` ends a turn and says whether it failed. Every `assistant` event carries the
 * tool calls the verifier made; the own-record check reads those, exactly as it reads pi's transcript.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isFile, readJson } from "../fsutil.js";

/** What the first `system/init` event of a turn reports. */
export interface StreamInit {
  model?: string;
  version?: string;
  apiKeySource?: string;
  sessionId?: string;
  cwd?: string;
  tools: string[];
  mcpServers: string[];
  plugins: string[];
}

/** What the last `result` event of a turn reports. */
export interface StreamResult {
  isError: boolean;
  subtype?: string;
  /** The result text; on a failed turn, the CLI's own message, followed by each entry of `errors`. */
  text: string;
  /** The `errors` array of the result event, as text. A non-empty array makes the result an error. */
  errors: string[];
  numTurns?: number;
  costUsd?: number;
}

type Json = Record<string, unknown>;

function parseLine(line: string): Json | null {
  if (!line.startsWith("{")) return null;
  try {
    const v: unknown = JSON.parse(line);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

function names(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((x) => (typeof x === "string" ? x : String((x as { name?: unknown } | null)?.name ?? "")));
}

/**
 * Plugins that ship inside the Claude Code program are named `cc-plugin-*` (2.1.289: agents-md, telemetry,
 * plugin-authoring, among others). They load whatever the setting sources say, so they are no sign that the
 * isolation failed. Any other plugin is.
 */
export function splitPlugins(plugins: readonly string[]): { builtin: string[]; other: string[] } {
  return {
    builtin: plugins.filter((n) => n.startsWith("cc-plugin-")),
    other: plugins.filter((n) => !n.startsWith("cc-plugin-")),
  };
}

const NL = String.fromCharCode(10);

function errorTexts(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => {
      if (typeof x === "string") return x;
      const message = (x as { message?: unknown } | null)?.message;
      return typeof message === "string" ? message : JSON.stringify(x);
    })
    .filter((t) => t !== "");
}

/** The first `system/init` event and the last `result` event in `text`; either may be absent. */
export function parseStream(text: string): { init?: StreamInit; result?: StreamResult } {
  let init: StreamInit | undefined;
  let result: StreamResult | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes('"type"')) continue;
    const e = parseLine(line.trim());
    if (e === null) continue;
    if (e.type === "system" && e.subtype === "init" && init === undefined) {
      init = {
        model: typeof e.model === "string" ? e.model : undefined,
        version: typeof e.claude_code_version === "string" ? e.claude_code_version : undefined,
        apiKeySource: typeof e.apiKeySource === "string" ? e.apiKeySource : undefined,
        sessionId: typeof e.session_id === "string" ? e.session_id : undefined,
        cwd: typeof e.cwd === "string" ? e.cwd : undefined,
        tools: names(e.tools),
        mcpServers: names(e.mcp_servers),
        plugins: names(e.plugins),
      };
    } else if (e.type === "result") {
      const errors = errorTexts(e.errors);
      const text = typeof e.result === "string" ? e.result : "";
      result = {
        isError: e.is_error === true || errors.length > 0,
        subtype: typeof e.subtype === "string" ? e.subtype : undefined,
        text: [text, ...errors].filter((t) => t !== "").join(NL),
        errors,
        numTurns: typeof e.num_turns === "number" ? e.num_turns : undefined,
        costUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : undefined,
      };
    }
  }
  return { init, result };
}

/** True when `filePath` names `record` as its last path segment (either kind of separator). */
function namesRecord(filePath: unknown, record: string): boolean {
  const p = String(filePath ?? "").replace(/\\/g, "/");
  return p === record || p.endsWith(`/${record}`);
}

interface ToolUse {
  type?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/**
 * The text of the record file this session wrote itself, or null. `sessionDir` holds the session's
 * transcripts (`<uuid>.jsonl`; the `claude-persisted/` folder under it is not read). The last tool call
 * that names the record wins:
 *
 * - a `Write` whose `file_path` ends in the record name supplies the record from its `content`, which must parse;
 * - a `Bash` call that mentions the record name, or an `Edit` / `MultiEdit` of it, means the verifier built or
 *   changed the file by other means, so the record is read back from `recordPath` and must parse.
 *
 * A file another session left at that path is therefore never taken for this session's own.
 */
export function claudeOwnRecord(sessionDir: string, recordPath: string): string | null {
  const record = recordPath.replace(/\\/g, "/").split("/").pop() ?? recordPath;
  let last: ["write", string] | ["disk", null] | null = null;
  let files: string[];
  try {
    files = readdirSync(sessionDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => e.name)
      .sort();
  } catch {
    return null;
  }
  for (const fn of files) {
    for (const line of readFileSync(join(sessionDir, fn), "utf8").split("\n")) {
      if (!line.includes(record) || !line.includes('"tool_use"')) continue;
      const e = parseLine(line.trim());
      if (e === null || e.type !== "assistant") continue;
      const content = (e.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as ToolUse[]) {
        if (block?.type !== "tool_use") continue;
        const input = block.input ?? {};
        if (block.name === "Write" && namesRecord(input.file_path, record)) {
          last = ["write", String(input.content ?? "")];
        } else if ((block.name === "Edit" || block.name === "MultiEdit") && namesRecord(input.file_path, record)) {
          last = ["disk", null];
        } else if (block.name === "Bash" && JSON.stringify(input).includes(record)) {
          last = ["disk", null];
        }
      }
    }
  }
  if (last === null) return null;
  if (last[0] === "write") {
    try {
      JSON.parse(last[1]);
      return last[1];
    } catch {
      return null;
    }
  }
  if (readJson(recordPath) !== null && isFile(recordPath)) {
    return readFileSync(recordPath, "utf8");
  }
  return null;
}
