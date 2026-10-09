import { describe, expect, test } from "bun:test";

import { parseSplitRule, splitItems } from "../harness/batch/split.ts";

const HEADINGS = "intro\n### TODO line 7\nx\n### TODO line 9\ny\n";
const HEADING_RULE = "heading:^### TODO line (\\d+)$";
const crlf = (s: string) => s.replace(/\n/g, "\r\n");

describe("splitItems", () => {
  test("jsonl ids", () => {
    const { items } = splitItems('{"id":"a"}\n{"x":1}\n', parseSplitRule("jsonl"));
    expect(items.map((i) => i.id)).toEqual(["a", "2"]);
    expect(items.map((i) => i.text)).toEqual(['{"id":"a"}', '{"x":1}']);
  });

  test("jsonl: a line that is not JSON throws and names the line", () => {
    expect(() => splitItems('{"id":"a"}\nnot json\n', parseSplitRule("jsonl"))).toThrow(/line 2/);
  });

  test("heading capture", () => {
    const { items, preambleChars } = splitItems(HEADINGS, parseSplitRule(HEADING_RULE));
    expect(items.map((i) => i.id)).toEqual(["7", "9"]);
    expect(items.map((i) => i.text)).toEqual(["### TODO line 7\nx\n", "### TODO line 9\ny\n"]);
    expect(preambleChars).toBe(6);
  });

  test("heading ordinal", () => {
    const { items } = splitItems(HEADINGS, parseSplitRule("heading:^### TODO line \\d+$"));
    expect(items.map((i) => i.id)).toEqual(["1", "2"]);
  });

  test("blank-line", () => {
    const { items } = splitItems("a\n\n\nb\nc\n", parseSplitRule("blank-line"));
    expect(items.map((i) => i.id)).toEqual(["1", "2"]);
    expect(items.map((i) => i.text)).toEqual(["a", "b\nc"]);
  });

  test("duplicate id", () => {
    const twice = "### TODO line 7\nx\n### TODO line 7\ny\n";
    expect(() => splitItems(twice, parseSplitRule(HEADING_RULE))).toThrow(/'7'.*1.*2/);
  });

  test("CRLF", () => {
    for (const [text, rule] of [
      ['{"id":"a"}\n{"x":1}\n', "jsonl"],
      [HEADINGS, HEADING_RULE],
      ["a\n\n\nb\nc\n", "blank-line"],
    ] as const) {
      const lf = splitItems(text, parseSplitRule(rule));
      const cr = splitItems(crlf(text), parseSplitRule(rule));
      expect(cr.items).toEqual(lf.items);
      expect(cr.preambleChars).toBe(lf.preambleChars);
    }
  });

  test("BOM", () => {
    const { items, preambleChars } = splitItems("﻿### TODO line 7\nx\n", parseSplitRule(HEADING_RULE));
    expect(items.map((i) => i.id)).toEqual(["7"]);
    expect(preambleChars).toBe(0);
  });
});

describe("parseSplitRule", () => {
  test("the three rules", () => {
    expect(parseSplitRule("jsonl")).toEqual({ kind: "jsonl" });
    expect(parseSplitRule("blank-line")).toEqual({ kind: "blank-line" });
    const h = parseSplitRule("heading:^## (.+)$");
    expect(h.kind).toBe("heading");
    if (h.kind === "heading") expect(h.regex.flags).toContain("m");
  });

  test("an invalid regex and an unknown rule throw", () => {
    expect(() => parseSplitRule("heading:([")).toThrow(/heading/);
    expect(() => parseSplitRule("heading:")).toThrow(/heading/);
    expect(() => parseSplitRule("csv")).toThrow(/csv/);
  });
});
