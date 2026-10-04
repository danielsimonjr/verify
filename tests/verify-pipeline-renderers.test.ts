import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";

import {
  renderAtifSteps,
  renderCellsTsv,
  renderOpencodeEvents,
  renderOpenaiMessages,
  wbToolResults,
} from "../harness/materialize/renderers.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vp-render-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function tsvOf(build: (ws: ExcelJS.Worksheet) => void, cap?: number): Promise<string> {
  const wb = new ExcelJS.Workbook();
  build(wb.addWorksheet("S"));
  const xlsx = join(dir, "t.xlsx");
  await wb.xlsx.writeFile(xlsx);
  const out = join(dir, "t.xlsx.cells.tsv");
  expect(await renderCellsTsv(xlsx, out, cap)).toBe(true);
  return readFileSync(out, "utf8");
}

describe("renderCellsTsv cap", () => {
  test("stops at the cap and writes ONE cut marker", async () => {
    const text = await tsvOf((ws) => {
      for (let r = 1; r <= 3; r++) for (let c = 1; c <= 4; c++) ws.getCell(r, c).value = `v${r}-${c}`;
    }, 5);
    const lines = text.split("\n").filter(Boolean);
    expect(lines[0]).toMatch(/^# sheets: S; cells 5; /);
    expect(lines.filter((l) => l.startsWith("S!"))).toHaveLength(5);
    expect(lines.filter((l) => l.startsWith("# cut at"))).toEqual(["# cut at 5 cells"]);
  });

  test("a sheet under the cap has no cut marker", async () => {
    const text = await tsvOf((ws) => {
      ws.getCell("A1").value = 1;
      ws.getCell("B1").value = 2;
    }, 5);
    expect(text).not.toContain("# cut");
    expect(text.split("\n").filter((l) => l.startsWith("S!"))).toHaveLength(2);
  });

  test("the cap applies across sheets", async () => {
    const wb = new ExcelJS.Workbook();
    for (const name of ["A", "B"]) {
      const ws = wb.addWorksheet(name);
      for (let r = 1; r <= 3; r++) ws.getCell(r, 1).value = `${name}${r}`;
    }
    const xlsx = join(dir, "two.xlsx");
    await wb.xlsx.writeFile(xlsx);
    const out = join(dir, "two.tsv");
    await renderCellsTsv(xlsx, out, 4);
    const lines = readFileSync(out, "utf8").split("\n");
    expect(lines.filter((l) => /^[AB]!/.test(l))).toHaveLength(4);
    expect(lines.filter((l) => l.startsWith("# cut"))).toHaveLength(1);
  });
});

describe("renderCellsTsv cell text", () => {
  test("a cell note is rendered as its text", async () => {
    const text = await tsvOf((ws) => {
      ws.getCell("A1").value = "x";
      ws.getCell("A1").note = "Use the net figure,\n not gross";
    });
    expect(text).toContain("S!A1\tx\t\t# Use the net figure, not gross");
    expect(text).not.toContain("[object Object]");
  });

  test("a rich-text note (an author run in bold, as Excel writes it) is rendered as its text", async () => {
    const text = await tsvOf((ws) => {
      ws.getCell("A1").value = "x";
      ws.getCell("A1").note = {
        texts: [{ text: "Author:\n", font: { bold: true } }, { text: "enter figures in thousands" }],
      } as ExcelJS.Comment;
    });
    expect(text).toContain("S!A1\tx\t\t# Author: enter figures in thousands");
    expect(text).not.toContain("[object Object]");
  });

  test("a note on a cell that holds no value is kept", async () => {
    // exceljs cannot write a note without a value, and drops a note whose cell is a bare
    // <c r="B2"/> when loading. Excel writes exactly that for a template's empty, noted cell,
    // so build the file with a value and strip the value from the sheet XML.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    ws.getCell("A1").value = "x";
    ws.getCell("B2").value = "placeholder";
    ws.getCell("B2").note = "template says: fill in";
    const xlsx = join(dir, "noted.xlsx");
    await wb.xlsx.writeFile(xlsx);
    const zip = await JSZip.loadAsync(readFileSync(xlsx));
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    const bare = sheet.replace(/<c r="B2"[^>]*>.*?<\/c>/, '<c r="B2"/>');
    expect(bare).not.toBe(sheet);
    zip.file("xl/worksheets/sheet1.xml", bare);
    writeFileSync(xlsx, await zip.generateAsync({ type: "nodebuffer" }));

    const out = join(dir, "noted.tsv");
    expect(await renderCellsTsv(xlsx, out)).toBe(true);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("S!B2\t\t\t# template says: fill in");
    expect(text).toContain("S!A1\tx\t\n");
  });

  test("a cached error value shows the error, not [object Object]", async () => {
    const text = await tsvOf((ws) => {
      ws.getCell("A1").value = { formula: "1/0", result: { error: "#DIV/0!" } } as ExcelJS.CellValue;
    });
    expect(text).toContain("S!A1\t#DIV/0!\t=1/0");
    expect(text).not.toContain("[object Object]");
  });

  test("a hyperlink cell shows its text", async () => {
    const text = await tsvOf((ws) => {
      ws.getCell("A1").value = { text: "the site", hyperlink: "https://example.com/" };
    });
    expect(text).toContain("S!A1\tthe site\t");
    expect(text).not.toContain("[object Object]");
  });

  test("formula with cached value and a literal keep their columns", async () => {
    const text = await tsvOf((ws) => {
      ws.getCell("A1").value = 2;
      ws.getCell("B1").value = { formula: "A1*2", result: 4 };
    });
    expect(text).toContain("S!A1\t2\t");
    expect(text).toContain("S!B1\t4\t=A1*2");
    expect(text).toMatch(/formulas 1, without cached value 0/);
  });
});

describe("renderCellsTsv failures", () => {
  test("an unreadable workbook returns false", async () => {
    const bad = join(dir, "bad.xlsx");
    writeFileSync(bad, "not a zip");
    expect(await renderCellsTsv(bad, join(dir, "bad.tsv"))).toBe(false);
  });

  test("a failed WRITE is an error, not a silent false", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("S").getCell("A1").value = 1;
    const xlsx = join(dir, "ok.xlsx");
    await wb.xlsx.writeFile(xlsx);
    const outIsADirectory = join(dir, "out");
    mkdirSync(outIsADirectory);
    await expect(renderCellsTsv(xlsx, outIsADirectory)).rejects.toThrow();
  });
});

