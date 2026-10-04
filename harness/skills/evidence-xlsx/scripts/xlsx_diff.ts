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
import type ExcelJS from "exceljs";
import {
  cellLine,
  collectCoords,
  fmtCell,
  loadPair,
  same,
  sortCoords,
} from "../../_shared/excel.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    limit: { type: "string", default: "300" },
    "no-format": { type: "boolean", default: false },
  },
});
const a = positionals[0];
const b = positionals[1];
const limit = parseInt(values.limit ?? "300", 10);
const doFormat = !(values["no-format"] ?? false);

if (!a || !b) {
  console.error("usage: xlsx_diff A.xlsx B.xlsx [--limit N] [--no-format]");
  process.exit(2);
}

const { formula: af, values: av } = await loadPair(a);
const { formula: bf, values: bv } = await loadPair(b);

const onlyA = af.worksheets.map((w) => w.name).filter((s) => !bf.getWorksheet(s));
const onlyB = bf.worksheets.map((w) => w.name).filter((s) => !af.getWorksheet(s));

function shape(wb: ExcelJS.Workbook, sn: string): string {
  const ws = wb.getWorksheet(sn);
  if (!ws) return "";
  let head = "";
  for (let r = 1; r <= Math.min(8, ws.rowCount); r++) {
    const parts: string[] = [];
    ws.getRow(r).eachCell({ includeEmpty: false }, (c) => {
      if (c.value != null) parts.push(String(c.value));
    });
    if (parts.length) {
      head = parts.join(" | ");
      break;
    }
  }
  return `${ws.rowCount}x${ws.columnCount}, first row: ${head.slice(0, 120)}`;
}

if (onlyA.length) {
  console.log(`# sheets only in A: ${JSON.stringify(onlyA)}`);
  for (const sn of onlyA) console.log(`#   A!${sn}: ${shape(af, sn)}`);
}
if (onlyB.length) {
  console.log(`# sheets only in B: ${JSON.stringify(onlyB)}`);
  for (const sn of onlyB) console.log(`#   B!${sn}: ${shape(bf, sn)}`);
}

const shared = af.worksheets
  .map((w) => w.name)
  .filter((s) => bf.getWorksheet(s));
if (!shared.length) {
  console.log(
    "# no sheet name is shared: nothing below was compared — read the sheets above directly",
  );
}

let total = 0;
for (const sn of shared) {
  const wsaf = af.getWorksheet(sn)!;
  const wsav = av.getWorksheet(sn)!;
  const wsbf = bf.getWorksheet(sn)!;
  const wsbv = bv.getWorksheet(sn)!;
  const coords = new Set([...collectCoords(wsaf), ...collectCoords(wsbf)]);
  const sorted = sortCoords(coords, wsaf);
  const diffs: string[] = [];
  for (const coord of sorted) {
    const { fa, va, sa } = cellLine(wsaf, wsav, coord);
    const { fa: fb, va: vb, sa: sb } = cellLine(wsbf, wsbv, coord);
    if (fa !== fb || !same(va, vb)) {
      diffs.push(`${sn}!${coord} | A: ${sa} | B: ${sb}`);
    }
  }
  total += diffs.length;
  console.log(`\n## ${sn}: ${diffs.length} differing cells`);
  for (const line of diffs.slice(0, limit)) console.log(line);
  if (diffs.length > limit) {
    console.log(`... ${diffs.length - limit} more (raise --limit)`);
  }
  if (doFormat) {
    const fdiffs: string[] = [];
    for (const coord of sorted) {
      const fa = fmtCell(wsaf.getCell(coord));
      const fb = fmtCell(wsbf.getCell(coord));
      if (JSON.stringify(fa) !== JSON.stringify(fb)) {
        const names = ["font", "bold", "fill", "numfmt"];
        const changed = names
          .map((n, i) =>
            fa[i] !== fb[i] ? `${n}: ${repr(fa[i])} -> ${repr(fb[i])}` : null,
          )
          .filter(Boolean)
          .join(", ");
        fdiffs.push(`${sn}!${coord} | FORMAT ${changed}`);
      }
    }
    console.log(`## ${sn}: ${fdiffs.length} cells with formatting differences`);
    for (const line of fdiffs.slice(0, limit)) console.log(line);
    if (fdiffs.length > limit) {
      console.log(`... ${fdiffs.length - limit} more (raise --limit)`);
    }
  }
}
console.log(`\n# total differing cells (content): ${total}`);

function repr(v: unknown): string {
  return JSON.stringify(v);
}
