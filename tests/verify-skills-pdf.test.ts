import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { extractWords, loadPdf } from "../harness/skills/_shared/pdf.ts";
import { findPython, importProbe, pythonCandidates, sibling } from "../harness/skills/_shared/python.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "verify-skills");
const SCRIPTS = join(import.meta.dir, "..", "harness", "skills", "evidence-pdf", "scripts");

// Fixtures come from fixtures/verify-skills/make_pdf_fixtures.py (PyMuPDF). On the
// 612x792 page FIRSTLINE has its baseline 100 pt from the top and SECONDLINE 200 pt.
// pdfplumber (the pre-port reference) reports top 90.5 and 190.5 for them.

async function wordsOf(file: string) {
  const pdf = await loadPdf(join(FIXTURES, file));
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  return { viewport, words: await extractWords(page) };
}

function byText(words: { text: string }[], text: string) {
  const w = words.find((x) => x.text === text);
  if (!w) throw new Error(`no word ${text} in ${JSON.stringify(words)}`);
  return w as (typeof words)[number] & { top: number; x0: number; x1: number };
}

describe("pdf words: top-left origin", () => {
  test("upright page: top is measured from the top and lines read top to bottom", async () => {
    const { words } = await wordsOf("two-lines.pdf");
    expect(words.map((w) => w.text)).toEqual(["FIRSTLINE", "SECONDLINE"]);
    const first = byText(words, "FIRSTLINE");
    const second = byText(words, "SECONDLINE");
    expect(first.top).toBeCloseTo(90.5, 0);
    expect(second.top).toBeCloseTo(190.5, 0);
    expect(first.x0).toBeCloseTo(72, 0);
    expect(first.x1).toBeCloseTo(72 + 61.3, 0);
  });

  test("rotated page: coordinates are those of the displayed page", async () => {
    const { viewport, words } = await wordsOf("two-lines-rotated90.pdf");
    // /Rotate 90 displays the page 792 wide and 612 high; the text then runs downward.
    expect([viewport.width, viewport.height]).toEqual([792, 612]);
    const first = byText(words, "FIRSTLINE");
    const second = byText(words, "SECONDLINE");
    // pdfplumber: SECONDLINE top 72.0 x0 589.5 x1 601.5, FIRSTLINE top 72.0 x0 689.5 x1 701.5
    expect(second.top).toBeCloseTo(72, 0);
    expect(second.x0).toBeCloseTo(589.5, 0);
    expect(second.x1).toBeCloseTo(601.5, 0);
    expect(first.top).toBeCloseTo(72, 0);
    expect(first.x0).toBeCloseTo(689.5, 0);
    expect(first.x1).toBeCloseTo(701.5, 0);
    // top to bottom, then left to right: equal tops fall back to x0.
    expect(words.map((w) => w.text)).toEqual(["SECONDLINE", "FIRSTLINE"]);
  });

  test("pdf_words prints the lines top to bottom", () => {
    const r = spawnSync(
      process.execPath,
      [join(SCRIPTS, "pdf_words.ts"), join(FIXTURES, "two-lines.pdf"), "1"],
      { encoding: "utf-8" },
    );
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toContain("size 612x792 pt");
    expect(lines[1]).toContain("FIRSTLINE");
    expect(lines[2]).toContain("SECONDLINE");
  });
});

// pdf_tables hands off to the retained pdfplumber script, so the end-to-end cases need a
// Python that can import it (the task images install it next to PyMuPDF; CI does not).
function pythonWith(module: string): boolean {
  for (const py of pythonCandidates()) {
    const r = spawnSync(py, ["-c", `import ${module}`], { stdio: "ignore" });
    if (r.status === 0) return true;
  }
  return false;
}
const HAVE_PDFPLUMBER = pythonWith("pdfplumber");

function tablesCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(
    process.execPath,
    [join(SCRIPTS, "pdf_tables.ts"), join(FIXTURES, "tables.pdf"), ...args],
    { encoding: "utf-8", env },
  );
}

