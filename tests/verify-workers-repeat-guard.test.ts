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

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import repeatGuard, {
  ANSWER_IN_CALL_REASON,
  answerShapeFromEnv,
  callKey,
  capResult,
  CHARS_PER_TOKEN,
  COMPACTION_RESERVE_TOKENS,
  createFailureStreak,
  createRepeatGuard,
  findRunaway,
  MAX_FAILURES_IN_A_ROW,
  MIN_RESULT_CHARS,
  REPEAT_REASON,
  RUNAWAY_MIN_UNIT,
  RUNAWAY_REPEATS,
  runawayOf,
  textCallsIn,
} from "../harness/pi-extensions/repeat-guard.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "workers", name), "utf8");

describe("callKey", () => {
  test("the key does not depend on the order of the arguments", () => {
    expect(callKey("grep", { pattern: "a", path: "x" })).toBe(callKey("grep", { path: "x", pattern: "a" }));
  });

  test("a number and the same number written as a string are one call", () => {
    // pi accepts a number written as a string, and a small model writes `"limit": "10"` in one turn and
    // `"limit": 10` in the next. The result is the same, so the call is the same.
    expect(callKey("read", { path: "a.md", limit: 10 })).toBe(callKey("read", { path: "a.md", limit: "10" }));
  });

  test("a different tool or a different argument is a different call", () => {
    expect(callKey("read", { path: "a.md" })).not.toBe(callKey("grep", { path: "a.md" }));
    expect(callKey("read", { path: "a.md" })).not.toBe(callKey("read", { path: "b.md" }));
    expect(callKey("read", { path: "a.md" })).not.toBe(callKey("read", { path: "a.md", offset: 5 }));
  });
});

describe("createRepeatGuard", () => {
  test("the first call passes and the same call again is blocked with the reason", () => {
    const guard = createRepeatGuard();
    expect(guard.check("read", { path: "spec/task.md" })).toBeUndefined();
    const second = guard.check("read", { path: "spec/task.md" });
    expect(second).toEqual({ block: true, reason: REPEAT_REASON });
    expect(REPEAT_REASON).toContain("already in your context");
  });

  test("a call with other arguments passes", () => {
    const guard = createRepeatGuard();
    guard.check("read", { path: "a.md" });
    expect(guard.check("read", { path: "b.md" })).toBeUndefined();
    expect(guard.check("read", { path: "a.md", offset: 100 })).toBeUndefined();
  });

  test("a call that changes state clears what the guard knows: the same read after it can return other text", () => {
    // `--tools` is a list the caller chose. After an edit or a bash command the file or the listing may be
    // different, so reading it again is not a repeat.
    const guard = createRepeatGuard();
    guard.check("read", { path: "a.py" });
    guard.check("edit", { path: "a.py", oldText: "x", newText: "y" });
    expect(guard.check("read", { path: "a.py" })).toBeUndefined();
    expect(guard.check("read", { path: "a.py" })).toEqual({ block: true, reason: REPEAT_REASON });
  });

  test("a tool that changes state is never blocked", () => {
    // The guard is lossless only for a tool whose result is the same each time. A write is not one.
    const guard = createRepeatGuard();
    guard.check("write", { path: "out.json", content: "{}" });
    expect(guard.check("write", { path: "out.json", content: "{}" })).toBeUndefined();
    guard.check("bash", { command: "ls" });
    expect(guard.check("bash", { command: "ls" })).toBeUndefined();
  });

  test("a repeat is blocked each time and never stops the session: that is the job of the failure streak", () => {
    // A block is one kind of failed result. The streak counts every kind, so a loop of blocks and a loop
    // of calls with invalid arguments end the same way, through one rule.
    const guard = createRepeatGuard();
    guard.check("read", { path: "a.md" });
    for (let i = 0; i < 10; i++) {
      expect(guard.check("read", { path: "a.md" })).toEqual({ block: true, reason: REPEAT_REASON });
    }
  });

  test("reset forgets the calls: after a compaction the result is no longer in the context", () => {
    const guard = createRepeatGuard();
    guard.check("read", { path: "a.md" });
    guard.reset();
    expect(guard.check("read", { path: "a.md" })).toBeUndefined();
  });

  test("each guard has its own state", () => {
    const one = createRepeatGuard();
    const two = createRepeatGuard();
    one.check("read", { path: "a.md" });
    expect(two.check("read", { path: "a.md" })).toBeUndefined();
  });
});

