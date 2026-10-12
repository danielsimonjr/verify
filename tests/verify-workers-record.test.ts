import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ANSWER_IN_CALL_REASON, REPEAT_REASON, undeclaredReason } from "../harness/pi-extensions/repeat-guard.ts";
import { claudeStreamStats, jsonProblem, openMessageKind, parseJsonDeliverable, piStreamStats, toolErrorKind, turnCounter } from "../harness/workers/record.ts";

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
      stoppedInTools: false,
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
      stoppedInTools: false,
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
    const empty = { finalText: "", turns: 0, tools: 0, peakContext: 0, outputTokens: 0, compactions: 0, stopReason: "", stoppedInTools: false, thinkingOnly: false, toolErrors: 0, toolErrorKinds: { invalid: 0, missing: 0, other: 0, repeated: 0 } };
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

  describe("stoppedInTools", () => {
    const call = end([{ type: "toolCall", id: "c1", name: "read", arguments: { rows: [] } }], "toolUse");
    const failed = JSON.stringify({ type: "message_end", message: { role: "toolResult", toolCallId: "c1", toolName: "read", isError: true, content: [{ type: "text", text: "Validation failed" }] } });
    const turn = (errorMessage: string) =>
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 0, output: 0 }, stopReason: "error", errorMessage } });

    test("an empty turn that was aborted after a tool result means the guard stopped the session", () => {
      expect(piStreamStats([call, failed, turn("This operation was aborted")].join("\n")).stoppedInTools).toBe(true);
    });

    test("an aborted turn after a tool result is the same, whatever the stop reason is called", () => {
      const aborted = end([], "aborted");
      expect(piStreamStats([call, failed, aborted].join("\n")).stoppedInTools).toBe(true);
    });

    test("a request that timed out after a tool result is the server's failure, not a stop of the guard", () => {
      expect(piStreamStats([call, failed, turn("Request timed out.")].join("\n")).stoppedInTools).toBe(false);
    });

    test("an error that only has the word abort in it is the server's, not the guard's", () => {
      for (const message of ["The operation was aborted due to timeout", "read ECONNABORTED", "net::ERR_CONNECTION_ABORTED"]) {
        expect(piStreamStats([call, failed, turn(message)].join("\n")).stoppedInTools).toBe(false);
      }
    });

    test("the messages that an abort of the session gives are the guard's", () => {
      for (const message of ["This operation was aborted", "The operation was aborted", "Request was aborted", "Operation aborted", "Request aborted"]) {
        expect(piStreamStats([call, failed, turn(message)].join("\n")).stoppedInTools).toBe(true);
      }
    });

    test("a turn that ends on a tool call means the session stopped while it still wanted tools", () => {
      expect(piStreamStats(call).stoppedInTools).toBe(true);
    });

    test("a runaway message that was aborted while it had text is not a stop in tools", () => {
      const cut = end([{ type: "text", text: '{"rows": [{"line": 1' }], "aborted");
      expect(piStreamStats([call, failed, cut].join("\n")).stoppedInTools).toBe(false);
    });

    test("a session that ends with its answer is not", () => {
      expect(piStreamStats([call, failed, end([{ type: "text", text: "{}" }], "stop")].join("\n")).stoppedInTools).toBe(false);
    });
  });
});

describe("toolErrorKind of the guard's blocks", () => {
  test("a call with an argument the tool does not list, and a call that holds the answer, are invalid arguments", () => {
    expect(toolErrorKind(undeclaredReason("ls", ["rows"], ["path", "limit"]))).toBe("invalid");
    expect(toolErrorKind(ANSWER_IN_CALL_REASON)).toBe("invalid");
  });

  test("a block text that merely mentions a missing file is still classed by its own words", () => {
    expect(toolErrorKind("ENOENT: no such file or directory")).toBe("missing");
  });
});

