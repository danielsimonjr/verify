import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";

import { BENCHES, LANES, REPO, benchRoot } from "../harness/config.ts";
import { baseOf } from "../harness/driver.ts";
import { isLeakBlocked } from "../harness/materialize/base.ts";
import { renderCellsTsv, renderOpenaiMessages } from "../harness/materialize/renderers.ts";
import { isView } from "../harness/views.ts";
import { main as cliMain } from "../harness/cli.ts";

describe("config", () => {
  test("repo contains harness/", () => {
    expect(REPO.endsWith("workspace") || REPO.includes("workspace")).toBe(true);
    expect(BENCHES).toContain("sb2");
    expect(LANES.flash.join(" ")).toContain("gemini-3.5-flash");
  });
  test("benchRoot throws when unset", () => {
    const prev = process.env.VERIHARNESS_BENCH_ROOT;
    delete process.env.VERIHARNESS_BENCH_ROOT;
    try {
      expect(() => benchRoot()).toThrow(/VERIHARNESS_BENCH_ROOT/);
    } finally {
      if (prev !== undefined) process.env.VERIHARNESS_BENCH_ROOT = prev;
    }
  });
});

describe("driver.baseOf", () => {
  test("normalises rollout paths and none", () => {
    expect(baseOf({ base: "rollouts/r08/" })).toBe("r08");
    expect(baseOf({ pick: "r01" })).toBe("r01");
    expect(baseOf({ base: "none" })).toBe("none");
    expect(baseOf({ base: "null" })).toBe("none");
    expect(baseOf({})).toBe("none");
  });
});

describe("views", () => {
  test("isView recognises harness sidecars", () => {
    expect(isView("book.xlsx.cells.tsv")).toBe(true);
    expect(isView("doc.docx.text.txt")).toBe(true);
    expect(isView("a.pre-recalc.xlsx")).toBe(true);
    expect(isView("a.recalc.xlsx")).toBe(true);
    expect(isView("answer.md")).toBe(false);
  });
});

describe("materialize leak blocklist", () => {
  test("blocks answer-key names", () => {
    expect(isLeakBlocked("grades.json")).toBe(true);
    expect(isLeakBlocked("rubrics_judge--x.json")).toBe(true);
    expect(isLeakBlocked("golden_response.xlsx")).toBe(true);
    expect(isLeakBlocked("answer.md")).toBe(false);
  });
});

describe("renderers", () => {
  test("renderOpenaiMessages drops system and keeps tools", () => {
    const text = renderOpenaiMessages([
      { role: "system", content: "secret" },
      { role: "assistant", content: "hi", tool_calls: [{ function: { name: "read", arguments: "{}" } }] },
      { role: "tool", name: "read", content: "ok" },
    ]);
    expect(text).not.toContain("secret");
    expect(text).toContain("[tool_call read]");
    expect(text).toContain("[tool_result read]");
  });

  test("renderCellsTsv writes header and formula rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vh-cells-"));
    const xlsx = join(dir, "t.xlsx");
    const tsv = join(dir, "t.xlsx.cells.tsv");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.getCell("A1").value = "hello";
    ws.getCell("B1").value = { formula: "A1", result: "hello" };
    await wb.xlsx.writeFile(xlsx);
    expect(await renderCellsTsv(xlsx, tsv)).toBe(true);
    const body = await Bun.file(tsv).text();
    expect(body.startsWith("# sheets: Sheet1;")).toBe(true);
    expect(body).toContain("Sheet1!A1\thello\t");
    expect(body).toContain("Sheet1!B1\thello\t=A1");
  });
});

describe("cli", () => {
  test("unknown command exits 2", async () => {
    expect(await cliMain(["nope"])).toBe(2);
  });
  test("materialize without bench exits 2", async () => {
    expect(await cliMain(["materialize"])).toBe(2);
  });
});
