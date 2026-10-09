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
 * Pack items into batches by a token budget, in file order, in one greedy pass. The estimate is a fixed
 * ratio of characters to tokens: no tokenizer, so the same input always gives the same batches.
 */

import type { Item } from "./split.js";

/** The budget and the estimate parameters of one packing run. */
export interface PackOptions {
  /** Tokens one batch may use. */
  budget: number;
  /** Characters every batch carries: the spec and the shared files. The prompt is not counted. */
  fixedChars: number;
  charsPerToken: number;
  /** Tokens every batch costs beyond its text: the system prompt and the tool definitions. */
  overheadTokens: number;
  /** Tokens each item costs beyond its text: the reads and the tool results that check it. */
  itemTokens: number;
  maxItems?: number;
}

/** One batch: its name, its items in file order and its estimate. */
export interface PackedBatch {
  name: string;
  items: Item[];
  estTokens: number;
  /** One item whose estimate alone is above the budget. It gets a batch of its own. */
  overBudget: boolean;
}

/** The fixed part of every batch is above the budget, so no batch can hold an item. */
export class FixedOverBudget extends Error {
  constructor(
    readonly fixedTokens: number,
    readonly budget: number,
  ) {
    super(`the fixed part of every batch is ${fixedTokens} tokens, above the budget of ${budget}`);
    this.name = "FixedOverBudget";
  }
}

/** `chars` includes `fixedChars`; `count` is the number of items. */
export function estimateTokens(chars: number, count: number, o: PackOptions): number {
  return Math.ceil(chars / o.charsPerToken) + o.overheadTokens + o.itemTokens * count;
}

/** `b01`..`b99`, or one wider width for the whole run, so the names sort in batch order. */
export function batchName(index: number, count: number): string {
  const width = Math.max(2, String(count).length);
  return `b${String(index).padStart(width, "0")}`;
}

/** Pack `items` in file order into batches that each fit `o.budget`. Throws FixedOverBudget. */
export function pack(items: readonly Item[], o: PackOptions): PackedBatch[] {
  const fixed = estimateTokens(o.fixedChars, 0, o);
  if (fixed > o.budget) throw new FixedOverBudget(fixed, o.budget);
  const groups: { items: Item[]; chars: number }[] = [];
  let current: { items: Item[]; chars: number } | null = null;
  for (const item of items) {
    const alone = estimateTokens(o.fixedChars + item.text.length, 1, o);
    if (alone > o.budget) {
      if (current) groups.push(current);
      groups.push({ items: [item], chars: item.text.length });
      current = null;
      continue;
    }
    if (current) {
      const full = o.maxItems !== undefined && current.items.length >= o.maxItems;
      const next = estimateTokens(o.fixedChars + current.chars + item.text.length, current.items.length + 1, o);
      if (!full && next <= o.budget) {
        current.items.push(item);
        current.chars += item.text.length;
        continue;
      }
      groups.push(current);
    }
    current = { items: [item], chars: item.text.length };
  }
  if (current) groups.push(current);
  return groups.map((g, i) => {
    const estTokens = estimateTokens(o.fixedChars + g.chars, g.items.length, o);
    return { name: batchName(i + 1, groups.length), items: g.items, estTokens, overBudget: estTokens > o.budget };
  });
}
