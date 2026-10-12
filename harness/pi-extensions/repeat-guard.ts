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
 * A pi extension for a worker session. It keeps a small model from three things it cannot leave by
 * itself:
 *
 * - A tool call that repeats an earlier call of the session is blocked. The tools of a worker only
 *   read, so the second call returns the text the model already has. The block tells the model so,
 *   in the place where the result would be.
 * - MAX_FAILURES_IN_A_ROW turns in a row in which every tool call failed stop the session
 *   (`ctx.abort()`), whatever the cause: a block, arguments the tool does not accept, a path that is
 *   not there. Pi checks the arguments of a call before it tells an extension about the call, so the
 *   result of the turn is the place where every failure is seen. A turn is the unit because pi runs
 *   the calls of one message together: the model has read none of their results when they end. The
 *   harness then asks the model for the answer on a turn that has no tools.
 * - A final message that has more records than the batch has items, or that repeats one unit of text,
 *   is cut at that point (`ctx.abort()`). Left alone, it runs to the output limit: one row written
 *   a hundred times, which costs ten minutes on a local model. The harness sees the aborted message
 *   as a cut one and asks for the answer again, with the message removed from the session; it names
 *   the reason with `runawayOf`, so the model is told why the message was cut.
 * - A call with an argument that the tool does not list is blocked, and the block names the arguments
 *   that the tool takes. Pi ignores such an argument and runs the call, so the model would read the
 *   result of a call that it did not make. A call whose arguments hold the records of the answer is
 *   blocked too, and ends the session at the end of its turn: a local model that is given tools is told
 *   by its template to answer as a function call, and then sends its answer to the first tool it names.
 *   The harness then asks for the answer on a turn that has no tools.
 * - A message that writes a second call to a tool of the session as text is cut like a runaway. The
 *   template of a local model asks for a call as a JSON object, and a model that writes its whole plan as
 *   a message of calls (104 in one message) runs to the output limit: the offset
 *   changes in each call, so no unit repeats exactly. Only a call to a tool of the session counts, so
 *   an answer that lists other objects with a name and parameters is left alone. The harness sees the
 *   cut message and asks for one call.
 *
 * It also sizes each tool result to the room that is left before pi compacts the context, so that
 * one result cannot be the call that forces a compaction (see `capResult`).
 *
 * Pi loads this file with `-e`. It imports nothing from pi: the types below are the part of the pi
 * extension API that it uses.
 */

/** The tools whose result is the same each time they are called with the same arguments. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

/**
 * Turns in a row, in which every tool call failed, after which the session is stopped. Over runs 5 to 7
 * a streak of 2 failed calls was followed by a call that worked in 12 of 16 cases, and a streak of 3 or
 * more in 3 of 22; the longest (34 calls with arguments the tool does not accept, b16 r03) never ended
 * on its own. The worker charter asks for one call in a message, so a turn is mostly one call.
 */
export const MAX_FAILURES_IN_A_ROW = 3;

/** What the model reads in place of the result of a blocked call. */
export const REPEAT_REASON =
  "Blocked: this call is the same as an earlier call in this session, and its result is already in your context. Do not repeat it. Use a different call, or write your final answer now.";

/** What a `tool_call` handler returns to stop the call. */
export interface BlockResult {
  block: true;
  reason: string;
}

/** The context of a session as pi reports it: `tokens` is null right after a compaction. */
export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
}

/** The part of the pi extension context that the guard uses. */
export interface ExtensionContext {
  abort(): void;
  getContextUsage?(): ContextUsage | undefined;
}

/** The part of the pi extension API that this file uses. */
export interface ExtensionApi {
  // The handler of each event has its own event type in pi; the guard reads the few fields it names.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown): void;
  /** The tools of the session with their argument schemas (pi 0.84.4 `getAllTools`). */
  getAllTools?(): { name: string; parameters?: unknown }[];
}

/** What the model reads in place of the result of a call that holds its answer. */
export const ANSWER_IN_CALL_REASON =
  "Blocked: this call holds your answer. An answer is the text of a message, not the arguments of a tool call. No tool is offered now: write the answer as the text of your next message.";

/** The names that the argument schema of a tool lists, or undefined when it lists none. */
export function declaredArguments(parameters: unknown): string[] | undefined {
  const properties = (parameters as { properties?: unknown } | null | undefined)?.properties;
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return undefined;
  return Object.keys(properties);
}