describe("the extension", () => {
  type Handler = (event: { toolName: string; input: Record<string, unknown> }, ctx: { abort(): void }) => unknown;
  const ctx = { abort() {} };

  function load() {
    const handlers: Record<string, Handler> = {};
    repeatGuard({ on: (name: string, handler: Handler) => void (handlers[name] = handler) });
    return handlers;
  }

  test("it blocks a repeated call through the tool_call event", () => {
    const h = load();
    expect(h.tool_call!({ toolName: "grep", input: { pattern: "x", path: "workspace" } }, ctx)).toBeUndefined();
    expect(h.tool_call!({ toolName: "grep", input: { path: "workspace", pattern: "x" } }, ctx)).toEqual({
      block: true,
      reason: REPEAT_REASON,
    });
  });

  test("a compaction clears what it knows", () => {
    const h = load();
    h.tool_call!({ toolName: "read", input: { path: "a.md" } }, ctx);
    h.session_compact!({ toolName: "", input: {} }, ctx);
    expect(h.tool_call!({ toolName: "read", input: { path: "a.md" } }, ctx)).toBeUndefined();
  });
});

describe("findRunaway", () => {
  const row = (line: number) => `{"line": ${line}, "verdict": "LOGGED", "changelog_heading": "## heading ${line}", "evidence": "e"}`;

  test("a complete answer is not a runaway", () => {
    // A real final message of a batch of 4 rows.
    const text = fixture("answer-final.txt");
    expect(findRunaway(text, { idField: "line", records: 4 })).toBe(false);
    expect(findRunaway(text)).toBe(false);
  });

  test("more records than the batch has items is a runaway, at the first record that is too many", () => {
    const shape = { idField: "line", records: 4 };
    const four = `{"rows": [${[1, 2, 3, 4].map(row).join(", ")}`;
    expect(findRunaway(four, shape)).toBe(false);
    expect(findRunaway(`${four}, ${row(5)}`, shape)).toBe(true);
  });

  test("a model that writes one id again and again is found with the real runaway of a batch of 4 rows", () => {
    // The text is the first 4500 characters of a message that went on to the output limit (8192 tokens)
    // with the row of one id written 129 times, each time with another heading.
    const text = fixture("runaway-ids.txt");
    expect(findRunaway(text, { idField: "line", records: 4 })).toBe(true);
  });

  test("a unit of text that repeats at the end is a runaway when the batch has no ids", () => {
    const unit = `{"verdict": "LOGGED", "evidence": "the same text again"}, `;
    expect(unit.length).toBeGreaterThanOrEqual(RUNAWAY_MIN_UNIT);
    expect(findRunaway(`{"rows": [${row(1)}, ${unit.repeat(RUNAWAY_REPEATS)}`)).toBe(true);
    expect(findRunaway(`{"rows": [${row(1)}, ${unit.repeat(RUNAWAY_REPEATS - 1)}`)).toBe(false);
  });

  test("rows with other ids are not a loop, whatever their length", () => {
    const text = `{"rows": [${[1, 2, 3, 4, 5, 6, 7, 8].map(row).join(", ")}]}`;
    expect(findRunaway(text)).toBe(false);
  });

  test("a nested key of the id field is not a record", () => {
    // `--ids rows.id` checks the id of each record of `rows`. A record may hold other objects that have an
    // `id` of their own, so a correct answer can have more `"id":` keys than records.
    const shape = { idField: "id", records: 2 };
    const nested = `{"rows": [{"id": "a", "related": [{"id": "b"}, {"id": "c"}]}, {"id": "b", "related": []}]}`;
    expect(findRunaway(nested, shape)).toBe(false);
    // The nested keys may come before the key of their record.
    const nestedFirst = `{"rows": [{"related": [{"id": "b"}, {"id": "c"}], "id": "a"}, {"related": [], "id": "b"}]}`;
    expect(findRunaway(nestedFirst, shape)).toBe(false);
    // A record that is one too many is still found.
    expect(findRunaway(`{"rows": [{"id": "a"}, {"id": "b"}, {"id": "c"}`, shape)).toBe(true);
  });

  test("a key that is written inside a string is not a record", () => {
    const text = `{"rows": [{"line": 1, "evidence": "the row says \\"line\\": 2 and \\"line\\": 3"}]}`;
    expect(findRunaway(text, { idField: "line", records: 1 })).toBe(false);
  });

  test("a few equal elements are a legitimate answer; a run of them is a runaway", () => {
    const element = `{"ok": true, "detail": "no change was needed here"}`;
    expect(element.length).toBeGreaterThanOrEqual(RUNAWAY_MIN_UNIT);
    // A report can hold some equal entries. The unit must repeat far more often than that.
    expect(findRunaway(`{"checks": [${Array(5).fill(element).join(", ")}]}`)).toBe(false);
    // Each written element is followed by the comma that opens the next one.
    expect(findRunaway(`{"checks": [${Array(RUNAWAY_REPEATS).fill(`${element}, `).join("")}`)).toBe(true);
  });

  test("a short unit is not a runaway: a rule line or a run of nulls is legitimate", () => {
    expect(findRunaway(`{"a": [${"null, ".repeat(40)}]}`)).toBe(false);
    expect(findRunaway("-".repeat(300))).toBe(false);
  });

  test("white space does not hide a repeat", () => {
    const unit = `{"verdict": "LOGGED", "evidence": "the same text again"}`;
    const text = Array.from({ length: RUNAWAY_REPEATS }, () => unit).map((u, i) => (i % 2 ? `\n    ${u}` : `  ${u}\n`)).join("");
    expect(findRunaway(text)).toBe(true);
  });
});

