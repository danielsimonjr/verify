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

const MINUS = /^=\s*-|^=\s*\(?\s*[A-Z$0-9!']+\s*-\s*[A-Z$0-9!']+\s*\)?\s*$/;

function cellStr(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && "formula" in v) {
    const f = (v as { formula: string }).formula;
    return f.startsWith("=") ? f : `=${f}`;
  }
  return String(v);
}

function shape(v: unknown): string {
  return String(v)
    .toUpperCase()
    .replace(/\$?[A-Z]{1,3}\$?\d+|\d+(?:\.\d+)?/g, "#");
}

function label(ws: ExcelJS.Worksheet, r: number): string {
  for (let c = 1; c <= Math.min(ws.columnCount, 4); c++) {
    const v = ws.getCell(r, c).value;
    if (typeof v === "string" && v.trim() && !v.startsWith("=")) return v.trim().slice(0, 40);
  }
  return "";
}

const paths = process.argv.slice(2);
if (paths.length < 2) {
  console.log(`xlsx_forks.py FILE1.xlsx FILE2.xlsx [FILE3.xlsx ...]`);
  process.exit(1);
}

const books = new Map<string, ExcelJS.Workbook>();
for (const p of paths) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  books.set(p, wb);
}

const cells = new Map<string, Map<string, unknown>>();

for (const [p, wb] of books) {
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (c) => {
        const key = `${ws.name}\0${c.address}`;
        if (!cells.has(key)) cells.set(key, new Map());
        cells.get(key)!.set(p, cellStr(c.value));
      });
    });
  }
}

let n = 0;
const sortedKeys = [...cells.keys()].sort();
for (const key of sortedKeys) {
  const [sheet, coord] = key.split("\0");
  const by = cells.get(key)!;
  const vals: Record<string, unknown> = {};
  for (const p of paths) vals[p] = by.get(p) ?? null;
  const distinct = new Set(paths.map((p) => String(vals[p] ?? "")));
  if (distinct.size < 2) continue;

  const camps = new Map<string, string[]>();
  for (const p of paths) {
    const v = vals[p];
    const k = v == null ? "" : String(v);
    if (!camps.has(k)) camps.set(k, []);
    camps.get(k)!.push(p);
  }

  const kinds = new Set<string>();
  if (camps.has("")) kinds.add("BLANK");
  const forms = [...camps.keys()].filter((k) => k.startsWith("="));
  if (forms.length >= 2) {
    const signs = new Set(forms.map((f) => MINUS.test(f)));
    kinds.add(
      signs.size === 2
        ? "SIGN"
        : new Set(forms.map(shape)).size > 1
          ? "FORMULA"
          : "VALUE",
    );
  } else if (camps.size - (camps.has("") ? 1 : 0) >= 2) {
    kinds.add("VALUE");
  }

  const firstWb = books.values().next().value!;
  const ws =
    firstWb.getWorksheet(sheet) ??
    null;
  const rowNum = parseInt(coord.replace(/[A-Z]/gi, ""), 10);
  const lbl = ws ? label(ws, rowNum) : "";

  console.log(`[${[...kinds].sort().join("/") || "DIFF"}] ${sheet}!${coord} [${lbl}]`);
  const entries = [...camps.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [k, members] of entries) {
    const names = members
      .map((m) => (m.includes("/deliverables/") ? m.split("/").slice(-3).join("/") : m))
      .join(" ");
    console.log(
      `    ${String(members.length).padStart(2)}  ${k ? k.slice(0, 90) : "(blank)"}   <- ${names}`,
    );
  }
  n++;
  if (n >= 400) {
    console.log("... (cut at 400 cells)");
    break;
  }
}
if (!n) console.log("no differing cells");
process.exit(0);
