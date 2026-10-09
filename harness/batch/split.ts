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
 * Split an items file into items. Three rules:
 *
 * - `jsonl`: one item per non-empty line. The id is the line's `id` field, else its 1-based line number.
 * - `heading:REGEX`: an item starts at each line the regex matches and runs to the next one. The id is
 *   the first capture group, else the item's 1-based position. Text before the first heading is the
 *   preamble; it belongs to no item.
 * - `blank-line`: items are the blocks between one or more blank lines. The id is the 1-based position.
 *
 * CRLF becomes LF and one leading BOM is removed first, so a file saved on Windows splits the same way.
 */

export type SplitRule = { kind: "jsonl" } | { kind: "heading"; regex: RegExp } | { kind: "blank-line" };

/** One item of an items file: its id and its original text. */
export interface Item {
  id: string;
  text: string;
}

/** The items of a file and the length of the text before the first one. */
export interface SplitResult {
  items: Item[];
  /** Characters before the first item: the heading rule's preamble. Zero for the other rules. */
  preambleChars: number;
}

/** Parse `--split`: `jsonl`, `blank-line` or `heading:REGEX`. Throws on anything else. */
export function parseSplitRule(raw: string): SplitRule {
  if (raw === "jsonl") return { kind: "jsonl" };
  if (raw === "blank-line") return { kind: "blank-line" };
  if (raw.startsWith("heading:")) {
    const source = raw.slice("heading:".length);
    if (source === "") throw new Error("--split heading: needs a regex, as in heading:^### (.+)$");
    try {
      return { kind: "heading", regex: new RegExp(source, "m") };
    } catch (err) {
      throw new Error(`--split heading: invalid regex '${source}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`--split '${raw}': expected jsonl, blank-line or heading:REGEX`);
}

/** Split `text` into items by `rule`. Throws on a duplicate id. */
export function splitItems(text: string, rule: SplitRule): SplitResult {
  const normal = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const result =
    rule.kind === "jsonl" ? splitJsonl(normal) : rule.kind === "heading" ? splitHeadings(normal, rule.regex) : splitBlocks(normal);
  assertUniqueIds(result.items);
  return result;
}

function splitJsonl(text: string): SplitResult {
  const items: Item[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`--split jsonl: line ${i + 1} is not JSON`);
    }
    const id = (value as { id?: unknown } | null)?.id;
    items.push({ id: typeof id === "string" || typeof id === "number" ? String(id) : String(i + 1), text: line });
  });
  return { items, preambleChars: 0 };
}

function splitHeadings(text: string, regex: RegExp): SplitResult {
  // Offsets of each heading line, with its id.
  const starts: { at: number; id: string }[] = [];
  let at = 0;
  for (const line of text.split("\n")) {
    const match = regex.exec(line);
    if (match) starts.push({ at, id: match[1] ?? String(starts.length + 1) });
    at += line.length + 1;
  }
  const items = starts.map((s, i) => ({ id: s.id, text: text.slice(s.at, starts[i + 1]?.at ?? text.length) }));
  return { items, preambleChars: starts[0]?.at ?? text.length };
}

function splitBlocks(text: string): SplitResult {
  const items: Item[] = [];
  let block: string[] = [];
  const flush = () => {
    if (block.length) items.push({ id: String(items.length + 1), text: block.join("\n") });
    block = [];
  };
  for (const line of text.split("\n")) {
    if (line.trim() === "") flush();
    else block.push(line);
  }
  flush();
  return { items, preambleChars: 0 };
}

function assertUniqueIds(items: readonly Item[]): void {
  const seen = new Map<string, number>();
  items.forEach((item, i) => {
    const first = seen.get(item.id);
    if (first !== undefined) {
      throw new Error(`duplicate item id '${item.id}' at items ${first} and ${i + 1}`);
    }
    seen.set(item.id, i + 1);
  });
}