describe("textCallsIn", () => {
  test("it finds a call as the template of llama3.1 writes it: the name and the arguments", () => {
    const text = '{"name": "grep", "parameters": {"pattern": "6890", "limit": 10}}';
    expect(textCallsIn(text)).toEqual([{ index: 0, tool: "grep" }]);
    expect(textCallsIn(text, ["read"])).toEqual([]);
    expect(textCallsIn(text, ["grep", "read"])).toEqual([{ index: 0, tool: "grep" }]);
  });

  test("it finds a call after prose, in a fence, and with arguments that are not JSON", () => {
    // Ollama runs a call only when the whole message is JSON that parses; these stay text.
    const text = 'Let us look.\n\n```python\n{"name": "read", "parameters": {"offset": 6871-1, "ignoreCase": True}}\n```';
    expect(textCallsIn(text)).toEqual([{ index: text.indexOf("{"), tool: "read" }]);
  });

  test("each call is found, and `arguments` is read as `parameters`", () => {
    const text = '1. {"name": "grep", "parameters": {"pattern": "a"}}\n2. {"name": "read", "arguments": {"path": "x"}}';
    expect(textCallsIn(text).map((c) => c.tool)).toEqual(["grep", "read"]);
  });

  test("an answer that quotes a call inside a string holds no call", () => {
    const answer = JSON.stringify({ rows: [{ line: 1, verdict: "LOGGED", evidence: '{"name": "grep", "parameters": {"pattern": "x"}}' }] });
    expect(textCallsIn(answer)).toEqual([]);
  });

  test("an object with a name and no parameters is not a call", () => {
    expect(textCallsIn('{"name": "grep", "path": "x"}')).toEqual([]);
    expect(textCallsIn("no braces at all")).toEqual([]);
  });
});