describe("jsonProblem", () => {
  test("text that has no JSON in it has no problem to name", () => {
    expect(jsonProblem("The rows are logged.")).toBeNull();
    expect(jsonProblem("")).toBeNull();
  });

  test("JSON that parses has none", () => {
    expect(jsonProblem('{"rows": [{"line": 1}]}')).toBeNull();
    expect(jsonProblem("Here it is: " + FENCE + 'json\n{"rows": []}\n' + FENCE)).toBeNull();
  });

  test("a backslash that starts no escape is named, with the rule that fixes it (b08 r03 of run 7)", () => {
    const text = '{"rows": [{"line": 1, "evidence": "C:\\Users\\danie\\x"}]}';
    const problem = jsonProblem(text)!;
    expect(problem).toContain("character 38");
    expect(problem).toContain("\\U");
    expect(problem).toContain("two backslashes");
    // The place is shown, so the model can find it in its own text.
    expect(problem).toContain("C:");
  });

  test("a missing closing brace is named at the end of the text (b14 r03 of run 7)", () => {
    const problem = jsonProblem('{"rows": [{"line": 1, "verdict": "LOGGED"}]')!;
    expect(problem).toContain("object that starts at character 1");
    expect(problem).toContain("not closed");
  });

  test("a closing character that does not match is named (b08 r01 of run 7)", () => {
    const problem = jsonProblem('{"rows": [{"line": 1, "evidence": "x")}]}')!;
    expect(problem).toContain("character 38");
    expect(problem).toContain("comma or a closing brace");
  });

  test("a raw line break inside a string is named", () => {
    const problem = jsonProblem('{"a": "one\ntwo"}')!;
    expect(problem).toContain("line break");
    expect(problem).toContain("\\n");
  });

  test("a trailing comma is named", () => {
    expect(jsonProblem('{"a": [1, 2,]}')).toContain("trailing comma");
    expect(jsonProblem('{"a": 1,}')).toContain("trailing comma");
  });

  test("single quotes and bare keys are named", () => {
    expect(jsonProblem("{'a': 1}")).toContain("double quotes");
    expect(jsonProblem("{a: 1}")).toContain("double quotes");
  });

  test("a string that is not closed is named", () => {
    expect(jsonProblem('{"a": "never closed')).toContain("string that starts at character 7");
  });

  test("the JSON is found inside a fence and after prose", () => {
    expect(jsonProblem("Here is the answer:\n" + FENCE + 'json\n{"a": [1, 2}\n' + FENCE)).not.toBeNull();
    expect(jsonProblem('Answer: {"a": [1, 2}')).not.toBeNull();
  });

  test("a text that nests deeper than the scan follows is left to the parser, with no place named", () => {
    // The scan stops at 200 levels. A place named there would be the level where the scan stopped, not
    // where the text is wrong.
    expect(jsonProblem('{"a":'.repeat(250) + " 1")).toBeNull();
  });

  test("the place named is in the answer, not in a prose example before it", () => {
    const text = 'The format is {"line": N} for each row. Final answer: {"rows": [{"line": 1, "verdict": "LOGGED"}]';
    const problem = jsonProblem(text)!;
    expect(problem).toContain("not closed");
    expect(problem).not.toContain("found 'N'");
  });

  test("a prose example that is valid JSON next to a broken answer leaves nothing to name", () => {
    expect(jsonProblem('Example: {"a": 1}. Answer: {"rows": [')).toBeNull();
  });

  test("a long text with many braces is read in one pass", () => {
    const started = Date.now();
    jsonProblem("{x".repeat(50_000));
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("only the first problem is named, and the text after a value that closes is not read", () => {
    expect(jsonProblem('{"a": 1} and then {"b": ')).toBeNull();
  });

  test("rows that are whole after the place where the answer broke do not hide the break", () => {
    // `\\"` ends the string at the quote and `1 error` is not JSON. The rows after it are whole objects, but
    // they are part of the value that broke, and the parser does not take a piece of a broken value.
    const text =
      '{"rows": [{"line": 1, "heading": "a \\\\"1 error", "evidence": "x"}, {"line": 2, "verdict": "LOGGED", "evidence": "y"}]}';
    expect(parseJsonDeliverable(text)).toBeNull();
    const problem = jsonProblem(text)!;
    expect(problem).toContain("expected a comma");
    expect(problem).toContain("found '1'");
  });

  test("a fenced answer is named, not a prose example before the fence", () => {
    // The fence holds the answer. The example above it breaks too, and it must not be the place named.
    const text = 'Format: {"line": <n>}\n' + FENCE + "json\n{'rows': [{\"line\": 1}]}\n" + FENCE;
    expect(parseJsonDeliverable(text)).toBeNull();
    const problem = jsonProblem(text)!;
    expect(problem).toContain("double quotes");
    expect(problem).not.toContain("found '<'");
  });

  test("a place is named exactly when the parser finds no value in a text that has braces in it", () => {
    const texts = [
      '{"a": 1}',
      '{"a": 1,}',
      'Answer: {"rows": [{"line": 1}, {"line": 2}',
      'Example {"line": N} then {"rows": [{"line": 1}]}',
      'Example {"x": 1} then {"rows": [',
      '{"rows": [{"line": 1, "e": "C:\\Users"}, {"line": 2}]}',
      "```json\n" + '{"rows": [{"line": 1}' + "\n```",
      "```json\n" + '{"rows": [{"line": 1}]}' + "\n```",
      'text [1, 2, 3] and {"a": [1, 2}',
      '{"rows": [{"line": 1, "e": "x" "y"}, {"line": 2}]}',
    ];
    for (const t of texts) {
      expect({ text: t, named: jsonProblem(t) !== null }).toEqual({ text: t, named: parseJsonDeliverable(t) === null });
    }
  });
});