/** The names in `input` that `declared` does not list. */
export function undeclaredArguments(input: unknown, declared: readonly string[]): string[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return [];
  return Object.keys(input).filter((key) => !declared.includes(key));
}

/** What the model reads in place of the result of a call with an argument that its tool does not list. */
export function undeclaredReason(toolName: string, extra: readonly string[], declared: readonly string[]): string {
  const takes = declared.length === 0 ? "It takes no arguments." : `It takes: ${declared.join(", ")}.`;
  const names = extra.map((name) => `'${name}'`).join(", ");
  return `Blocked: the ${toolName} tool has no argument ${names}. ${takes} Call it again with only those arguments, or write your final answer now.`;
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

/** The state of one session: the calls it has made. */
export function createRepeatGuard() {
  const seen = new Set<string>();
  return {
    /** `undefined` lets the call run. A block result stops it. */
    check(toolName: string, input: Record<string, unknown>): BlockResult | undefined {
      if (!READ_ONLY_TOOLS.has(toolName)) {
        // `--tools` is a list the caller chose. A call that can change a file or a listing makes the
        // results that the session holds old: the same read after it can return other text.
        seen.clear();
        return undefined;
      }
      const key = callKey(toolName, input);
      if (!seen.has(key)) {
        seen.add(key);
        return undefined;
      }
      return { block: true, reason: REPEAT_REASON };
    },
    /** A compaction replaces the results in the context, so the calls that were made are not "already in" it. */
    reset(): void {
      seen.clear();
    },
  };
}

/** Counts the failures in a row: one for each turn in which every tool call failed. */
export function createFailureStreak(limit: number = MAX_FAILURES_IN_A_ROW) {
  let failures = 0;
  return {
    /**
     * True at the failure that reaches the limit, and at each one after it: a stop that was asked for
     * and did not take effect (the abort came between two turns) is asked for again.
     */
    record(failed: boolean): boolean {
      if (!failed) {
        failures = 0;
        return false;
      }
      failures += 1;
      return failures >= limit;
    },
    reset(): void {
      failures = 0;
    },
  };
}

/** Tokens that pi holds back from the window: it compacts above `window - reserve` (pi 0.84.4 `reserveTokens`). */
export const COMPACTION_RESERVE_TOKENS = 16384;
/** The share of the room that is left that one tool result may take. */
export const RESULT_SHARE = 0.5;
/**
 * Characters that one token of a tool result costs, or more. Measured on llama3.1: 47396 characters of an
 * index cost 16078 tokens (2.95 each), and 51343 characters of grep output 14561 (3.5 each). The lower
 * figure cuts a result a little earlier; it never lets one through that is larger than the room.
 */
export const CHARS_PER_TOKEN = 3;
/** A result is never cut below this: a model that gets a few lines can still tell what it asked for. */
export const MIN_RESULT_CHARS = 1000;

/** A part of the content of a tool result. */
export interface ResultPart {
  type: string;
  text?: string;
}

/** The characters of text in the content of a tool result. */
export function textLength(content: readonly ResultPart[]): number {
  return content.reduce((n, part) => n + (part.type === "text" ? (part.text ?? "").length : 0), 0);
}

/**
 * The content of a tool result, cut to the room, or undefined when it fits.
 *
 * The harness counts a compaction as a failure: the answer would rest on turns the worker no longer holds.
 * Pi cuts a result at 50 KB, which is 14 to 16k tokens, and a window of 65536 tokens compacts above 49152:
 * three results that a model could not size before the call were enough. A result may
 * take at most RESULT_SHARE of the room that is left, so the next result gets half of what is then left,
 * and the notice tells the model how to ask for less.
 *
 * `granted`: tokens of results that were handed out and that the context does not hold yet. Pi runs the
 * calls of one message together, so the results of a message are sized before any of them is in the
 * context, and each would read the same room.
 */
export function capResult<T extends ResultPart>(content: readonly T[], usage: ContextUsage | undefined, granted = 0): T[] | undefined {
  if (usage === undefined || typeof usage.tokens !== "number" || !Number.isFinite(usage.tokens)) return undefined;
  const room = Math.max(0, usage.contextWindow - COMPACTION_RESERVE_TOKENS - usage.tokens - granted);
  const cap = Math.max(MIN_RESULT_CHARS, Math.floor(room * RESULT_SHARE * CHARS_PER_TOKEN));
  const total = textLength(content);
  if (total <= cap) return undefined;
  const notice =
    `\n\n[Cut here. This result had ${total} characters. Your context has room for about ${room} more tokens, ` +
    `so one result may hold ${cap} characters. Ask for less: a smaller limit, a smaller context, or a more exact pattern.]`;
  const out: T[] = [];
  let left = cap;
  let noticed = false;
  for (const part of content) {
    if (part.type !== "text") {
      out.push(part);
      continue;
    }
    const text = part.text ?? "";
    if (left <= 0) continue;
    if (text.length <= left) {
      out.push(part);
      left -= text.length;
      continue;
    }
    let kept = text.slice(0, left);
    // End at a line when one ends in the last quarter of what is kept: a line cut in the middle reads as a
    // value that is wrong.
    const newline = kept.lastIndexOf("\n");
    if (newline >= left * 0.75) kept = kept.slice(0, newline);
    out.push({ ...part, text: kept + notice });
    noticed = true;
    left = 0;
  }
  // The room ended exactly at the end of a part: what follows was dropped, and the model is told so.
  if (!noticed) out.push({ type: "text", text: notice.trimStart() } as T);
  return out;
}

/** What the harness tells the guard about the answer it expects: one record for each item of the batch. */
export interface AnswerShape {
  /** The field that holds the id of a record (`--ids ARRAY.FIELD`). */
  idField: string;
  /** The number of items of the batch, so the number of records the answer may have. */
  records: number;
  /** The name of the list that holds the records (`--ids ARRAY.FIELD`), so a call that carries the answer is known. */
  listField?: string;
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
      const listField = typeof v.listField === "string" && v.listField !== "" ? v.listField : undefined;
      return { idField: v.idField, records: v.records, ...(listField !== undefined ? { listField } : {}) };
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
 * The start of a tool call as the chat template of llama3.1 asks for it: `{"name": <tool>, "parameters": {`.
 * `arguments` is read as `parameters`. A quote inside a string of an answer is escaped, so a call that is
 * quoted there does not match: the pattern needs the brace and the quote next to each other.
 */
const TEXT_CALL = /\{\s*"name"\s*:\s*"([^"\\]+)"\s*,\s*"(?:parameters|arguments)"\s*:\s*\{/g;

/** A tool call that is written in the text of a message: where it starts, and the tool it names. */
export interface TextCallStart {
  index: number;
  tool: string;
}

/**
 * The tool calls that `text` writes as text, in order. Ollama runs a call of this form only when the whole
 * message parses as JSON; prose before the call, or an argument that is not JSON (`True`, `6871-1`), leaves
 * it as text, and the session ends with the message as its last one. `tools`: the names of the tools of
 * the session; a call to another name is not one, and is left out. Absent: every call of the form.
 */
export function textCallsIn(text: string, tools?: readonly string[]): TextCallStart[] {
  const all = [...text.matchAll(TEXT_CALL)].map((m) => ({ index: m.index!, tool: m[1]! }));
  return tools === undefined ? all : all.filter((c) => tools.includes(c.tool));
}

/** Calls written as text in one message, from which the message is a runaway. The charter asks for one call in a message. */
export const RUNAWAY_CALLS = 2;

/**
 * Why a message is a runaway: more records than the batch has items, calls written as text one after
 * another, or text that repeats at its end.
 */
export type Runaway = { kind: "records"; found: number; allowed: number } | { kind: "calls"; found: number } | { kind: "repeat" };

/**
 * The runaway that `text`, the message so far, is, or null: it holds more records than the batch has items
 * (a record is a key `shape.idField`), or it writes RUNAWAY_CALLS calls to the `tools` of the session as
 * text, or its end is one unit of text written again and again. The first holds when the model writes
 * the row of one id with another heading each time; the second when it scripts its calls in one
 * message; the third when a batch has no id field. The harness asks the same question of the message
 * that the guard cut, to tell the model what it saw. No `tools`: calls are not looked for.
 */
export function runawayOf(text: string, shape?: AnswerShape, tools: readonly string[] = []): Runaway | null {
  if (shape !== undefined) {
    const found = countRecords(text, shape.idField);
    if (found > shape.records) return { kind: "records", found, allowed: shape.records };
  }
  const calls = textCallsIn(text, tools).length;
  if (calls >= RUNAWAY_CALLS) return { kind: "calls", found: calls };
  return repeatsAtEnd(text) ? { kind: "repeat" } : null;
}

/** True when `text`, the message so far, is a runaway (see `runawayOf`). */
export function findRunaway(text: string, shape?: AnswerShape, tools: readonly string[] = []): boolean {
  return runawayOf(text, shape, tools) !== null;
}

/** True when `input` holds a list of the shape's name whose elements are records (objects with the id field). */
function holdsAnswer(input: unknown, shape: AnswerShape | undefined): boolean {
  if (shape?.listField === undefined || input === null || typeof input !== "object") return false;
  const list = (input as Record<string, unknown>)[shape.listField];
  return (
    Array.isArray(list) &&
    list.some((r) => r !== null && typeof r === "object" && !Array.isArray(r) && shape.idField in (r as object))
  );
}

/** New characters of text between two runaway checks: a check reads up to a few thousand characters. */
const CHECK_EVERY = 200;

/**
 * The extension pi loads: registers the tool-call guard, and the message guard when the harness gave an
 * answer shape. `env` is the process environment; pi passes only `pi`.
 */
export default function repeatGuard(pi: ExtensionApi, env: NodeJS.ProcessEnv = process.env): void {
  const guard = createRepeatGuard();
  const streak = createFailureStreak();
  const shape = answerShapeFromEnv(env);
  // The arguments that each tool lists. The tools are registered after the extensions are loaded, so the
  // list is read at the first call; a session that gives no list is left to the checks of pi.
  const declared = new Map<string, string[]>();
  const tools = new Set<string>();
  const load = (): void => {
    if (tools.size > 0) return;
    try {
      for (const tool of pi.getAllTools?.() ?? []) {
        tools.add(tool.name);
        const names = declaredArguments(tool.parameters);
        if (names !== undefined) declared.set(tool.name, names);
      }
    } catch {
      // The check is an aid: a session whose tools cannot be read keeps the checks of pi.
    }
  };
  const declaredFor = (toolName: string): string[] | undefined => {
    load();
    return declared.get(toolName);
  };
  // True once a call held the answer: the session is stopped at the end of that turn.
  let answered = false;
  pi.on("tool_call", (event) => {
    if (holdsAnswer(event.input, shape)) {
      answered = true;
      return { block: true, reason: ANSWER_IN_CALL_REASON } satisfies BlockResult;
    }
    const names = declaredFor(event.toolName);
    if (names !== undefined) {
      const extra = undeclaredArguments(event.input, names);
      if (extra.length > 0) return { block: true, reason: undeclaredReason(event.toolName, extra, names) } satisfies BlockResult;
    }
    return guard.check(event.toolName, event.input);
  });
  // Tokens of results handed out and not yet in the context. Pi runs the calls of one message together,
  // so all their tool_result events come before the first result is added to the context.
  let granted = 0;
  pi.on("session_compact", () => {
    guard.reset();
    streak.reset();
    granted = 0;
    answered = false;
  });
  pi.on("tool_result", (event, ctx) => {
    const content = event?.content ?? [];
    const capped = capResult(content, ctx.getContextUsage?.(), granted);
    granted += Math.ceil(textLength(capped ?? content) / CHARS_PER_TOKEN);
    return capped === undefined ? undefined : { content: capped };
  });
  // A result that ends is in the context, and the context size counts it from here on.
  pi.on("message_end", (event) => {
    if (event?.message?.role === "toolResult") granted = 0;
  });
  // The end of a turn has the results of all its calls. A turn in which every call failed is one failure.
  // A call that held the answer ends the session at once, and again at each later turn if the abort did
  // not take effect.
  pi.on("turn_end", (event, ctx) => {
    const results: { isError?: boolean }[] = Array.isArray(event?.toolResults) ? event.toolResults : [];
    if (results.length === 0) return;
    const stop = streak.record(results.every((r) => r?.isError === true));
    if (stop || answered) ctx.abort();
  });

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
    load();
    if (findRunaway(text, shape, [...tools])) {
      aborted = true;
      ctx.abort();
    }
  });
}
