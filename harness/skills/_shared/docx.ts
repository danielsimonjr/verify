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
 * Reading the text of a .docx the way python-docx reports it, which is what the pre-port
 * scripts and views printed: a paragraph is its runs and its hyperlinks' runs in order, a tab
 * or line break is a character, a style is known by its name (not its id), and a table row has
 * one cell per layout-grid column.
 */

import type JSZip from "jszip";

import { readPart } from "./opc.js";
import {
  type XNode,
  attr,
  child,
  childrenNamed,
  childrenOf,
  descend,
  ownText,
  tagOf,
} from "./xml.js";

/** Text of one run: tabs and line breaks become characters, a page or column break leaves none. */
export function runText(run: XNode): string {
  let out = "";
  for (const n of childrenOf(run)) {
    switch (tagOf(n)) {
      case "w:t":
        out += ownText(n);
        break;
      case "w:tab":
      case "w:ptab":
        out += "\t";
        break;
      case "w:cr":
        out += "\n";
        break;
      case "w:br":
        if ((attr(n, "w:type") ?? "textWrapping") === "textWrapping") out += "\n";
        break;
      case "w:noBreakHyphen":
        out += "-";
        break;
    }
  }
  return out;
}

/** A paragraph's runs and the runs of its hyperlinks, in order. Text inside `w:ins` is not read. */
export function docxParagraphText(p: XNode): string {
  let out = "";
  for (const n of childrenOf(p)) {
    const tag = tagOf(n);
    if (tag === "w:r") out += runText(n);
    else if (tag === "w:hyperlink") out += childrenNamed(n, "w:r").map(runText).join("");
  }
  return out;
}

// The file stores these built-in style names in lower case; python-docx shows them capitalised.
const BUILT_IN_STYLES = new Set([
  "caption",
  "footer",
  "header",
  ...Array.from({ length: 9 }, (_, i) => `heading ${i + 1}`),
]);
const shownName = (name: string) => (BUILT_IN_STYLES.has(name) ? name[0].toUpperCase() + name.slice(1) : name);

/** Paragraph style names by id, and the name of the default paragraph style ("" if none). */
export type ParagraphStyles = { byId: Map<string, string>; fallback: string };

export async function paragraphStyles(zip: JSZip): Promise<ParagraphStyles> {
  const byId = new Map<string, string>();
  let fallback = "";
  for (const style of childrenNamed(await readPart(zip, "word/styles.xml"), "w:style")) {
    if (attr(style, "w:type") !== "paragraph") continue;
    const name = shownName(attr(child(style, "w:name") ?? {}, "w:val") ?? "");
    const id = attr(style, "w:styleId");
    if (id !== undefined && !byId.has(id)) byId.set(id, name);
    if (["1", "true", "on"].includes(attr(style, "w:default") ?? "")) fallback = name;
  }
  return { byId, fallback };
}

/** The name of a paragraph's style; an unknown or missing style id means the default style. */
export function styleNameOf(p: XNode, styles: ParagraphStyles): string {
  const id = attr(descend(p, "w:pPr", "w:pStyle") ?? {}, "w:val");
  return (id === undefined ? undefined : styles.byId.get(id)) ?? styles.fallback;
}

/** True for the styles the text view marks with "# ": "Heading ..." and "Title ...". */
export function isHeadingStyle(name: string): boolean {
  return name.startsWith("Heading") || name.startsWith("Title");
}

const cellText = (tc: XNode) => childrenNamed(tc, "w:p").map(docxParagraphText).join("\n");

/**
 * Cell text per grid column of each row: a cell that spans columns repeats, and a vertically
 * merged cell repeats the text of the cell above it.
 */
export function tableRows(tbl: XNode): string[][] {
  let above = new Map<number, string>();
  return childrenNamed(tbl, "w:tr").map((tr) => {
    const row: string[] = [];
    const here = new Map<number, string>();
    let offset = parseInt(attr(descend(tr, "w:trPr", "w:gridBefore") ?? {}, "w:val") ?? "0", 10) || 0;
    for (const tc of childrenNamed(tr, "w:tc")) {
      const span = parseInt(attr(descend(tc, "w:tcPr", "w:gridSpan") ?? {}, "w:val") ?? "1", 10) || 1;
      const merge = descend(tc, "w:tcPr", "w:vMerge");
      const continued = merge !== undefined && (attr(merge, "w:val") ?? "continue") === "continue";
      const text = continued ? (above.get(offset) ?? "") : cellText(tc);
      for (let i = 0; i < span; i++) {
        here.set(offset + i, text);
        row.push(text);
      }
      offset += span;
    }
    above = here;
    return row;
  });
}
