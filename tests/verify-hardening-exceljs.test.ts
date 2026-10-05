// Dependabot alert #2 (GHSA-w5hq-g745-h8pq): exceljs 4.4.0 asks for uuid ^8.3.0, and the repo pins uuid
// to ^11.1.1 with a package.json "overrides" entry. exceljs calls only v4(), and only while it writes a
// data bar (without gradient) or an extended icon set. This test drives that path through the
// installed uuid, so a major bump the override lets through, or a CommonJS/ESM mismatch, fails here.
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import ExcelJS from "exceljs";

const GUID = /^\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}$/;

async function conditionalFormattingWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("cf");
  for (let r = 1; r <= 5; r++) ws.getCell(`A${r}`).value = r * 10;
  ws.addConditionalFormatting({
    ref: "A1:A5",
    rules: [
      {
        type: "dataBar",
        priority: 1,
        gradient: false,
        minLength: 0,
        maxLength: 100,
        cfvo: [{ type: "min" }, { type: "max" }],
        color: { argb: "FF638EC6" },
      } as ExcelJS.DataBarRuleType,
    ],
  });
  ws.addConditionalFormatting({
    ref: "B1:B5",
    rules: [
      {
        type: "iconSet",
        priority: 2,
        iconSet: "3Triangles",
        cfvo: [
          { type: "percent", value: 0 },
          { type: "percent", value: 33 },
          { type: "percent", value: 67 },
        ],
      } as ExcelJS.IconSetRuleType,
    ],
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("exceljs conditional formatting (the uuid call site)", () => {
  test("writes a workbook whose x14 conditional-format rules carry v4 GUID ids", async () => {
    const zip = await JSZip.loadAsync(await conditionalFormattingWorkbook());
    const xml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    const ids = [...xml.matchAll(/<x14:cfRule\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]!);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(GUID);
    expect(new Set(ids).size).toBe(2);
  });

  test("reads the workbook back with both rules intact", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await conditionalFormattingWorkbook());
    const rules = wb.getWorksheet("cf")!.conditionalFormattings.flatMap((cf) => cf.rules.map((r) => r.type));
    expect(rules.sort()).toEqual(["dataBar", "iconSet"]);
  });
});
