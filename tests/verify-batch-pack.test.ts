import { describe, expect, test } from "bun:test";

import { FixedOverBudget, batchName, estimateTokens, pack, type PackOptions } from "../harness/batch/pack.ts";
import type { Item } from "../harness/batch/split.ts";

const opts = (o: Partial<PackOptions> = {}): PackOptions => ({
  budget: 250,
  fixedChars: 0,
  charsPerToken: 3.6,
  overheadTokens: 0,
  itemTokens: 0,
  ...o,
});
const item = (id: string, chars: number): Item => ({ id, text: "x".repeat(chars) });
const five = ["1", "2", "3", "4", "5"].map((id) => item(id, 360));
const sizes = (batches: { items: Item[] }[]) => batches.map((b) => b.items.length);

describe("pack", () => {
  test("estimate formula", () => {
    expect(estimateTokens(3600, 2, opts({ overheadTokens: 2000, itemTokens: 100 }))).toBe(3200);
  });

  test("packs in order to the budget", () => {
    const batches = pack(five, opts());
    expect(sizes(batches)).toEqual([2, 2, 1]);
    expect(batches.flatMap((b) => b.items.map((i) => i.id))).toEqual(["1", "2", "3", "4", "5"]);
    expect(batches[0]!.estTokens).toBe(200);
    expect(batches.every((b) => !b.overBudget)).toBe(true);
  });

  test("maxItems", () => {
    expect(sizes(pack(five, opts({ budget: 10_000, maxItems: 2 })))).toEqual([2, 2, 1]);
  });

  test("over-budget item alone", () => {
    const batches = pack([item("a", 36), item("big", 3600), item("b", 36)], opts({ budget: 500 }));
    expect(batches.map((b) => b.items.map((i) => i.id))).toEqual([["a"], ["big"], ["b"]]);
    expect(batches.map((b) => b.overBudget)).toEqual([false, true, false]);
  });

  test("fixed part over budget throws", () => {
    const run = () => pack(five, opts({ fixedChars: 36_000, budget: 5000 }));
    expect(run).toThrow(FixedOverBudget);
    expect(run).toThrow(/10000.*5000/);
  });

  test("names", () => {
    expect(batchName(1, 31)).toBe("b01");
    expect(batchName(31, 31)).toBe("b31");
    expect(batchName(1, 120)).toBe("b001");
    expect(batchName(120, 120)).toBe("b120");
    const many = pack(Array.from({ length: 120 }, (_, i) => item(String(i + 1), 360)), opts({ budget: 100 }));
    expect(many.map((b) => b.name).slice(0, 2)).toEqual(["b001", "b002"]);
  });
});
