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

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import ExcelJS from "exceljs";
import { ensureDir } from "../../_shared/dirs.js";
import { cachedValue, isFormulaValue } from "../../_shared/excel.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    baseline: { type: "string" },
    inplace: { type: "boolean", default: false },
    limit: { type: "string", default: "60" },
  },
});
const edited = positionals[0];
if (!edited) {
  console.error("usage: xlsx_recalc.py EDITED.xlsx [--baseline BEFORE.xlsx] [--inplace]");
  process.exit(2);
}

const src = resolve(edited);
const baseline = values.baseline;
const inplace = values.inplace ?? false;
const limit = parseInt(values.limit ?? "60", 10);

const td = mkdtempSync(join(tmpdir(), "xlsx_recalc_"));
const work = join(td, basename(src));
copyFileSync(src, work);
const env = { ...process.env, HOME: td };
const profile = `-env:UserInstallation=${pathToFileURL(join(td, "profile")).href}`;
const outDir = join(td, "out");
ensureDir(outDir);

const r = spawnSync(
  "soffice",
  [
    profile,
    "--headless",
    "--calc",
    "--convert-to",
    "xlsx",
    "--outdir",
    outDir,
    work,
  ],
  { encoding: "utf-8", timeout: 300_000, env },
);

const out = join(outDir, basename(src));
if (r.status !== 0 || !existsSync(out)) {
  console.log("recalc FAILED:", (r.stderr || r.stdout || "").slice(-400));
  process.exit(1);
}

const recalced = readFileSync(out);
const wb_new = new ExcelJS.Workbook();
await wb_new.xlsx.readFile(out);
const wb_old = baseline ? new ExcelJS.Workbook() : null;
if (baseline) await wb_old!.xlsx.readFile(resolve(baseline));
const wb_fml = new ExcelJS.Workbook();
await wb_fml.xlsx.readFile(out);

let changed = 0;
let uncached = 0;
for (const ws of wb_new.worksheets) {
  const wf = wb_fml.getWorksheet(ws.name)!;
  const wo =
    wb_old && wb_old.getWorksheet(ws.name) ? wb_old.getWorksheet(ws.name)! : null;
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (c) => {
      const f = wf.getCell(c.address).value;
      const cv = cachedValue(c);
      if (isFormulaValue(f) && cv == null) uncached++;
      if (!wo) return;
      const o = cachedValue(wo.getCell(c.address));
      const nv = cv;
      const close =
        typeof o === "number" &&
        typeof nv === "number" &&
        Math.abs(o - nv) <= 1e-9 * Math.max(1, Math.abs(o));
      if (o !== nv && !close) {
        changed++;
        if (changed <= limit) {
          const fstr =
            typeof f === "string" && f.startsWith("=")
              ? f
              : f && typeof f === "object" && "formula" in f
                ? `=${(f as { formula: string }).formula}`
                : "";
          console.log(`${ws.name}!${c.address}: ${repr(o)} -> ${repr(nv)}   ${fstr}`);
        }
      }
    });
  });
}

if (wb_old) {
  console.log(
    `# cells whose cached value changed vs baseline: ${changed}` +
      (changed > limit ? ` (showing ${limit})` : ""),
  );
}
console.log(`# formulas still without a cached value after recalc: ${uncached}`);

let sideDir = dirname(src);
let cur = dirname(src);
while (cur !== dirname(cur)) {
  const base = basename(cur);
  const parent = dirname(cur);
  if (base === "deliverables" && basename(parent) === "out") {
    sideDir = join(parent, "recalc", relative(cur, dirname(src)));
    ensureDir(sideDir);
    break;
  }
  cur = parent;
}

const stem = basenameNoExt(src);
if (inplace) {
  const keep = join(sideDir, `${stem}.pre-recalc.xlsx`);
  copyFileSync(src, keep);
  writeFileSync(src, recalced);
  console.log(
    `# replaced ${basename(src)} with the recalculated file (previous version kept as ${keep})`,
  );
} else {
  const dst = join(sideDir, `${stem}.recalc.xlsx`);
  writeFileSync(dst, recalced);
  console.log(`# recalculated copy written to ${dst}`);
}

function basenameNoExt(p: string): string {
  const base = basename(p);
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(0, dot) : base;
}

function repr(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}
