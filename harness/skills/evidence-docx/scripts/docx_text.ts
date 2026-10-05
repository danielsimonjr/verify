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
 * Paragraphs (with styles) and, optionally, tables of a .docx in reading order.
 *
 *     node docx_text.js FILE [--tables]
 *
 * Paragraph lines:  [Style] text        Table dump (with --tables):
 *                                         ## table 3 (5 rows x 4 cols)
 *                                         cell<TAB>cell<TAB>...
 *
 * A style is shown by its name ("Heading 1"), not its id ("Heading1"). The lines are the ones
 * the python-docx version of this script printed.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import JSZip from "jszip";

import { docxParagraphText, paragraphStyles, styleNameOf, tableRows } from "../../_shared/docx.js";
import { readPart } from "../../_shared/opc.js";
import { pyStrip } from "../../_shared/pytext.js";
import { childrenNamed, descend, findAll } from "../../_shared/xml.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { tables: { type: "boolean", default: false } },
});
const file = positionals[0];
if (!file) {
  console.error("usage: docx_text.js FILE [--tables]");
  process.exit(2);
}

const zip = await JSZip.loadAsync(readFileSync(file));
const document = await readPart(zip, "word/document.xml");
const body = descend(document, "w:body");
if (!body) {
  console.error(`cannot read ${file}: not a Word file (no word/document.xml body)`);
  process.exit(1);
}

const paragraphs = childrenNamed(body, "w:p");
const tables = childrenNamed(body, "w:tbl");
const sections =
  childrenNamed(body, "w:sectPr").length + paragraphs.filter((p) => descend(p, "w:pPr", "w:sectPr")).length;
// Pictures set in the text line (`wp:inline`); floating ones (`wp:anchor`) are not counted.
const inlineImages = findAll(document, "w:p")
  .flatMap((p) => childrenNamed(p, "w:r"))
  .flatMap((r) => childrenNamed(r, "w:drawing"))
  .flatMap((d) => childrenNamed(d, "wp:inline")).length;

console.log(
  `# ${file}: ${paragraphs.length} paragraphs, ${tables.length} tables, ${sections} sections, ${inlineImages} inline images`,
);

const styles = await paragraphStyles(zip);
for (const p of paragraphs) {
  const text = docxParagraphText(p);
  if (pyStrip(text)) console.log(`[${styleNameOf(p, styles) || "Normal"}] ${text}`);
}

if (values.tables) {
  tables.forEach((table, i) => {
    const rows = tableRows(table);
    const ncols = Math.max(0, ...rows.map((r) => r.length));
    console.log(`\n## table ${i + 1} (${rows.length} rows x ${ncols} cols)`);
    for (const row of rows) console.log(row.map((c) => pyStrip(c.replace(/\n/g, " "))).join("\t"));
  });
}
