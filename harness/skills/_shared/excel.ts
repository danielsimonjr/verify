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

/** One workbook file opened twice: read formulas from `formula` and cached results from `values`. */
export type WbPair = { formula: ExcelJS.Workbook; values: ExcelJS.Workbook };

/** Open the workbook at `path` twice and return the two copies as a `WbPair`. */
export async function loadPair(path: string): Promise<WbPair> {
  const formula = new ExcelJS.Workbook();
  const values = new ExcelJS.Workbook();
  await formula.xlsx.readFile(path);
  await values.xlsx.readFile(path);
  return { formula, values };
}

/** The column letters of a 1-based column number: 1 is "A", 27 is "AA". */
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

/** The A1-style address of a 1-based row and column, for example `B7`. */
export function cellCoord(row: number, col: number): string {
  return `${colLetter(col)}${row}`;
}

/** Split an A1-style address into a 1-based row and column. Throws on text that is not an address. */
export function parseCellRef(ref: string): { row: number; col: number } {
  const m = /^([A-Z]{1,3})(\d+)$/i.exec(ref.trim());
  if (!m) throw new Error(`bad cell ref ${ref}`);
  const letters = m[1].toUpperCase();
  let col = 0;
  for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: parseInt(m[2], 10), col };
}

/** The stored dimension range of a sheet, or `<rows>x<columns>` when the sheet has none. */
export function sheetDims(ws: ExcelJS.Worksheet): string {
  const d = ws.dimensions;
  if (typeof d === "string" && d) return d;
  return `${ws.rowCount}x${ws.columnCount}`;
}

/**
 * The formula of a cell with a leading `=`; an array formula adds ` (array <ref>)`.
 * A cell that holds no formula returns its plain value.
 */
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

/** The cached result of a formula cell; a cell without a formula returns its plain value. */
export function cachedValue(cell: ExcelJS.Cell): unknown {
  const v = cell.value;
  if (v && typeof v === "object" && "formula" in v) {
    return (v as { result?: unknown }).result;
  }
  return v;
}

/** True when `v` is a string that starts with `=` or a cell value object that holds a formula. */
export function isFormulaValue(v: unknown): boolean {
  if (typeof v === "string" && v.startsWith("=")) return true;
  if (v && typeof v === "object" && "formula" in v) return true;
  return false;
}

/**
 * Describe one cell for a text view: `fa` is the formula text (null for a plain cell), `va` the
 * cached or plain value, and `sa` the display string, `=<formula> => <value>` for a formula.
 * The formula is read from `wf` and the value from `wv`.
 */
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

/** A string as a JSON quoted literal; any other value as `String(v)`. */
export function repr(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

/** True when `x` and `y` are equal. Two numbers match within a relative tolerance of 1e-9. */
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

/** The format of a cell as `[font colour ARGB or null, bold, fill colour ARGB or null, number format]`; the number format is "General" when none is set. */
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

/**
 * Yield the cells of a sheet. With no range: every cell that holds a value, row by row. With one
 * address: that cell. With `A1:C3`: every cell of the rectangle, empty or not.
 */
export function* iterSheetCells(
  ws: ExcelJS.Worksheet,
  range?: string,
): Generator<ExcelJS.Cell> {
  if (!range) {
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
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

/**
 * Yield `{ rowIndex, cells }` for each row. With a `A1:C3` range: every cell of each row of the
 * rectangle. With one address: that one cell. With no range: rows from 1, holding the non-empty cells
 * of each row, at most `rowCap` rows.
 */
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

/** The addresses of all non-empty cells of a sheet, as a set. */
export function collectCoords(ws: ExcelJS.Worksheet): Set<string> {
  const coords = new Set<string>();
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      coords.add(cell.address);
    });
  });
  return coords;
}

/** The addresses in `coords` sorted by row, then by column, using the cells of `ws`. */
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

/** The workbook calculation settings as one `# calcPr: ...` line, or `# calcPr: None` when it has none. */
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