describe("runawayOf", () => {
  const shape = { idField: "line", records: 2 };

  test("a second call written as text in one message is a runaway, and one call is not", () => {
    // A model wrote 104 calls as one message: no unit repeats exactly, the offset changes in each,
    // so it ran to the output limit (447 s).
    const one = 'Let us look.\n{"name": "grep", "parameters": {"pattern": "a"}}';
    const tools = ["read", "grep", "find", "ls"];
    expect(runawayOf(one, shape, tools)).toBeNull();
    const two = one + '\n{"name": "read", "parameters": {"path": "x"}}';
    expect(runawayOf(two, shape, tools)).toEqual({ kind: "calls", found: 2 });
    expect(findRunaway(two, shape, tools)).toBe(true);
  });

  test("objects with a name and parameters that name no tool of the session are not calls", () => {
    // An answer can list function specs. Only a call to a tool that the session has is a call of it.
    const specs = '{"name": "get_weather", "parameters": {"city": "x"}}\n{"name": "get_time", "parameters": {"tz": "x"}}';
    expect(runawayOf(specs, shape, ["read", "grep"])).toBeNull();
    expect(runawayOf(specs, shape)).toBeNull();
  });

  test("more records than the batch has items says how many there were and how many the batch has", () => {
    expect(runawayOf('{"rows": [{"line": 1}, {"line": 2}, {"line": 3', shape)).toEqual({ kind: "records", found: 3, allowed: 2 });
  });

  test("a unit of text that is written again and again is a repeat", () => {
    const unit = "the row of this id was not found in the changelog; ";
    expect(runawayOf('{"rows": [' + unit.repeat(RUNAWAY_REPEATS + 1))).toEqual({ kind: "repeat" });
  });

  test("an answer that fits the batch is not a runaway", () => {
    expect(runawayOf('{"rows": [{"line": 1}, {"line": 2}]}', shape)).toBeNull();
    expect(runawayOf("Done.")).toBeNull();
  });

  test("findRunaway is true exactly when runawayOf names a runaway", () => {
    const texts = ['{"rows": [{"line": 1}, {"line": 2}, {"line": 3', '{"rows": [{"line": 1}]}', "x".repeat(40).repeat(20), "short"];
    for (const t of texts) expect(findRunaway(t, shape)).toBe(runawayOf(t, shape) !== null);
  });
});

describe("answerShapeFromEnv", () => {
  test("it reads the id field and the number of records", () => {
    expect(answerShapeFromEnv({ VERIHARNESS_ANSWER_SHAPE: JSON.stringify({ idField: "line", records: 4 }) })).toEqual({ idField: "line", records: 4 });
  });

  test("it reads the name of the list that holds the records, when the harness gives it", () => {
    const env = { VERIHARNESS_ANSWER_SHAPE: JSON.stringify({ idField: "line", records: 4, listField: "rows" }) };
    expect(answerShapeFromEnv(env)).toEqual({ idField: "line", records: 4, listField: "rows" });
  });

  test("a missing or a damaged value gives no shape, and never an error: the guard must not stop a session", () => {
    expect(answerShapeFromEnv({})).toBeUndefined();
    expect(answerShapeFromEnv({ VERIHARNESS_ANSWER_SHAPE: "{" })).toBeUndefined();
    expect(answerShapeFromEnv({ VERIHARNESS_ANSWER_SHAPE: JSON.stringify({ idField: "line" }) })).toBeUndefined();
    expect(answerShapeFromEnv({ VERIHARNESS_ANSWER_SHAPE: JSON.stringify({ idField: "", records: 4 }) })).toBeUndefined();
  });
});

describe("the extension watches the text of a message", () => {
  type Handler = (event: unknown, ctx: { abort(): void }) => unknown;

  function load(env: NodeJS.ProcessEnv = {}, tools: { name: string }[] = []) {
    const handlers: Record<string, Handler> = {};
    let aborts = 0;
    const api = { on: (name: string, handler: Handler) => void (handlers[name] = handler), getAllTools: () => tools };
    repeatGuard(api as never, env);
    const ctx = { abort: () => void aborts++ };
    const delta = (text: string) =>
      handlers.message_update!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } }, ctx);
    return { handlers, delta, ctx, aborts: () => aborts };
  }

  test("it aborts the turn once, when the text has more records than the batch", () => {
    // The text is read each CHECK_EVERY characters, so a row here is longer than that.
    const { delta, aborts } = load({ VERIHARNESS_ANSWER_SHAPE: JSON.stringify({ idField: "line", records: 2 }) });
    const row = (n: number) => `{"line": ${n}, "evidence": "${"x".repeat(250)}"},`;
    delta(`{"rows": [${row(1)}`);
    delta(` ${row(2)}`);
    expect(aborts()).toBe(0);
    delta(` ${row(3)}`);
    expect(aborts()).toBe(1);
    delta(` ${row(4)}`);
    expect(aborts()).toBe(1);
  });

  test("it aborts a message that writes a second tool call as text, and not the first", () => {
    const { delta, aborts } = load({}, [{ name: "read" }, { name: "grep" }]);
    const call = (n: number) => `{"name": "read", "parameters": {"path": "f${n}.md", "note": "${"x".repeat(250)}"}}`;
    delta(`Let us look.\n${call(1)}`);
    expect(aborts()).toBe(0);
    delta(`\n${call(2)}`);
    expect(aborts()).toBe(1);
  });

  test("two objects with a name and parameters are left alone when the session has no tool of that name", () => {
    const { delta, aborts } = load({}, [{ name: "read" }]);
    const spec = (n: number) => `{"name": "get_item_${n}", "parameters": {"note": "${"x".repeat(250)}"}}`;
    delta(spec(1));
    delta(spec(2));
    delta(spec(3));
    expect(aborts()).toBe(0);
  });

  test("a new message starts a new text", () => {
    const { handlers, delta, ctx, aborts } = load({ VERIHARNESS_ANSWER_SHAPE: JSON.stringify({ idField: "line", records: 1 }) });
    const row = `{"line": 1, "evidence": "${"x".repeat(250)}"}`;
    delta(row);
    handlers.message_start!({ type: "message_start" }, ctx);
    delta(row);
    expect(aborts()).toBe(0);
  });

  test("a delta that is not text is ignored", () => {
    const { handlers, ctx, aborts } = load({ VERIHARNESS_ANSWER_SHAPE: JSON.stringify({ idField: "line", records: 1 }) });
    for (let i = 0; i < 5; i++) {
      handlers.message_update!({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: `{"line": 1, "x": "${"x".repeat(250)}"}` } }, ctx);
    }
    expect(aborts()).toBe(0);
  });
});