describe("renderAtifSteps tool-result rejoin", () => {
  const traj = (tc: Record<string, unknown>) => ({
    steps: [{ source: "agent", step_id: 1, tool_calls: [{ tool_name: "bash", tool_call_id: "t1", ...tc }] }],
  });

  test("result:null still rejoins the result from the raw CLI stream", () => {
    const text = renderAtifSteps(traj({ result: null }), { t1: "OUT FROM STREAM" });
    expect(text).toContain("[tool_result bash]\nOUT FROM STREAM");
  });

  test("an absent result rejoins too", () => {
    expect(renderAtifSteps(traj({}), { t1: "OUT" })).toContain("[tool_result bash]\nOUT");
  });

  test("an empty-string rejoined result is still shown (the tool printed nothing)", () => {
    expect(renderAtifSteps(traj({}), { t1: "" })).toContain("[tool_result bash]\n");
  });

  test("an inline result wins over the stream", () => {
    const text = renderAtifSteps(traj({ result: "INLINE" }), { t1: "STREAM" });
    expect(text).toContain("[tool_result bash]\nINLINE");
    expect(text).not.toContain("STREAM");
  });

  test("output is used when result is null", () => {
    expect(renderAtifSteps(traj({ result: null, output: "FROM OUTPUT" }), {})).toContain("FROM OUTPUT");
  });

  test("a tool call id that is an Object.prototype name does not leak a function", () => {
    const text = renderAtifSteps(traj({ tool_call_id: "constructor" }), {});
    expect(text).not.toContain("tool_result");
    expect(text).not.toContain("function");
  });

  test("empty arguments fall through to the next source, as in the Python port", () => {
    const text = renderAtifSteps(
      { steps: [{ tool_calls: [{ name: "x", arguments: "", input: "REAL" }] }] },
      {},
    );
    expect(text).toContain("[tool_call x]\nREAL");
  });

  test("empty list/dict content is not rendered as a message", () => {
    const text = renderAtifSteps({ steps: [{ source: "a", step_id: 2, message: [], thinking: {} }] }, {});
    expect(text).toBe("");
  });
});

describe("wbToolResults", () => {
  test("joins tool_result blocks by tool_use_id and flags errors", () => {
    mkdirSync(join(dir, "agent"));
    const ev = (id: string, content: unknown, err = false) =>
      JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: err }] } });
    writeFileSync(
      join(dir, "agent", "cc-output.txt"),
      [
        ev("a", [{ type: "text", text: "line1" }, { type: "text", text: "line2" }]),
        ev("b", "boom", true),
        "not json",
      ].join("\n"),
    );
    const r = wbToolResults(dir);
    expect(r.a).toBe("line1\nline2");
    expect(r.b).toBe("[tool reported an error]\nboom");
  });
  test("no stream file gives an empty map", () => {
    expect(Object.keys(wbToolResults(dir))).toEqual([]);
  });
});

describe("renderOpencodeEvents", () => {
  test("a JSON line that is not an object is skipped, not a crash", () => {
    const lines = [
      "null",
      "123",
      '"str"',
      "[]",
      "",
      JSON.stringify({ type: "text", part: { text: "hello" } }),
    ];
    expect(renderOpencodeEvents(lines)).toBe("<assistant>\nhello");
  });
});

describe("renderOpenaiMessages", () => {
  test("empty content and tool_calls lists add nothing", () => {
    expect(renderOpenaiMessages([{ role: "assistant", content: [], tool_calls: [] }])).toBe("");
  });
});
