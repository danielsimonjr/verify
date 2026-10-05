import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "fixtures", "verify-skills");
const SCRIPTS = join(import.meta.dir, "..", "harness", "skills", "evidence-docx", "scripts");

function run(script: string, file: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), join(FIXTURES, file), ...args], {
    encoding: "utf-8",
  });
  expect(r.status).toBe(0);
  return r.stdout.trim().split(/\r?\n/);
}

// changes.docx comes from fixtures/verify-skills/make_docx_fixtures.py. The expected
// lines for the tracked changes are what the pre-port Python script prints for it
// (git show 0f10db9:harness/skills/evidence-docx/scripts/docx_changes.py).
describe("docx_changes keeps document order", () => {
  const lines = run("docx_changes.ts", "changes.docx");

  test("insertions and deletions come out in document order, text intact", () => {
    expect(lines.slice(0, 6)).toEqual([
      'DEL [Ann, 2026-01-01T00:00:00Z] "old"',
      'INS [Bob, 2026-01-02T00:00:00Z] "new"',
      'DEL [Cy, 2026-01-03T00:00:00Z] "gone"',
      // spaces between runs and a purely numeric run survive
      'INS [Dee, 2026-01-04T00:00:00Z] "Total 42 units"',
      // a comment range inside the insertion does not split or reorder its text
      'INS [Eve, 2026-01-05T00:00:00Z] "xyz"',
      "# 5 tracked changes",
    ]);
  });

  test("a comment range between two runs anchors only the runs inside it", () => {
    expect(lines).toContain('COMMENT 0 [Fay, 2026-02-01T00:00:00Z] on "anchored": "first"');
    expect(lines).toContain('COMMENT 3 [Ivy, 2026-02-04T00:00:00Z] on "y": "fourth"');
  });

  test("overlapping comment ranges each anchor their own span", () => {
    // 1 covers "one two", 2 covers "two three"; the Python script tracked one range at a time.
    expect(lines).toContain('COMMENT 1 [Gus, 2026-02-02T00:00:00Z] on "one two": "second"');
    expect(lines).toContain('COMMENT 2 [Hal, 2026-02-03T00:00:00Z] on "two three": "third"');
    expect(lines.at(-1)).toBe("# 4 comments");
  });
});

// view.docx comes from make_docx_view_fixture.py. The two expected files are what the pre-port
// script (0f10db9:.../docx_text.py, python-docx 1.2.0) printed for it, run from the fixtures
// directory so that the header names the file as "view.docx".
describe("docx_text reads a document as python-docx does", () => {
  const normalize = (s: string) => s.replace(/\r\n/g, "\n");
  const textCli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [join(SCRIPTS, "docx_text.ts"), "view.docx", ...args], {
      encoding: "utf-8",
      cwd: FIXTURES,
    });
    expect(r.status).toBe(0);
    return normalize(r.stdout);
  };
  const expected = (name: string) => normalize(readFileSync(join(FIXTURES, name), "utf8"));

  test("paragraphs: styles by name, numeric runs, spaces between runs, tabs, breaks, links", () => {
    expect(textCli()).toBe(expected("view.docx-text.expected.txt"));
  });

  test("--tables dumps every grid cell, a merged cell repeating its text", () => {
    expect(textCli("--tables")).toBe(expected("view.docx-text-tables.expected.txt"));
  });
});
