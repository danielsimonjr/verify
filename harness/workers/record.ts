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
 * What a worker left: its deliverable, parsed from its last message, and the numbers of its session,
 * read from the event stream. The deliverable form is recorded, not hidden: a task that asks for pure
 * JSON and gets a fenced block has a format error, even though the value parses.
 */

import { StringDecoder } from "node:string_decoder";
import { parseStream } from "../claude/stream.js";

/** How the JSON sat in the last message: the whole text, one whole fence, or inside prose. */
export type DeliverableForm = "pure" | "fenced" | "embedded";

/** Why a rollout did not complete; null when it did. */
export type WorkerError =
  | "timeout"
  | "no-result"
  | "no-json"
  | "start-failed"
  | "usage-limit"
  | "truncated"
  | "stopped"
  | "max-turns"
  /** The last turn ended at the output-token limit, so its text is cut. */
  | "length"
  /** The last turn held thinking and no text: the model spent its output on thought. */
  | "thinking-only"
  /** The deliverable parsed but does not fit the `--schema` file. */
  | "schema"
  /** The agent compacted its context: the answer rests on turns it no longer held. */
  | "compacted"
  | null;

/** `trajectory/worker.json`: the numbers and the outcome of one rollout. */
export interface WorkerRecord {
  rollout: string;
  exit: number | null;
  /** Wall-clock seconds of this attempt (the last one, after a retry). */
  seconds: number;
  /** Seconds of every attempt of this rollout, this one included: what a retry cost in all. */
  totalSeconds: number;
  turns: number;
  tools: number;
  peakContext: number;
  outputTokens: number;
  /** Times the agent compacted its context: each one drops the older turns, so the worker lost what it had read. */
  compactions: number;
  /** Tool calls that failed (a path the task does not have, a bad pattern): a worker that wanders has many. */
  toolErrors: number;
  /** A nudge turn ran after the first session ended without an answer. */
  nudged: boolean;
  /** Runs of this rollout, the first one included: a retry replaces the stream, so the count says it happened. */
  attempts: number;
  form: DeliverableForm | null;
  error: WorkerError;
}

/** What an event stream says about a session. */
export interface StreamStats {
  /** The text of the last assistant message. */
  finalText: string;
  /** Assistant messages. */
  turns: number;
  /** Tool calls that ran. */
  tools: number;
  /** The largest prompt of one turn: input plus cache read plus cache write tokens. */
  peakContext: number;
  outputTokens: number;
  /** Compaction events in the stream (pi only). */
  compactions: number;
  /** Why the last assistant turn ended: `stop`, `toolUse`, `length`... Empty when the stream does not say. */
  stopReason: string;
  /** The last assistant turn has thinking blocks and no text (pi only). */
  thinkingOnly: boolean;
  /** Tool calls whose result was an error. */
  toolErrors: number;
}

const WHOLE_FENCE = /^```[\w-]*[ \t]*\n([\s\S]*?)\n?```$/;
const ANY_FENCE = /```[\w-]*[ \t]*\n([\s\S]*?)```/g;

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** The end of the balanced `{...}` or `[...]` that starts at `start`, skipping brackets inside strings; -1 if it never closes. */
function valueEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && --depth === 0) return i;
  }
  return -1;
}

