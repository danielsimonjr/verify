import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { claudeStreamStats, parseJsonDeliverable, piStreamStats } from "../harness/workers/record.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "workers");
const FENCE = "```";

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
    });
  });

  test("an empty stream gives zeros and no text", () => {
    expect(piStreamStats("")).toEqual({ finalText: "", turns: 0, tools: 0, peakContext: 0, outputTokens: 0 });
    expect(claudeStreamStats("")).toEqual({ finalText: "", turns: 0, tools: 0, peakContext: 0, outputTokens: 0 });
  });
});
