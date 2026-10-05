import { describe, expect, test } from "bun:test";

import { parseCount } from "../harness/count.ts";

describe("parseCount", () => {
  test("accepts digits that name a safe integer at or above the minimum", () => {
    expect(parseCount("0")).toBe(0);
    expect(parseCount("007")).toBe(7);
    expect(parseCount("8", 1)).toBe(8);
    expect(parseCount(String(Number.MAX_SAFE_INTEGER), 1)).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("rejects a digit string that is Infinity or an unsafe integer", () => {
    expect(parseCount("9".repeat(400), 1)).toBeUndefined();
    expect(parseCount(String(Number.MAX_SAFE_INTEGER + 1), 1)).toBeUndefined();
    expect(parseCount("18446744073709551616")).toBeUndefined();
  });

  test("rejects everything that is not plain digits, and a value below the minimum", () => {
    for (const bad of ["", " 3", "3 ", "-1", "+1", "1.5", "1e2", "0x10", "abc", "Infinity"]) {
      expect(parseCount(bad)).toBeUndefined();
    }
    expect(parseCount("0", 1)).toBeUndefined();
  });
});