describe("pdf_tables detects tables, not text", () => {
  // tables.pdf: p1 prose, p2 ruled 3x3, p3 whitespace-aligned columns, p4 ruled with a
  // two-line cell. The expected cells are what pdfplumber 0.11 extracts from the same file.
  const e2e = test.skipIf(!HAVE_PDFPLUMBER);

  e2e("a prose page is not reported as a table", () => {
    const r = tablesCli(["1"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no table detected on page(s) [1]");
    expect(r.stdout).not.toContain("# page 1 table");
  });

  e2e("a ruled table keeps its rows and columns", () => {
    const r = tablesCli(["2"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split(/\r?\n/)).toEqual([
      "# page 2 table 1: 3 rows x 3 cols",
      "Item\tQty\tPrice",
      "Widget\t4\t9.50",
      "Gadget\t12\t3.25",
    ]);
  });

  e2e("a multi-line cell stays one cell", () => {
    const r = tablesCli(["4"]);
    expect(r.stdout.trim().split(/\r?\n/)).toEqual([
      "# page 4 table 1: 2 rows x 2 cols",
      "Note continued\tStatus",
      "Late fee\tWaived",
    ]);
  });

  e2e("--all-pages reports only the pages that hold a table", () => {
    const r = tablesCli(["1", "--all-pages"]);
    const heads = r.stdout.split(/\r?\n/).filter((l) => l.startsWith("# page"));
    expect(heads).toEqual(["# page 2 table 1: 3 rows x 3 cols", "# page 4 table 1: 2 rows x 2 cols"]);
  });

  e2e("whitespace-aligned columns need --strategy text, which is passed through", () => {
    expect(tablesCli(["3"]).stdout).toContain("no table detected");
    const r = tablesCli(["3", "--strategy", "text"]);
    expect(r.stdout).toContain("# page 3 table 1:");
    expect(r.stdout).toContain("Region\tUnits\tRevenue");
  });
});

describe("python hand-off", () => {
  test("findPython returns the first candidate whose probe passes", () => {
    const seen: string[] = [];
    const probe = (py: string, modules: readonly string[]) => {
      seen.push(`${py}:${modules.join("+")}`);
      return py === "second";
    };
    expect(findPython(["pdfplumber"], probe, ["first", "second", "third"])).toBe("second");
    expect(seen).toEqual(["first:pdfplumber", "second:pdfplumber"]);
  });

  test("findPython needs every module and returns null when no candidate has them", () => {
    const both = (py: string, modules: readonly string[]) =>
      py === "a" ? modules.every((m) => m === "fitz") : modules.length === 2;
    expect(findPython(["fitz", "pdfplumber"], both, ["a", "b"])).toBe("b");
    expect(findPython(["fitz", "pdfplumber"], () => false, ["a", "b"])).toBeNull();
  });

  test("importProbe is false for a binary that does not exist", () => {
    expect(importProbe("python-that-does-not-exist-vs", ["os"])).toBe(false);
  });

  test("sibling finds the script in the source tree when run from dist/", () => {
    const root = mkdtempSync(join(tmpdir(), "vs-sibling-"));
    try {
      const src = join(root, "harness", "skills", "evidence-pdf", "scripts");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "pdf_tables.py"), "# stub\n");
      const compiled = join(root, "dist", "harness", "skills", "evidence-pdf", "scripts");
      const meta = pathToFileURL(join(compiled, "pdf_tables.js")).href;
      expect(sibling(meta, "pdf_tables.py")).toBe(join(src, "pdf_tables.py"));
      // a file that exists in neither place resolves to the next-to-the-script path
      expect(sibling(meta, "absent.py")).toBe(join(compiled, "absent.py"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pdf_tables says so, and exits non-zero, when no Python can import pdfplumber", () => {
    const r = tablesCli(["2"], { ...process.env, VERIHARNESS_PYTHON: "no-such-python-vs" });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("pdfplumber");
    expect(r.stdout).not.toContain("table 1");
  });

  test("VERIHARNESS_PYTHON replaces the default interpreter list", () => {
    expect(pythonCandidates({ VERIHARNESS_PYTHON: " a , b ," })).toEqual(["a", "b"]);
    expect(pythonCandidates({})).toContain(process.platform === "win32" ? "python" : "python3");
  });
});
