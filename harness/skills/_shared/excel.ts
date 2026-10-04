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

export type WbPair = { formula: ExcelJS.Workbook; values: ExcelJS.Workbook };

export async function loadPair(path: string): Promise<WbPair> {
  const formula = new ExcelJS.Workbook();
  const values = new ExcelJS.Workbook();
  await formula.xlsx.readFile(path);
  await values.xlsx.readFile(path);
  return { formula, values };
}

export function colLetter(col: number): string {
  let n = col;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function cellCoord(row: number, col: number): string {
  return `${colLetter(col)}${row}`;
}

export function parseCellRef(ref: string): { row: number; col: number } {
  const m = /^([A-Z]{1,3})(\d+)$/i.exec(ref.trim());
  if (!m) throw new Error(`bad cell ref ${ref}`);
  const letters = m[1].toUpperCase();
  let col = 0;
  for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: parseInt(m[2], 10), col };
}

export function sheetDims(ws: ExcelJS.Worksheet): string {
  const d = ws.dimensions;
  if (typeof d === "string" && d) return d;
  return `${ws.rowCount}x${ws.columnCount}`;
}

export function formulaText(cell: ExcelJS.Cell): unknown {
  const v = cell.value;
  if (v && typeof v === "object" && "formula" in v) {
    const f = v as { formula?: string; shareType?: string; ref?: string };
    const text = f.formula ?? "";
    if (f.shareType === "array" && f.ref) return `${text} (array ${f.ref})`;
    return text.startsWith("=") ? text : `=${text}`;
  }
  return v;
}

export function cachedValue(cell: ExcelJS.Cell): unknown {
  const v = cell.value;
  if (v && typeof v === "object" && "formula" in v) {
    return (v as { result?: unknown }).result;
  }
  return v;
}

export function isFormulaValue(v: unknown): boolean {
  if (typeof v === "string" && v.startsWith("=")) return true;
  if (v && typeof v === "object" && "formula" in v) return true;
  return false;
}

export function cellLine(
  wf: ExcelJS.Worksheet,
  wv: ExcelJS.Worksheet,
  coord: string,
): { fa: unknown; va: unknown; sa: string } {
  const f = formulaText(wf.getCell(coord));
  const v = cachedValue(wv.getCell(coord));
  if (isFormulaValue(wf.getCell(coord).value)) {
    const fs =
      typeof f === "string"
        ? f
        : f && typeof f === "object" && "formula" in (f as object)
          ? String((f as { formula: string }).formula)
          : String(f);
    const disp = fs.startsWith("=") ? fs : `=${fs}`;
    return { fa: disp, va: v, sa: `${disp} => ${repr(v)}` };
  }
  return { fa: null, va: f, sa: repr(f) };
}

export function repr(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

export function same(x: unknown, y: unknown): boolean {
  if (
    typeof x === "number" &&
    typeof y === "number" &&
    !Number.isNaN(x) &&
    !Number.isNaN(y)
  ) {
    const tol = 1e-9 * Math.max(1, Math.abs(x));
    return Math.abs(x - y) <= Math.max(tol, 1e-12);
  }
  return x === y;
}

export function fmtCell(c: ExcelJS.Cell): [unknown, boolean, unknown, string] {
  const f = c.font;
  const col =
    f?.color && typeof f.color === "object" && "argb" in f.color
      ? (f.color as { argb?: string }).argb
      : null;
  const fill =
    c.fill &&
    typeof c.fill === "object" &&
    "fgColor" in c.fill &&
    c.fill.fgColor &&
    typeof c.fill.fgColor === "object" &&
    "argb" in c.fill.fgColor
      ? (c.fill.fgColor as { argb?: string }).argb
      : null;
  const bold = Boolean(f?.bold);
  const numfmt = c.numFmt ?? "General";
  return [col, bold, fill, numfmt];
}

export function* iterSheetCells(
  ws: ExcelJS.Worksheet,
  range?: string,
): Generator<ExcelJS.Cell> {
  if (!range) {
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      row.eachCell({ includeEmpty: false }, (cell) => {
        /* collected below */
      });
      for (let c = 1; c <= row.cellCount; c++) {
        const cell = row.getCell(c);
        if (cell.value != null) yield cell;
      }
    }
    return;
  }
  if (!range.includes(":")) {
    yield ws.getCell(range);
    return;
  }
  const [a, b] = range.split(":");
  const start = parseCellRef(a);
  const end = parseCellRef(b);
  for (let r = start.row; r <= end.row; r++) {
    for (let c = start.col; c <= end.col; c++) {
      yield ws.getCell(r, c);
    }
  }
}

export function* iterRows(
  ws: ExcelJS.Worksheet,
  range?: string,
  rowCap?: number,
): Generator<{ rowIndex: number; cells: ExcelJS.Cell[] }> {
  if (range && range.includes(":")) {
    const [a, b] = range.split(":");
    const start = parseCellRef(a);
    const end = parseCellRef(b);
    for (let r = start.row; r <= end.row; r++) {
      const cells: ExcelJS.Cell[] = [];
      for (let c = start.col; c <= end.col; c++) {
        cells.push(ws.getCell(r, c));
      }
      yield { rowIndex: r, cells };
    }
    return;
  }
  if (range && !range.includes(":")) {
    yield { rowIndex: ws.getCell(range).fullAddress.row, cells: [ws.getCell(range)] };
    return;
  }
  let ri = 0;
  for (let r = 1; r <= ws.rowCount; r++) {
    ri++;
    if (rowCap != null && ri > rowCap) break;
    const row = ws.getRow(r);
    const cells: ExcelJS.Cell[] = [];
    row.eachCell({ includeEmpty: false }, (cell) => cells.push(cell));
    if (cells.length) yield { rowIndex: r, cells };
    else yield { rowIndex: r, cells: [] };
  }
}

export function collectCoords(ws: ExcelJS.Worksheet): Set<string> {
  const coords = new Set<string>();
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      coords.add(cell.address);
    });
  });
  return coords;
}

export function sortCoords(
  coords: Iterable<string>,
  ws: ExcelJS.Worksheet,
): string[] {
  return [...coords].sort((a, b) => {
    const ca = ws.getCell(a);
    const cb = ws.getCell(b);
    return ca.fullAddress.row * 10000 +
      ca.fullAddress.col -
      (cb.fullAddress.row * 10000 + cb.fullAddress.col);
  });
}

export function calcPrLine(wb: ExcelJS.Workbook): string {
  const c = wb.calcProperties;
  if (!c) return "# calcPr: None";
  const iterate = (c as { iterate?: boolean }).iterate ?? false;
  const iterateCount = (c as { iterateCount?: number }).iterateCount ?? 0;
  const iterateDelta = (c as { iterateDelta?: number }).iterateDelta ?? 0;
  return (
    `# calcPr: iterate=${iterate} iterateCount=${iterateCount}` +
    ` iterateDelta=${iterateDelta} fullCalcOnLoad=${c.fullCalcOnLoad}` +
    ` calcMode=${(c as { calcMode?: string }).calcMode}`
  );
}