describe("createFailureStreak", () => {
  test("it asks for a stop at the limit, and not before", () => {
    const streak = createFailureStreak();
    for (let i = 1; i < MAX_FAILURES_IN_A_ROW; i++) expect(streak.record(true)).toBe(false);
    expect(streak.record(true)).toBe(true);
  });

  test("a result that worked starts the count again", () => {
    const streak = createFailureStreak();
    for (let i = 1; i < MAX_FAILURES_IN_A_ROW; i++) streak.record(true);
    expect(streak.record(false)).toBe(false);
    for (let i = 1; i < MAX_FAILURES_IN_A_ROW; i++) expect(streak.record(true)).toBe(false);
    expect(streak.record(true)).toBe(true);
  });

  test("it asks again at each failure after the limit: a stop that did not take effect is made again", () => {
    const streak = createFailureStreak();
    for (let i = 0; i < MAX_FAILURES_IN_A_ROW; i++) streak.record(true);
    expect(streak.record(true)).toBe(true);
    expect(streak.record(true)).toBe(true);
    expect(streak.record(false)).toBe(false);
  });
});

describe("capResult", () => {
  const text = (n: number) => [{ type: "text" as const, text: "x".repeat(n) }];
  const textOf = (content: { type: string; text?: string }[]) => content.map((c) => c.text ?? "").join("");
  const window = 65536;
  const budget = window - COMPACTION_RESERVE_TOKENS;
  const usage = (tokens: number | null) => ({ tokens, contextWindow: window });

  test("a result that fits in half of the room is not touched", () => {
    expect(capResult(text(5000), usage(10000))).toBeUndefined();
  });

  test("a context of unknown size is not touched: nothing is known to cut against", () => {
    expect(capResult(text(900_000), usage(null))).toBeUndefined();
    expect(capResult(text(900_000), undefined)).toBeUndefined();
  });

  test("a result of 51343 characters in a context of 19000 tokens is cut to half of the room, and the notice says so", () => {
    // b06 r01 of run 7: three results of this size took the context from 20k to 49k tokens and it compacted.
    const room = budget - 19000;
    const cap = Math.floor((room / 2) * CHARS_PER_TOKEN);
    const out = capResult(text(51343), usage(19000))!;
    const body = textOf(out);
    expect(body.startsWith("x".repeat(cap))).toBe(true);
    expect(body.length).toBeGreaterThan(cap);
    expect(body.length).toBeLessThan(cap + 700);
    expect(body).toContain("51343");
    expect(body).toContain(String(cap));
  });

  test("each result may take half of the room that is left, so a result alone does not force a compaction", () => {
    let used = 19000;
    for (let i = 0; i < 6; i++) {
      const room = budget - used;
      const out = capResult(text(60_000), usage(used));
      const length = out ? textOf(out).replace(/\n\n\[[^\]]*\]$/, "").length : 60_000;
      expect(length).toBeLessThanOrEqual(Math.max(MIN_RESULT_CHARS, Math.floor((room / 2) * CHARS_PER_TOKEN)));
      used += Math.ceil(length / CHARS_PER_TOKEN);
      expect(used).toBeLessThan(budget);
    }
  });

  test("the cap does not go below MIN_RESULT_CHARS: a result is never cut to nothing", () => {
    const out = capResult(text(20_000), usage(budget - 10))!;
    const body = textOf(out);
    expect(body.startsWith("x".repeat(MIN_RESULT_CHARS))).toBe(true);
    expect(body.length).toBeLessThan(MIN_RESULT_CHARS + 700);
  });

  test("the cut is made at the end of a line when one is near", () => {
    const line = "a".repeat(99) + "\n";
    const out = capResult([{ type: "text", text: line.repeat(900) }], usage(19000))!;
    const body = textOf(out);
    const kept = body.split("\n\n[")[0]!;
    expect(kept.endsWith("a")).toBe(true);
    expect(kept.length % 100).toBe(99);
  });

  test("a part that is not text is kept", () => {
    const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
    const out = capResult([...text(60_000), image], usage(19000))!;
    expect(out.some((c) => c.type === "image")).toBe(true);
  });

  test("results that were granted and are not in the context yet are taken from the room", () => {
    // Pi runs the calls of one message together, so none of their results is in the context when the
    // next is sized. The caller says how many tokens it has handed out since.
    const alone = textOf(capResult(text(60_000), usage(19000))!).length;
    const after = textOf(capResult(text(60_000), usage(19000), 15000)!).length;
    expect(after).toBeLessThan(alone);
    const room = budget - 19000 - 15000;
    expect(after).toBeLessThanOrEqual(Math.floor((room / 2) * CHARS_PER_TOKEN) + 700);
  });

  test("a context size that is not a number is not cut against", () => {
    expect(capResult(text(900_000), { tokens: undefined as unknown as number, contextWindow: window })).toBeUndefined();
  });

  test("a text part that is dropped whole still leaves the notice", () => {
    // The first part has exactly the room, so the second has none, and a result with no notice would say
    // nothing about what is missing.
    const cap = Math.floor(((budget - 19000) / 2) * CHARS_PER_TOKEN);
    const out = capResult([{ type: "text", text: "a".repeat(cap) }, { type: "text", text: "b".repeat(5000) }], usage(19000))!;
    const body = textOf(out);
    expect(body).toContain("[Cut here.");
    expect(body).not.toContain("bbbbbbbbbb");
  });
});

