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

import { parseArgs } from "node:util";
import { extractWords, loadPdf } from "../../_shared/pdf.js";

// Approximation: pdfplumber table detection is not available in pdf.js; we group
// text items into rows by similar Y coordinates and split columns on large X gaps.

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "all-pages": { type: "boolean", default: false },
    strategy: { type: "string", default: "lines" },
  },
});
const file = positionals[0];
const pageArg = positionals[1];
const allPages = values["all-pages"] ?? false;
const strategy = values.strategy ?? "lines";

if (!file) {
  console.error("usage: pdf_tables.py FILE PAGE [--all-pages] [--strategy lines|text]");
  process.exit(2);
}

const pdf = await loadPdf(file);
const pageNo = pageArg ? parseInt(pageArg, 10) : 1;
const pages = allPages
  ? Array.from({ length: pdf.numPages }, (_, i) => i + 1)
  : [pageNo];

function wordsToTables(words: { top: number; x0: number; x1: number; text: string }[]) {
  if (!words.length) return [] as string[][][];
  const gapY = strategy === "text" ? 6 : 4;
  const gapX = strategy === "text" ? 18 : 28;
  const rows: { y: number; cells: { x0: number; text: string }[] }[] = [];
  let curY = words[0].top;
  let curCells: { x0: number; text: string }[] = [];
  for (const w of words) {
    if (Math.abs(w.top - curY) > gapY) {
      if (curCells.length) rows.push({ y: curY, cells: curCells });
      curCells = [];
      curY = w.top;
    }
    const last = curCells[curCells.length - 1];
    if (last && w.x0 - (last.x0 + last.text.length * 4) < gapX) {
      last.text += " " + w.text;
    } else {
      curCells.push({ x0: w.x0, text: w.text });
    }
  }
  if (curCells.length) rows.push({ y: curY, cells: curCells });
  return [rows.map((r) => r.cells.map((c) => c.text))];
}

let found = 0;
for (const pn of pages) {
  if (pn < 1 || pn > pdf.numPages) {
    console.log(`page ${pn} out of range (1..${pdf.numPages})`);
    continue;
  }
  const page = await pdf.getPage(pn);
  const words = await extractWords(page);
  const tables = wordsToTables(words);
  for (let ti = 0; ti < tables.length; ti++) {
    const t = tables[ti]!;
    if (!t.length) continue;
    found++;
    const cols = Math.max(...t.map((r) => r.length), 0);
    console.log(`# page ${pn} table ${ti + 1}: ${t.length} rows x ${cols} cols`);
    for (const row of t) {
      console.log(
        row.map((c) => (c == null ? "" : String(c).replace(/\n/g, " ").trim())).join("\t"),
      );
    }
    console.log();
  }
}

if (!found) {
  console.log(
    `no table detected on page(s) ${JSON.stringify([...pages])} with strategy=${strategy}; try --strategy text, or render the page (pdf_render.py) and read it, or pdf_words.py for coordinates`,
  );
}
