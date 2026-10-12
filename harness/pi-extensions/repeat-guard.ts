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
 * A pi extension for a worker session. It stops the two loops that a small model enters and cannot
 * leave by itself:
 *
 * - A tool call that repeats an earlier call of the session is blocked. The tools of a worker only
 *   read, so the second call returns the text the model already has. The block tells the model so,
 *   in the place where the result would be. The third block in a row stops the session, and the
 *   harness then asks the model for the answer on a turn that has no tools.
 * - A final message that has more records than the batch has items, or that repeats one unit of text,
 *   is cut at that point (`ctx.abort()`). Left alone, it runs to the output limit: one row written
 *   a hundred times, which costs ten minutes on a local model. The harness sees the aborted message
 *   as a cut one and asks for the answer again, with the message removed from the session.
 *
 * Pi loads this file with `-e`. It imports nothing from pi: the types below are the part of the pi
 * extension API that it uses.
 */

/** The tools whose result is the same each time they are called with the same arguments. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

/** Blocks in a row after which the session is stopped. */
export const MAX_BLOCKS_IN_A_ROW = 3;

/** What the model reads in place of the result of a blocked call. */
export const REPEAT_REASON =
  "Blocked: this call is the same as an earlier call in this session, and its result is already in your context. Do not repeat it. Use a different call, or write your final answer now.";

/** What a `tool_call` handler returns to stop the call. */
export interface BlockResult {
  block: true;
  reason: string;
  /** Stops the session when every call of the message is a block that has this set. */
  terminate?: true;
}

/** The part of the pi extension context that the guard uses. */
export interface ExtensionContext {
  abort(): void;
}

/** The part of the pi extension API that this file uses. */
export interface ExtensionApi {
  // The handler of each event has its own event type in pi; the guard reads the few fields it names.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown): void;
}

/**
 * The key of a call: its tool and its arguments, with the keys in order and every scalar written as
 * a string. Pi accepts a number that is written as a string, and a model writes `"limit": "10"` in
 * one turn and `"limit": 10` in the next; the call is the same.
 */
export function callKey(toolName: string, input: Record<string, unknown>): string {
  const norm = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(norm);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as object).sort()) out[key] = norm((value as Record<string, unknown>)[key]);
      return out;
    }
    return value === null || value === undefined ? "" : String(value);
  };
  return `${toolName}:${JSON.stringify(norm(input))}`;
}

/** The state of one session: the calls it has made and how many blocks came in a row. */
export function createRepeatGuard() {
  const seen = new Set<string>();
  let blocksInARow = 0;
  return {
    /** `undefined` lets the call run. A block result stops it. */
    check(toolName: string, input: Record<string, unknown>): BlockResult | undefined {
      if (!READ_ONLY_TOOLS.has(toolName)) {
        // `--tools` is a list the caller chose. A call that can change a file or a listing makes the
        // results that the session holds old: the same read after it can return other text.
        seen.clear();
        blocksInARow = 0;
        return undefined;
      }
      const key = callKey(toolName, input);
      if (!seen.has(key)) {
        seen.add(key);
        blocksInARow = 0;
        return undefined;
      }
      blocksInARow += 1;
      return blocksInARow >= MAX_BLOCKS_IN_A_ROW
        ? { block: true, reason: REPEAT_REASON, terminate: true }
        : { block: true, reason: REPEAT_REASON };
    },
    /** A compaction replaces the results in the context, so the calls that were made are not "already in" it. */
    reset(): void {
      seen.clear();
      blocksInARow = 0;
    },
  };
}

/** What the harness tells the guard about the answer it expects: one record for each item of the batch. */
export interface AnswerShape {
  /** The field that holds the id of a record (`--ids ARRAY.FIELD`). */
  idField: string;
  /** The number of items of the batch, so the number of records the answer may have. */
  records: number;
}

/** The environment variable that carries the `AnswerShape` as JSON from the harness to the guard. */
export const ANSWER_SHAPE_ENV = "VERIHARNESS_ANSWER_SHAPE";

/** The shape in `env`, or undefined when there is none or it is damaged: the guard never stops a session on a bad value. */
export function answerShapeFromEnv(env: NodeJS.ProcessEnv): AnswerShape | undefined {
  const raw = env[ANSWER_SHAPE_ENV];
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as Partial<AnswerShape>;
    if (typeof v.idField === "string" && v.idField !== "" && typeof v.records === "number" && v.records > 0) {
      return { idField: v.idField, records: v.records };
    }
  } catch {
    // fall through
  }
  return undefined;
}

