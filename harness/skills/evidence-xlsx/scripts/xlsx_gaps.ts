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

import ExcelJS from "exceljs";
import { cachedValue, colLetter, isFormulaValue, loadPair } from "../../_shared/excel.js";

const ERRORS = new Set(["#DIV/0!", "#REF!", "#VALUE!", "#N/A", "#NAME?", "#NUM!"]);
const REF =
  /(?:'([^']+)'|([A-Za-z0-9_]+))?!?\$?([A-Z]{1,3})\$?(\d+)(?![\d(])/g;

function filled(v: unknown): boolean {
  return v != null && !(typeof v === "string" && !v.trim());
}

function label(ws: ExcelJS.Worksheet, r: number): string {
  for (let c = 1; c <= Math.min(ws.columnCount, 4); c++) {
    const v = ws.getCell(r, c).value;
    if (typeof v === "string" && v.trim() && !isFormulaValue(v)) return v.trim().slice(0, 40);
  }
  return "";
}

function periodCols(ws: ExcelJS.Worksheet): number[] {
  const counts = new Map<number, number>();
  let rows = 0;
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = row.values as unknown[];
    const cells: { col: number; val: unknown }[] = [];
    row.eachCell({ includeEmpty: false }, (cell) => {
      const col = cell.fullAddress.col;
      if (col > 1 && filled(cell.value)) cells.push({ col, val: cell.value });
    });
    if (cells.length >= 3) {
      rows++;
      for (const c of cells) counts.set(c.col, (counts.get(c.col) ?? 0) + 1);
    }
  });
  return [...counts.entries()]
    .filter(([, n]) => rows && n >= 0.5 * rows)
    .map(([c]) => c)
    .sort((a, b) => a - b);
}

function shape(formula: string): string {
  return formula.toUpperCase().replace(/\$?[A-Z]{1,3}\$?\d+/g, "#");
}

function refs(formula: string, sheet: string): [string, string][] {
  const out: [string, string][] = [];
  for (const m of formula.matchAll(REF)) {
    const sh = m[1] || m[2] || sheet;
    out.push([sh, `${m[3]}${m[4]}`]);
  }
  return out;
}

const path = process.argv[2];
if (!path) {
  console.log(`xlsx_gaps.py WORKBOOK.xlsx`);
  process.exit(1);
}

const { formula: wb_f, values: wb_v } = await loadPair(path);
let found = 0;

for (const ws of wb_f.worksheets) {
  const wsv = wb_v.getWorksheet(ws.name)!;
  const band = periodCols(ws);
  if (band.length < 2) continue;
  const lines: string[] = [];
  const rows: Record<
    number,
    [number[], number[], string]
  > = {};

  for (let r = 1; r <= ws.rowCount; r++) {
    const cells: Record<number, unknown> = {};
    for (const c of band) cells[c] = ws.getCell(r, c).value;
    const forms = band.filter((c) => isFormulaValue(cells[c]));
    const empty = band.filter((c) => !filled(cells[c]));
    if (forms.length) {
      const f0 = cells[forms[0]];
      const fstr =
        typeof f0 === "string"
          ? f0
          : f0 && typeof f0 === "object" && "formula" in f0
            ? String((f0 as { formula: string }).formula)
            : "";
      rows[r] = [forms, empty, shape(fstr)];
      if (empty.length && forms.length >= 2) {
        lines.push(
          `  RAGGED   row ${r} [${label(ws, r)}]: formula in ${colLetter(forms[0])}..${colLetter(forms[forms.length - 1])}, empty [${empty.map(colLetter).join(", ")}]`,
        );
      }
    }
  }

  for (let r = 1; r <= ws.rowCount; r++) {
    const lbl = label(ws, r);
    if (!lbl || rows[r]) continue;
    if (band.every((c) => !filled(ws.getCell(r, c).value))) {
      const near = [r - 2, r - 1, r + 1, r + 2].filter(
        (q) => q in rows && !rows[q][1].length,
      );
      if (near.length) {
        const q = near[0];
        lines.push(
          `  SIBLING  row ${r} [${lbl}] blank across ${colLetter(band[0])}..${colLetter(band[band.length - 1])}; row ${q} [${label(ws, q)}] is filled with the same layout`,
        );
      }
    }
  }

  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (c) => {
      const val = c.value;
      if (!isFormulaValue(val)) return;
      const fstr =
        typeof val === "string"
          ? val
          : val && typeof val === "object" && "formula" in val
            ? String((val as { formula: string }).formula)
            : "";
      const fdisp = fstr.startsWith("=") ? fstr : `=${fstr}`;
      for (const [sh, coord] of refs(fdisp, ws.name)) {
        if (!wb_f.getWorksheet(sh)) continue;
        const tgt = wb_f.getWorksheet(sh)!.getCell(coord);
        if (filled(tgt.value)) continue;
        const trow = tgt.fullAddress.row;
        const shWs = wb_f.getWorksheet(sh)!;
        if (
          band.some(
            (k) => k !== tgt.fullAddress.col && filled(shWs.getCell(trow, k).value),
          )
        ) {
          lines.push(
            `  DANGLING ${ws.name}!${c.address} reads empty ${sh}!${coord} (row ${trow} [${label(shWs, trow)}] is otherwise populated)`,
          );
        }
      }
      const v = cachedValue(wsv.getCell(c.address));
      if (typeof v === "string" && ERRORS.has(v)) {
        const empties = refs(fdisp, ws.name)
          .filter(
            ([sh, k]) =>
              wb_f.getWorksheet(sh) && !filled(wb_f.getWorksheet(sh)!.getCell(k).value),
          )
          .map(([sh, k]) => `${sh}!${k}`);
        lines.push(
          `  ERROR    ${ws.name}!${c.address} shows ${v}` +
            (empties.length ? `; it reads empty ${JSON.stringify(empties)}` : ""),
        );
      }
    });
  });

  if (lines.length) {
    const uniq = [...new Map(lines.map((l) => [l, l])).keys()];
    found += uniq.length;
    console.log(
      `## ${ws.name}  (period band ${colLetter(band[0])}..${colLetter(band[band.length - 1])})`,
    );
    console.log(uniq.join("\n"));
  }
}

if (!found) console.log("no structural gaps found");
process.exit(0);
