import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { extractWords, loadPdf } from "../harness/skills/_shared/pdf.ts";

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
