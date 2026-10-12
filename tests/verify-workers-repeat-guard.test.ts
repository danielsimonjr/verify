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
  answerShapeFromEnv,
  callKey,
  createRepeatGuard,
  findRunaway,
  MAX_BLOCKS_IN_A_ROW,
  REPEAT_REASON,
  RUNAWAY_MIN_UNIT,
  RUNAWAY_REPEATS,
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

  test("a loop is ended after MAX_BLOCKS_IN_A_ROW blocks, and a call that passes starts the count again", () => {
    const guard = createRepeatGuard();
    guard.check("read", { path: "a.md" });
    for (let i = 1; i < MAX_BLOCKS_IN_A_ROW; i++) {
      expect(guard.check("read", { path: "a.md" })).toEqual({ block: true, reason: REPEAT_REASON });
    }
    // A call that passes breaks the run.
    expect(guard.check("read", { path: "b.md" })).toBeUndefined();
    for (let i = 1; i < MAX_BLOCKS_IN_A_ROW; i++) {
      expect(guard.check("read", { path: "a.md" })).toEqual({ block: true, reason: REPEAT_REASON });
    }
    // The block that reaches the limit stops the session: the harness then asks for the answer.
    expect(guard.check("read", { path: "a.md" })).toEqual({ block: true, reason: REPEAT_REASON, terminate: true });
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

describe("answerShapeFromEnv", () => {
  test("it reads the id field and the number of records", () => {
    expect(answerShapeFromEnv({ VERIHARNESS_ANSWER_SHAPE: JSON.stringify({ idField: "line", records: 4 }) })).toEqual({ idField: "line", records: 4 });
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

  function load(env: NodeJS.ProcessEnv = {}) {
    const handlers: Record<string, Handler> = {};
    let aborts = 0;
    repeatGuard({ on: (name: string, handler: Handler) => void (handlers[name] = handler) } as never, env);
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