/** The shortest unit of text that counts as a repeat: a rule line or a run of nulls is a legitimate short unit. */
export const RUNAWAY_MIN_UNIT = 24;
/** The longest unit that is looked for. A row of a report is some hundred characters. */
export const RUNAWAY_MAX_UNIT = 600;
/**
 * Times a unit stands in a row at the end of the text before it is a runaway. A report can hold some equal
 * entries, so this is far above that. A runaway is not near the line: the real ones that were measured
 * wrote the unit 99 to 129 times, and at 12 the cut came at 2.7 to 6.9 KB of 16.7 to 27 KB.
 */
export const RUNAWAY_REPEATS = 12;

/** The smallest p such that `unit` is a shorter text written `unit.length / p` times. */
function smallestPeriod(unit: string): number {
  for (let q = 1; q < unit.length; q++) {
    if (unit.length % q === 0 && unit === unit.slice(0, q).repeat(unit.length / q)) return q;
  }
  return unit.length;
}

/** True when the end of `text` is one unit of at least RUNAWAY_MIN_UNIT characters, written RUNAWAY_REPEATS times in a row. */
function repeatsAtEnd(text: string): boolean {
  const t = text.slice(-(RUNAWAY_MAX_UNIT * RUNAWAY_REPEATS + 1)).replace(/\s+/g, " ");
  for (let p = RUNAWAY_MIN_UNIT; p <= RUNAWAY_MAX_UNIT && p * RUNAWAY_REPEATS <= t.length; p++) {
    const unit = t.slice(-p);
    let all = true;
    for (let k = 2; k <= RUNAWAY_REPEATS && all; k++) all = t.slice(t.length - k * p, t.length - (k - 1) * p) === unit;
    if (all && smallestPeriod(unit) >= RUNAWAY_MIN_UNIT) return true;
  }
  return false;
}

/**
 * The number of records in `text`: the times `field` is written as a key, at the shallowest depth of
 * braces and brackets where it is written. A record may hold other objects that have a key of the same
 * name; those are deeper than the key of the record, so they are not counted. A text that is cut in the
 * middle of a string or an object is counted as far as it goes.
 */
function countRecords(text: string, field: string): number {
  const byDepth = new Map<number, number>();
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (j >= text.length) break;
      // A string is a key when a colon follows it.
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k]!)) k++;
      if (text[k] === ":" && text.slice(i + 1, j) === field) byDepth.set(depth, (byDepth.get(depth) ?? 0) + 1);
      i = j;
    }
  }
  if (byDepth.size === 0) return 0;
  return byDepth.get(Math.min(...byDepth.keys()))!;
}

/**
 * True when `text`, the message so far, is a runaway: it holds more records than the batch has items
 * (a record is a key `shape.idField`), or its end is one unit of text written again and again. The
 * first holds when the model writes the row of one id with another heading each time; the second
 * holds when a batch has no id field.
 */
export function findRunaway(text: string, shape?: AnswerShape): boolean {
  if (shape !== undefined && countRecords(text, shape.idField) > shape.records) return true;
  return repeatsAtEnd(text);
}

/** New characters of text between two runaway checks: a check reads up to a few thousand characters. */
const CHECK_EVERY = 200;

/**
 * The extension pi loads: registers the tool-call guard, and the message guard when the harness gave an
 * answer shape. `env` is the process environment; pi passes only `pi`.
 */
export default function repeatGuard(pi: ExtensionApi, env: NodeJS.ProcessEnv = process.env): void {
  const guard = createRepeatGuard();
  pi.on("tool_call", (event) => guard.check(event.toolName, event.input));
  pi.on("session_compact", () => guard.reset());

  const shape = answerShapeFromEnv(env);
  let text = "";
  let checkedAt = 0;
  let aborted = false;
  pi.on("message_start", () => {
    text = "";
    checkedAt = 0;
    aborted = false;
  });
  pi.on("message_update", (event, ctx) => {
    const e = event?.assistantMessageEvent;
    if (aborted || e?.type !== "text_delta" || typeof e.delta !== "string") return;
    text += e.delta;
    if (text.length - checkedAt < CHECK_EVERY) return;
    checkedAt = text.length;
    if (findRunaway(text, shape)) {
      aborted = true;
      ctx.abort();
    }
  });
}
