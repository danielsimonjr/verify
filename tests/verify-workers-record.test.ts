import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REPEAT_REASON } from "../harness/pi-extensions/repeat-guard.ts";
import { claudeStreamStats, openMessageKind, parseJsonDeliverable, piStreamStats, turnCounter } from "../harness/workers/record.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "workers");
const FENCE = "```";

describe("turnCounter", () => {
  /** Feed `text` in chunks of `size` bytes, so lines and UTF-8 characters split across chunks. */
  const countIn = (claude: boolean, text: string, size: number): number => {
    const bytes = Buffer.from(text, "utf8");
    const count = turnCounter(claude);
    let turns = 0;
    for (let i = 0; i < bytes.length; i += size) turns = count(bytes.subarray(i, i + size));
    return turns;
  };

  test("counts pi turns as piStreamStats does, whatever the chunk size", () => {
    const stream = readFileSync(join(FIXTURES, "pi-stream.jsonl"), "utf8");
    for (const size of [1, 7, 4096]) expect(countIn(false, stream, size)).toBe(piStreamStats(stream).turns);
  });

  test("counts claude turns as claudeStreamStats does, whatever the chunk size", () => {
    const stream = readFileSync(join(FIXTURES, "claude-stream.jsonl"), "utf8");
    for (const size of [1, 7, 4096]) expect(countIn(true, stream, size)).toBe(claudeStreamStats(stream).turns);
  });

  test("a line counts only once it is complete", () => {
    const count = turnCounter(false);
    const line = '{"type":"message_end","message":{"role":"assistant","content":[]}}';
    expect(count(Buffer.from(line))).toBe(0);
    expect(count(Buffer.from("\n"))).toBe(1);
  });
});

describe("parseJsonDeliverable", () => {
  test("pure", () => {
    expect(parseJsonDeliverable('{"rows":[]}')).toEqual({ value: { rows: [] }, form: "pure" });
    expect(parseJsonDeliverable('  {"rows":[]}\n')?.form).toBe("pure");
  });

  test("fenced", () => {
    expect(parseJsonDeliverable(`${FENCE}json\n{"rows":[1]}\n${FENCE}`)).toEqual({ value: { rows: [1] }, form: "fenced" });
    expect(parseJsonDeliverable(`${FENCE}\n{"rows":[1]}\n${FENCE}\n`)?.form).toBe("fenced");
  });

  test("embedded", () => {
    const fenced = `Here is the report.\n${FENCE}json\n{"rows":[2]}\n${FENCE}\nDone.`;
    expect(parseJsonDeliverable(fenced)).toEqual({ value: { rows: [2] }, form: "embedded" });
    const bare = 'The result is {"rows": [3]} as asked.';
    expect(parseJsonDeliverable(bare)).toEqual({ value: { rows: [3] }, form: "embedded" });
  });

  test("none", () => {
    expect(parseJsonDeliverable("no json here")).toBeNull();
    expect(parseJsonDeliverable("")).toBeNull();
    expect(parseJsonDeliverable("{not json}")).toBeNull();
  });

  test("an array is returned whole, also when the fence tag line holds its first bracket", () => {
    const rows = [{ row: "line 1", verdict: "LOGGED" }, { row: "line 2", verdict: "MISSING" }, { row: "line 3", verdict: "LOGGED" }];
    const text = JSON.stringify(rows, null, 1);
    // A fence written as ```json [ has no newline after the tag, so the fence patterns do not match it.
    const glued = `Here is the output:\n\n${FENCE}json ${text}${FENCE}\n\nAll rows are covered.`;
    expect(parseJsonDeliverable(glued)).toEqual({ value: rows, form: "embedded" });
    expect(parseJsonDeliverable(`Result: ${JSON.stringify(rows)} done`)).toEqual({ value: rows, form: "embedded" });
  });

  test("a bracketed word in prose is not the deliverable", () => {
    expect(parseJsonDeliverable('See [1] and [note]. The result is {"rows": [3]} as asked.')).toEqual({ value: { rows: [3] }, form: "embedded" });
  });

  test("the longest top-level value wins over an earlier small one", () => {
    const text = 'Format: {"a":1}. Report: {"rows":[1,2,3],"n":3}';
    expect(parseJsonDeliverable(text)).toEqual({ value: { rows: [1, 2, 3], n: 3 }, form: "embedded" });
  });

  test("a truncated or malformed value is never answered with a fragment of it", () => {
    // The array is cut off after its second element: the complete objects inside it are pieces, not the deliverable.
    expect(parseJsonDeliverable('Here: [{"row":1},{"row":2},{"row"')).toBeNull();
    expect(parseJsonDeliverable('Here: {"rows":[{"row":1},{"row":2}')).toBeNull();
    // Balanced but not valid JSON (a trailing comma): its inner object is a piece too.
    expect(parseJsonDeliverable('Here: [{"row":1},{"row":2},]')).toBeNull();
  });
});