describe("the extension refuses a call that the tool does not declare", () => {
  type Handler = (event: unknown, ctx: unknown) => unknown;
  const TOOLS = [
    { name: "ls", parameters: { type: "object", properties: { path: {}, limit: {} } } },
    { name: "read", parameters: { type: "object", properties: { path: {}, offset: {}, limit: {} }, required: ["path"] } },
  ];
  const SHAPE = { VERIHARNESS_ANSWER_SHAPE: JSON.stringify({ idField: "line", records: 3, listField: "rows" }) };

  /** `tools` null: a session whose API has no list of tools. */
  function load(env: NodeJS.ProcessEnv = {}, tools: unknown = TOOLS) {
    const handlers: Record<string, Handler> = {};
    let aborts = 0;
    const api: Record<string, unknown> = { on: (name: string, handler: Handler) => void (handlers[name] = handler) };
    if (tools !== null) api.getAllTools = () => tools;
    repeatGuard(api as never, env);
    const ctx = { abort: () => void aborts++ };
    const call = (toolName: string, input: Record<string, unknown>) =>
      handlers.tool_call!({ toolName, input }, ctx) as { block?: boolean; reason?: string } | undefined;
    const turn = (...failed: boolean[]) => handlers.turn_end!({ toolResults: failed.map((isError) => ({ role: "toolResult", isError })) }, ctx);
    return { call, turn, aborts: () => aborts };
  }

  test("an argument that the tool does not list blocks the call, and the reason names what the tool takes", () => {
    // Pi ignores such an argument and runs the call, so the model reads a result of a call it did not make.
    const { call } = load();
    const r = call("ls", { path: "workspace", foo: 1 })!;
    expect(r.block).toBe(true);
    expect(r.reason).toContain("foo");
    expect(r.reason).toContain("ls");
    expect(r.reason).toContain("path, limit");
  });

  test("a call with the arguments of the tool is not touched", () => {
    const { call } = load();
    expect(call("read", { path: "a.md", offset: "5", limit: 10 })).toBeUndefined();
    expect(call("ls", {})).toBeUndefined();
  });

  test("a call that was refused is not a repeat: it is refused for its arguments each time, and the call that is right runs", () => {
    const { call } = load();
    const first = call("ls", { path: "workspace", foo: 1 })!;
    const again = call("ls", { path: "workspace", foo: 1 })!;
    expect(first.reason).toBe(again.reason);
    expect(again.reason).not.toBe(REPEAT_REASON);
    // The right call is the one that was refused with `foo` taken out: it was never recorded, so it runs.
    expect(call("ls", { path: "workspace" })).toBeUndefined();
    // And now it is a call that was made.
    expect(call("ls", { path: "workspace" })!.reason).toBe(REPEAT_REASON);
  });

  test("a tool that the session does not list, or a session that lists none, is left to pi", () => {
    expect(load({}, TOOLS).call("grep", { pattern: "x", anything: 1 })).toBeUndefined();
    expect(load({}, null).call("ls", { foo: 1 })).toBeUndefined();
    expect(load({}, []).call("ls", { foo: 1 })).toBeUndefined();
  });

  test("a schema with no properties is not read as a list of none", () => {
    const { call } = load({}, [{ name: "ls", parameters: { type: "object" } }]);
    expect(call("ls", { foo: 1 })).toBeUndefined();
  });

  test("a call that holds the records of the answer says so, and ends the session at the end of its turn", () => {
    // Llama 3.1 writes its answer as {"name": "ls", "parameters": {"rows": [...]}}: the template tells it to
    // answer as a function call. A tool that cannot take the answer is no place for it.
    const { call, turn, aborts } = load(SHAPE);
    const r = call("ls", { rows: [{ line: 1, verdict: "LOGGED" }] })!;
    expect(r.block).toBe(true);
    expect(r.reason).toContain("answer");
    expect(r.reason).toContain("text of your next message");
    expect(aborts()).toBe(0);
    turn(true);
    expect(aborts()).toBe(1);
  });

  test("a call with other undeclared arguments does not end the session by itself", () => {
    const { call, turn, aborts } = load(SHAPE);
    expect(call("ls", { path: "workspace", foo: 1 })!.block).toBe(true);
    turn(true);
    expect(aborts()).toBe(0);
  });

  test("a list under another name, or records with no id field, is not the answer", () => {
    const { call, turn, aborts } = load(SHAPE);
    expect(call("ls", { items: [{ line: 1 }] })!.reason).not.toBe(ANSWER_IN_CALL_REASON);
    expect(call("ls", { rows: ["a", "b"] })!.reason).not.toBe(ANSWER_IN_CALL_REASON);
    turn(true);
    expect(aborts()).toBe(0);
  });

  test("a stop that did not take effect is asked for again at the end of each turn that follows", () => {
    // The abort can come between two turns. A session that goes on is still one whose answer is in a call.
    const { call, turn, aborts } = load(SHAPE);
    call("ls", { rows: [{ line: 1 }] });
    turn(true);
    turn(false);
    expect(aborts()).toBe(2);
  });
});

