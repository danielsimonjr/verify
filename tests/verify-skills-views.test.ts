import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderViews } from "../harness/views.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "verify-skills");

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/** Run renderViews over a scratch copy of one fixture and return the view it wrote. */
async function viewOf(fixture: string): Promise<{ written: number; text: string }> {
  const dir = mkdtempSync(join(tmpdir(), "vs-view-"));
  try {
    copyFileSync(join(FIXTURES, fixture), join(dir, fixture));
    const written = await renderViews(dir);
    return { written, text: read(join(dir, `${fixture}.text.txt`)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// deck.pptx comes from make_pptx_fixtures.py: slides stored as Alpha, Beta, Gamma but shown as
// Gamma, Alpha, Beta, and notesSlide1.xml belongs to Gamma. The pre-port view
// (0f10db9:harness/views.py _pptx_text) printed the same lines, except that it skipped text
// inside groups and left a line break as a raw vertical tab.
describe("pptx text view (materialized .text.txt)", () => {
  test("holds the slides in presentation order with text, tables, groups and speaker notes", async () => {
    const { written, text } = await viewOf("deck.pptx");
    expect(written).toBe(1);
    expect(text).toBe(read(join(FIXTURES, "deck.text-view.expected.txt")));
  });
});

// view.docx comes from make_docx_view_fixture.py and view.text-view.expected.txt is what the
// pre-port view (0f10db9:harness/views.py _docx_text, python-docx 1.2.0) wrote for it.
describe("docx text view (materialized .text.txt)", () => {
  test("reads text, headings and merged table cells as python-docx does", async () => {
    const { written, text } = await viewOf("view.docx");
    expect(written).toBe(1);
    expect(text).toBe(read(join(FIXTURES, "view.text-view.expected.txt")));
  });

  test("keeps numeric runs and the spaces between runs", async () => {
    const { text } = await viewOf("view.docx");
    expect(text).toContain("Total 2024 units");
    expect(text).toContain("Hello world");
  });
});