describe("stream stats", () => {
  test("pi stats", () => {
    const stats = piStreamStats(readFileSync(join(FIXTURES, "pi-stream.jsonl"), "utf8"));
    expect(stats).toEqual({
      finalText: '{"rows": [{"line": 7, "verdict": "LOGGED"}]}',
      turns: 3,
      tools: 1,
      // max(1551, 236 + 24032 + 10, 393 + 24373)
      peakContext: 24766,
      outputTokens: 187 + 106 + 111,
      compactions: 0,
      stopReason: "stop",
      thinkingOnly: false,
      toolErrors: 0,
      toolErrorKinds: { invalid: 0, missing: 0, other: 0, repeated: 0 },
    });
  });

  test("claude stats", () => {
    const stats = claudeStreamStats(readFileSync(join(FIXTURES, "claude-stream.jsonl"), "utf8"));
    expect(stats).toEqual({
      finalText: '{"rows": []}',
      // Three message ids; msg_1 arrives as two events, one per content block.
      turns: 3,
      tools: 1,
      // max(2 + 3089 + 3005, 2 + 246 + 6094, 3 + 120 + 6340)
      peakContext: 6463,
      // The result event's total; the per-block events carry partial counts.
      outputTokens: 265,
      compactions: 0,
      stopReason: "",
      thinkingOnly: false,
      toolErrors: 0,
      toolErrorKinds: { invalid: 0, missing: 0, other: 0, repeated: 0 },
    });
  });

  describe("openMessageKind", () => {
    const update = (assistantMessageEvent: object): string => JSON.stringify({ type: "message_update", assistantMessageEvent }) + "\n";
    const ended = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], usage: {}, stopReason: "stop" } }) + "\n";

    test("is text when prose was streamed and the message did not end", () => {
      expect(openMessageKind(update({ type: "text_delta", delta: "Row 1" }) + update({ type: "text_delta", delta: " is" }))).toBe("text");
    });
    test("is toolcall when the arguments of a call were streamed and the message did not end", () => {
      expect(openMessageKind(update({ type: "toolcall_delta", delta: '{"path"' }))).toBe("toolcall");
    });
    test("is empty when the message ended, and for a stream with no fragment", () => {
      expect(openMessageKind(update({ type: "text_delta", delta: "Row 1" }) + ended)).toBe("");
      expect(openMessageKind("")).toBe("");
    });
    test("is the kind of the last message that did not end", () => {
      const stream = update({ type: "text_delta", delta: "a" }) + ended + update({ type: "toolcall_delta", delta: "{" });
      expect(openMessageKind(stream)).toBe("toolcall");
    });
  });

  test("an empty stream gives zeros and no text", () => {
    const empty = { finalText: "", turns: 0, tools: 0, peakContext: 0, outputTokens: 0, compactions: 0, stopReason: "", thinkingOnly: false, toolErrors: 0, toolErrorKinds: { invalid: 0, missing: 0, other: 0, repeated: 0 } };
    expect(piStreamStats("")).toEqual(empty);
    expect(claudeStreamStats("")).toEqual(empty);
  });

  const end = (content: unknown[], stopReason: string): string =>
    JSON.stringify({ type: "message_end", message: { role: "assistant", content, usage: { input: 10, output: 5 }, stopReason } });

  test("pi: a tool call that failed is counted, so a worker reading paths the task lacks shows", () => {
    const stream = [
      JSON.stringify({ type: "tool_execution_end", toolName: "read", isError: true, result: { content: [] } }),
      JSON.stringify({ type: "tool_execution_end", toolName: "grep", isError: false, result: { content: [] } }),
      JSON.stringify({ type: "tool_execution_end", toolName: "read", isError: true, result: { content: [] } }),
    ].join("\n");
    const stats = piStreamStats(stream);
    expect(stats.tools).toBe(3);
    expect(stats.toolErrors).toBe(2);
  });

  test("pi: a failed tool call is classed by its own result text", () => {
    const fail = (text: string) =>
      JSON.stringify({ type: "tool_execution_end", toolName: "grep", isError: true, result: { content: [{ type: "text", text }] } });
    const stream = [
      fail('Validation failed for tool "grep":\n  - pattern: must have required properties pattern\n\nReceived arguments:\n{}'),
      fail('Validation failed for tool "read":\n  - path: must be string'),
      fail("ENOENT: no such file or directory, open 'workspace/rows.md'"),
      fail("something the harness does not know"),
    ].join("\n");
    const stats = piStreamStats(stream);
    expect(stats.toolErrors).toBe(4);
    expect(stats.toolErrorKinds).toEqual({ invalid: 2, missing: 1, other: 1, repeated: 0 });
  });

  test("pi: a call that the repeat guard blocked is classed as repeated, not as an error of the tool", () => {
    const blocked = JSON.stringify({ type: "tool_execution_end", toolName: "read", isError: true, result: { content: [{ type: "text", text: REPEAT_REASON }] } });
    const stats = piStreamStats([blocked, blocked].join("\n"));
    expect(stats.toolErrors).toBe(2);
    expect(stats.toolErrorKinds).toEqual({ invalid: 0, missing: 0, other: 0, repeated: 2 });
  });

  test("claude: a failed tool result is classed by its content", () => {
    const user = (content: string) =>
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", is_error: true, content }] } });
    const stats = claudeStreamStats(
      [user("<tool_use_error>InputValidationError: pattern is required</tool_use_error>"), user("File does not exist."), user("boom")].join("\n"),
    );
    expect(stats.toolErrorKinds).toEqual({ invalid: 1, missing: 1, other: 1, repeated: 0 });
  });

  test("claude: a tool result with is_error is counted", () => {
    const user = (isError: boolean) =>
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", is_error: isError, content: "x" }] } });
    expect(claudeStreamStats([user(true), user(false), user(true)].join("\n")).toolErrors).toBe(2);
  });

  test("pi: compactions are counted from compaction_start events", () => {
    const stream = [JSON.stringify({ type: "compaction_start", reason: "threshold" }), end([{ type: "text", text: "ok" }], "stop"), JSON.stringify({ type: "compaction_start", reason: "overflow" })].join("\n");
    expect(piStreamStats(stream).compactions).toBe(2);
  });

  test("pi: the stop reason of the last turn is kept, and a turn of thinking alone is flagged", () => {
    const cut = piStreamStats(end([{ type: "text", text: '{"rows": [' }], "length"));
    expect(cut.stopReason).toBe("length");
    expect(cut.thinkingOnly).toBe(false);
    const thought = piStreamStats(end([{ type: "thinking", thinking: "hmm" }], "stop"));
    expect(thought.finalText).toBe("");
    expect(thought.thinkingOnly).toBe(true);
    // Text earlier in the session does not make a later empty turn an answer: the last turn counts.
    const later = piStreamStats([end([{ type: "text", text: "x" }], "toolUse"), end([{ type: "thinking", thinking: "hmm" }], "stop")].join("\n"));
    expect(later.thinkingOnly).toBe(true);
  });
});
