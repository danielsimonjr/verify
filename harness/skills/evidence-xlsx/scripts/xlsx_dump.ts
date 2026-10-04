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
import {
  calcPrLine,
  cachedValue,
  formulaText,
  isFormulaValue,
  loadPair,
  parseCellRef,
  repr,
  sheetDims,
} from "../../_shared/excel.js";

const ROW_CAP = 200;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { all: { type: "boolean", default: false } },
});
const path = positionals[0];
const sheet = positionals[1];
const rng = positionals[2];
const showAll = values.all ?? false;

if (!path) {
  console.error(`usage: xlsx_dump FILE [SHEET] [RANGE] [--all]`);
  process.exit(2);
}

const { formula: wbf, values: wbv } = await loadPair(path);
console.log(`# ${path}`);
console.log(`# sheets: ${wbf.worksheets.map((w) => w.name).join(", ")}`);
console.log(calcPrLine(wbf));

const sheetNames = sheet ? [sheet] : wbf.worksheets.map((w) => w.name);

for (const sn of sheetNames) {
  const wsf = wbf.getWorksheet(sn);
  const wsv = wbv.getWorksheet(sn);
  if (!wsf || !wsv) continue;
  console.log(`\n## ${sn}  (dims ${sheetDims(wsf)})`);
  let n = 0;
  let r_i = 0;

  const emitCell = (coord: string) => {
    const c = wsf.getCell(coord);
    if (c.value == null) return;
    n++;
    const f = formulaText(c);
    if (isFormulaValue(c.value)) {
      const fs = typeof f === "string" ? f : String(f);
      const disp = fs.startsWith("=") ? fs : `=${fs}`;
      console.log(`${coord}\t${disp}\t=> ${repr(cachedValue(wsv.getCell(coord)))}`);
    } else {
      console.log(`${coord}\t${repr(c.value)}`);
    }
  };

  if (rng && rng.includes(":")) {
    const [a, b] = rng.split(":");
    const start = parseCellRef(a);
    const end = parseCellRef(b);
    for (let r = start.row; r <= end.row; r++) {
      r_i++;
      for (let col = start.col; col <= end.col; col++) {
        emitCell(`${wsf.getCell(r, col).address}`);
      }
    }
  } else if (rng) {
    emitCell(rng);
  } else {
    for (let r = 1; r <= wsf.rowCount; r++) {
      r_i++;
      if (!showAll && r_i > ROW_CAP) {
        console.log(
          `# ... cut at row ${ROW_CAP} of ${wsf.rowCount}; pass a RANGE or --all for the rest`,
        );
        break;
      }
      const row = wsf.getRow(r);
      row.eachCell({ includeEmpty: false }, (cell) => emitCell(cell.address));
    }
  }
  console.log(`# ${n} non-empty cells`);
}