describe("the extension stops a session that fails and sizes the results", () => {
  type Handler = (event: unknown, ctx: unknown) => unknown;

  function load(tokens: number | null = 19000) {
    const handlers: Record<string, Handler> = {};
    let aborts = 0;
    repeatGuard({ on: (name: string, handler: Handler) => void (handlers[name] = handler) } as never, {});
    const ctx = { abort: () => void aborts++, getContextUsage: () => ({ tokens, contextWindow: 65536 }) };
    // The end of a turn, with the results of its tool calls: `true` is a result that failed.
    const turn = (...failed: boolean[]) =>
      handlers.turn_end!({ toolResults: failed.map((isError) => ({ role: "toolResult", isError })) }, ctx);
    const toolResultEnd = (isError: boolean) => handlers.message_end?.({ message: { role: "toolResult", isError } }, ctx);
    return { handlers, ctx, turn, toolResultEnd, aborts: () => aborts };
  }

  test("it aborts when MAX_FAILURES_IN_A_ROW turns in a row had only failed results", () => {
    const { turn, aborts } = load();
    for (let i = 1; i < MAX_FAILURES_IN_A_ROW; i++) turn(true);
    expect(aborts()).toBe(0);
    turn(true);
    expect(aborts()).toBe(1);
  });

  test("a turn with one result that worked starts the count again", () => {
    const { turn, aborts } = load();
    turn(true);
    turn(true, false);
    turn(true);
    turn(true);
    expect(aborts()).toBe(0);
  });

  test("three failed calls in one turn are one failed turn: the model has not yet read a result", () => {
    // Pi runs the calls of a message together, so a model that guesses three paths in one message gets
    // three errors at once. Stopping it there would end a session that never saw one of them.
    const { turn, aborts } = load();
    turn(true, true, true);
    expect(aborts()).toBe(0);
    turn(true, true, true);
    expect(aborts()).toBe(0);
    turn(true, true, true);
    expect(aborts()).toBe(1);
  });

  test("a result that ends does not abort by itself", () => {
    const { toolResultEnd, aborts } = load();
    for (let i = 0; i < 2 * MAX_FAILURES_IN_A_ROW; i++) toolResultEnd(true);
    expect(aborts()).toBe(0);
  });

  test("a turn with no tool call neither counts nor breaks the run", () => {
    const { turn, aborts } = load();
    turn(true);
    turn();
    turn(true);
    turn(true);
    expect(aborts()).toBe(1);
  });

  test("a tool result that is too big for the room is cut through the tool_result event", () => {
    const { handlers, ctx } = load(19000);
    const event = { type: "tool_result", toolName: "grep", content: [{ type: "text", text: "y".repeat(51343) }], isError: false };
    const out = handlers.tool_result!(event, ctx) as { content: { text: string }[] };
    expect(out.content[0]!.text.length).toBeLessThan(51343);
    expect(handlers.tool_result!({ ...event, content: [{ type: "text", text: "short" }] }, ctx)).toBeUndefined();
  });

  test("a compaction clears the failure count: the results that failed are gone from the context", () => {
    const { handlers, ctx, turn, aborts } = load();
    turn(true);
    turn(true);
    handlers.session_compact!({}, ctx);
    turn(true);
    expect(aborts()).toBe(0);
  });

  test("the results of one message share the room: each is sized with the ones before it taken out", () => {
    // Pi runs three calls of one message together: the three tool_result events come before any result
    // is in the context, so each one reads the same context size. 60000 characters are 20000 tokens,
    // and the room of this context is 30000.
    const { handlers, ctx } = load(19000);
    const event = { type: "tool_result", toolName: "grep", content: [{ type: "text", text: "y".repeat(60_000) }], isError: false };
    const sized = [0, 1, 2].map(() => (handlers.tool_result!(event, ctx) as { content: { text: string }[] }).content[0]!.text.length);
    const room = 65536 - COMPACTION_RESERVE_TOKENS - 19000;
    const tokens = sized.reduce((n, chars) => n + chars / CHARS_PER_TOKEN, 0);
    expect(tokens).toBeLessThan(room);
    expect(sized[1]).toBeLessThan(sized[0]!);
    // Once the results are in the context, the next one is sized against what the context reports.
    handlers.message_end!({ message: { role: "toolResult", isError: false } }, ctx);
    const next = (handlers.tool_result!(event, ctx) as { content: { text: string }[] }).content[0]!.text.length;
    expect(next).toBe(sized[0]);
  });

  test("a result that fits is counted in what was granted", () => {
    const { handlers, ctx } = load(19000);
    const small = { type: "tool_result", toolName: "read", content: [{ type: "text", text: "z".repeat(30_000) }], isError: false };
    const big = { type: "tool_result", toolName: "grep", content: [{ type: "text", text: "y".repeat(60_000) }], isError: false };
    expect(handlers.tool_result!(small, ctx)).toBeUndefined();
    const first = (handlers.tool_result!(big, ctx) as { content: { text: string }[] }).content[0]!.text.length;
    handlers.message_end!({ message: { role: "toolResult", isError: false } }, ctx);
    const alone = (handlers.tool_result!(big, ctx) as { content: { text: string }[] }).content[0]!.text.length;
    expect(first).toBeLessThan(alone);
  });
});