/** A `[` opens a JSON array only when a value follows it: a bracketed word in prose does not. */
const ARRAY_OPEN = /\[\s*[\[{"]/y;

/**
 * Parse a JSON deliverable: the whole text, one whole fence, or the largest JSON value in prose.
 *
 * In prose the answer is the longest top-level value, an array included. A value that never closes,
 * or that is balanced but not valid JSON, is skipped whole and never searched for pieces: an object
 * inside a truncated array is a fragment, and returning it would drop the rest with no error.
 */
export function parseJsonDeliverable(text: string): { value: unknown; form: DeliverableForm } | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const pure = tryParse(trimmed);
  if (pure.ok) return { value: pure.value, form: "pure" };
  const whole = WHOLE_FENCE.exec(trimmed);
  if (whole) {
    const inner = tryParse(whole[1]!.trim());
    if (inner.ok) return { value: inner.value, form: "fenced" };
  }
  for (const match of trimmed.matchAll(ANY_FENCE)) {
    const inner = tryParse(match[1]!.trim());
    if (inner.ok) return { value: inner.value, form: "embedded" };
  }
  let best: { value: unknown; length: number } | null = null;
  for (let i = 0; i < trimmed.length; ) {
    const c = trimmed[i];
    ARRAY_OPEN.lastIndex = i;
    if (c !== "{" && !(c === "[" && ARRAY_OPEN.test(trimmed))) {
      i++;
      continue;
    }
    const end = valueEnd(trimmed, i);
    if (end < 0) break;
    const found = tryParse(trimmed.slice(i, end + 1));
    if (found.ok && (best === null || end + 1 - i > best.length)) best = { value: found.value, length: end + 1 - i };
    i = end + 1;
  }
  return best === null ? null : { value: best.value, form: "embedded" };
}

function events(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"type"')) continue;
    try {
      const e = JSON.parse(line) as unknown;
      if (e && typeof e === "object") out.push(e as Record<string, unknown>);
    } catch {
      // A partial last line from a killed process is not an event.
    }
  }
  return out;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "text")
    .map((b) => String((b as { text?: unknown }).text ?? ""))
    .join("");
}

/** The message of a pi event that ends one assistant turn, else undefined. */
function piTurn(e: Record<string, unknown>): Record<string, unknown> | undefined {
  if (e.type !== "message_end") return undefined;
  const m = (e.message ?? {}) as Record<string, unknown>;
  return m.role === "assistant" ? m : undefined;
}

/** The turn of a Claude Code `assistant` event: its message id, else a name made from `seen`. Undefined for other events. */
function claudeTurnId(e: Record<string, unknown>, seen: number): string | undefined {
  if (e.type !== "assistant") return undefined;
  const m = (e.message ?? {}) as Record<string, unknown>;
  return typeof m.id === "string" ? m.id : `#${seen}`;
}

/**
 * Counts the assistant turns of a live event stream, chunk by chunk, by the rule of piStreamStats or
 * claudeStreamStats. Each call returns the total so far. A line counts once its newline arrives.
 */
export function turnCounter(claude: boolean): (chunk: Buffer) => number {
  const decoder = new StringDecoder("utf8");
  const ids = new Set<string>();
  let partial = "";
  let turns = 0;
  return (chunk) => {
    const lines = (partial + decoder.write(chunk)).split("\n");
    partial = lines.pop()!;
    for (const e of events(lines.join("\n"))) {
      if (!claude) {
        if (piTurn(e)) turns++;
        continue;
      }
      const id = claudeTurnId(e, ids.size);
      if (id !== undefined) ids.add(id);
    }
    return claude ? ids.size : turns;
  };
}

/** pi `--mode json`: assistant `message_end` events carry the usage; `tool_execution_end` is one tool call. */
export function piStreamStats(text: string): StreamStats {
  const stats: StreamStats = { finalText: "", turns: 0, tools: 0, peakContext: 0, outputTokens: 0, compactions: 0, stopReason: "", thinkingOnly: false, toolErrors: 0 };
  for (const e of events(text)) {
    if (e.type === "tool_execution_end") {
      stats.tools++;
      if (e.isError === true) stats.toolErrors++;
    }
    if (e.type === "compaction_start") stats.compactions++;
    const m = piTurn(e);
    if (!m) continue;
    const u = (m.usage ?? {}) as Record<string, unknown>;
    stats.turns++;
    stats.peakContext = Math.max(stats.peakContext, num(u.input) + num(u.cacheRead) + num(u.cacheWrite));
    stats.outputTokens += num(u.output);
    stats.finalText = textOf(m.content);
    stats.stopReason = typeof m.stopReason === "string" ? m.stopReason : "";
    stats.thinkingOnly =
      stats.finalText.trim() === "" &&
      Array.isArray(m.content) &&
      m.content.some((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "thinking");
  }
  return stats;
}

/**
 * Claude Code `stream-json`: one `assistant` event per content block, each with the message's usage, so
 * a turn is a message id. The `result` event holds the final text and the session's output total.
 */
export function claudeStreamStats(text: string): StreamStats {
  const stats: StreamStats = { finalText: "", turns: 0, tools: 0, peakContext: 0, outputTokens: 0, compactions: 0, stopReason: "", thinkingOnly: false, toolErrors: 0 };
  const output = new Map<string, number>();
  let lastText = "";
  let resultUsage: Record<string, unknown> | undefined;
  for (const e of events(text)) {
    if (e.type === "user" && Array.isArray((e.message as { content?: unknown } | undefined)?.content)) {
      for (const b of (e.message as { content: unknown[] }).content) {
        const block = b as { type?: unknown; is_error?: unknown };
        if (block && block.type === "tool_result" && block.is_error === true) stats.toolErrors++;
      }
    }
    if (e.type === "result") resultUsage = (e.usage ?? undefined) as Record<string, unknown> | undefined;
    const id = claudeTurnId(e, output.size);
    if (id === undefined) continue;
    const m = (e.message ?? {}) as Record<string, unknown>;
    const u = (m.usage ?? {}) as Record<string, unknown>;
    output.set(id, num(u.output_tokens));
    const context = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
    stats.peakContext = Math.max(stats.peakContext, context);
    if (Array.isArray(m.content)) {
      stats.tools += m.content.filter((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "tool_use").length;
    }
    const blockText = textOf(m.content);
    if (blockText !== "") lastText = blockText;
  }
  stats.turns = output.size;
  const result = parseStream(text).result;
  stats.outputTokens = resultUsage ? num(resultUsage.output_tokens) : [...output.values()].reduce((a, b) => a + b, 0);
  stats.finalText = result && !result.isError ? result.text : lastText;
  return stats;
}
