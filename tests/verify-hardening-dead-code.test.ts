// Dead code that `tsc --noUnusedLocals --noUnusedParameters --noImplicitReturns` reported, removed with
// no change of behaviour. These tests pin the behaviour of the code around each removal: they pass
// before and after, and tsconfig now turns the flags on so the dead code cannot come back.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";

import { iterSheetCells } from "../harness/skills/_shared/excel.ts";

const SCRIPTS = join(import.meta.dir, "..", "harness", "skills", "evidence-xlsx", "scripts");
const tmp = mkdtempSync(join(tmpdir(), "vh-deadcode-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function script(name: string, ...args: string[]): string[] {
  const r = spawnSync(process.execPath, [join(SCRIPTS, name), ...args], { encoding: "utf-8" });
  expect(r.status).toBe(0);
  return r.stdout.trim().split(/\r?\n/);
}

describe("iterSheetCells (excel.ts: a no-op eachCell loop was removed)", () => {
  test("a whole-sheet walk yields the non-empty cells in row-major order", () => {
    const ws = new ExcelJS.Workbook().addWorksheet("S");
    ws.getCell("B1").value = "b1";
    ws.getCell("A2").value = "a2";
    ws.getCell("C2").value = 0;
    ws.getCell("A4").value = "a4";
    expect([...iterSheetCells(ws)].map((c) => c.address)).toEqual(["B1", "A2", "C2", "A4"]);
  });

  test("a range walk yields every cell of the range, empty ones included", () => {
    const ws = new ExcelJS.Workbook().addWorksheet("S");
    ws.getCell("A1").value = 1;
    expect([...iterSheetCells(ws, "A1:B2")].map((c) => c.address)).toEqual(["A1", "B1", "A2", "B2"]);
  });
});

describe("xlsx_gaps (a never-read `vals` local was removed)", () => {
  test("reports a ragged formula row across the period band", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    ws.addRow(["Revenue", 10, 20, 30]);
    ws.getCell("A3").value = "Cost";
    ws.getCell("B3").value = { formula: "B1*2", result: 20 };
    ws.getCell("C3").value = { formula: "C1*2", result: 40 };
    const file = join(tmp, "gaps.xlsx");
    await wb.xlsx.writeFile(file);
    expect(script("xlsx_gaps.ts", file)).toEqual([
      "## S  (period band B..D)",
      "  RAGGED   row 3 [Cost]: formula in B..C, empty [D]",
    ]);
  });
});

describe("xlsx_forks (a never-used `Key` type was removed)", () => {
  test("lists a cell that two workbooks disagree on, grouped by value", async () => {
    const make = async (name: string, value: number) => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("S");
      ws.getCell("A1").value = "Total";
      ws.getCell("B1").value = value;
      const file = join(tmp, name);
      await wb.xlsx.writeFile(file);
      return file;
    };
    const one = await make("one.xlsx", 1);
    const two = await make("two.xlsx", 2);
    expect(script("xlsx_forks.ts", one, two)).toEqual([
      "[VALUE] S!B1 [Total]",
      `     1  1   <- ${one}`,
      `     1  2   <- ${two}`,
    ]);
  });
});
