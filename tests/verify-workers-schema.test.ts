import { describe, expect, test } from "bun:test";

import { unsupportedKeywords, validateSchema } from "../harness/workers/schema.ts";

const ROWS = {
  type: "object",
  required: ["rows"],
  additionalProperties: false,
  properties: {
    rows: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["line", "verdict"],
        properties: { line: { type: "integer", minimum: 1 }, verdict: { enum: ["LOGGED", "MISSING"] } },
      },
    },
  },
};

describe("validateSchema", () => {
  test("a value that fits has no errors", () => {
    expect(validateSchema({ rows: [{ line: 7, verdict: "LOGGED" }] }, ROWS)).toEqual([]);
  });

  test("each error names the path of the value", () => {
    const errors = validateSchema({ rows: [{ row: 7, verdict: "MAYBE" }], extra: 1 }, ROWS);
    expect(errors).toContain("$: unexpected property 'extra'");
    expect(errors).toContain("$.rows[0]: missing property 'line'");
    expect(errors).toContain("$.rows[0].verdict: not one of LOGGED, MISSING");
  });

  test("a value of the wrong type stops at that value", () => {
    expect(validateSchema([], ROWS)).toEqual(["$: expected object, got array"]);
    expect(validateSchema({ rows: [{ line: 1.5, verdict: "LOGGED" }] }, ROWS)).toEqual(["$.rows[0].line: expected integer, got number"]);
  });

  test("array bounds and number bounds", () => {
    expect(validateSchema({ rows: [] }, ROWS)).toEqual(["$.rows: 0 items, fewer than 1"]);
    expect(validateSchema({ rows: [{ line: 0, verdict: "LOGGED" }] }, ROWS)).toEqual(["$.rows[0].line: 0 is below 1"]);
  });

  test("anyOf and a type list", () => {
    expect(validateSchema(null, { type: ["string", "null"] })).toEqual([]);
    expect(validateSchema(3, { anyOf: [{ type: "string" }, { type: "boolean" }] })).toEqual(["$: matches none of the 2 alternatives"]);
  });
});

describe("unsupportedKeywords", () => {
  test("a keyword the validator would skip is reported, so a schema never passes by being ignored", () => {
    expect(unsupportedKeywords(ROWS)).toEqual([]);
    expect(unsupportedKeywords({ type: "object", properties: { a: { type: "string", pattern: "^x" } }, $schema: "x", title: "t" })).toEqual([
      "$.properties.a: pattern",
    ]);
  });
});
