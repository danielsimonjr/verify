import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Child-process tests: Bun's 5 s default timed one out at 5.1 s on a loaded host.
setDefaultTimeout(30_000);

const FIXTURES = join(import.meta.dir, "fixtures", "verify-skills");
const DECK = join(FIXTURES, "deck.pptx");
const SCRIPT = join(import.meta.dir, "..", "harness", "skills", "evidence-pptx", "scripts", "pptx_text.ts");

// deck.pptx comes from fixtures/verify-skills/make_pptx_fixtures.py. Its slides are stored as
// slide1.xml = Alpha, slide2.xml = Beta, slide3.xml = Gamma but shown as Gamma, Alpha, Beta;
// notesSlide1.xml belongs to Gamma. Alpha interleaves text, table, text, group, chart,
// picture and text in that z-order.

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const textCli = (...args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, DECK, ...args], { encoding: "utf-8" });

describe("pptx_text", () => {
  test("matches what the pre-port python-pptx script printed for the same deck", () => {
    // deck.text-script.expected.txt is the output of 0f10db9:.../pptx_text.py on deck.pptx
    // (python-pptx 1.0.2), line endings normalised.
    const r = textCli();
    expect(r.status).toBe(0);
    expect(r.stdout.replace(/\r\n/g, "\n")).toBe(read(join(FIXTURES, "deck.text-script.expected.txt")));
  });

  test("slides come in presentation order, not file-name order", () => {
    const heads = textCli()
      .stdout.split(/\r?\n/)
      .filter((l) => l.startsWith("=== slide"));
    expect(heads).toEqual([
      "=== slide 1 (layout: Title Only) — Gamma",
      "=== slide 2 (layout: Title Only) — Alpha",
      "=== slide 3 (layout: Title and Content) — Beta",
    ]);
  });

  test("shapes keep deck order: text, table, text, group, chart, picture, text", () => {
    const alpha = textCli("--slides", "2").stdout.split(/\r?\n/);
    const marks = alpha.filter((l) => /^\[(text|table|group|chart|picture)/.test(l)).map((l) => l.split(" ")[0]);
    expect(marks).toEqual([
      "[text", // title
      "[text", // first
      "[table",
      "[text", // second
      "[group",
      "[chart",
      "[picture",
      "[text", // third
    ]);
  });

  test("a notes part belongs to the slide that points to it, whatever its file number", () => {
    // keyed by title: slide order and notes mapping were both wrong, and by index they cancel
    const blocks = new Map(
      textCli()
        .stdout.split("=== slide")
        .slice(1)
        .map((b) => [b.split("\n")[0]!.split("— ").pop()!.trim(), b] as const),
    );
    expect([...blocks.keys()].sort()).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(blocks.get("Gamma")).toContain("Notes for Gamma");
    expect(blocks.get("Gamma")).not.toContain("Notes for Alpha");
    expect(blocks.get("Alpha")).toContain("Notes for Alpha");
    expect(blocks.get("Alpha")).not.toContain("Notes for Gamma");
    expect(blocks.get("Beta")).not.toContain("[notes]");
  });

  test("--no-notes and --slides select what is printed", () => {
    const quiet = textCli("--no-notes").stdout;
    expect(quiet).not.toContain("[notes]");
    const two = textCli("--slides", "2-3").stdout;
    expect(two).not.toContain("Gamma");
    expect(two).toContain("=== slide 2");
    expect(two).toContain("# 3 slides total");
  });

  test("every chart kind, odd categories, picture sizes and merged tables read as python-pptx read them", () => {
    // charts.pptx comes from make_pptx_charts_fixture.py; charts.text-script.expected.txt is the
    // output of 0f10db9:.../pptx_text.py on it. It covers type names (stacked, markers, exploded,
    // 3-D), Python list quoting of categories, a missing value, exponent floats, the cap of 12
    // printed points, sizes that tie at one decimal (0.25 in prints 0.2) and a merged cell.
    const r = spawnSync(process.execPath, [SCRIPT, join(FIXTURES, "charts.pptx")], { encoding: "utf-8" });
    expect(r.status).toBe(0);
    expect(r.stdout.replace(/\r\n/g, "\n")).toBe(read(join(FIXTURES, "charts.text-script.expected.txt")));
  });

  test("a file that is not a presentation is reported instead of listed as zero slides", () => {
    const r = spawnSync(process.execPath, [SCRIPT, join(FIXTURES, "changes.docx")], { encoding: "utf-8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("not a PowerPoint file");
    expect(r.stdout).not.toContain("slides total");
  });

  test("numeric text, line breaks, charts, tables and empty shapes are all reported", () => {
    const out = textCli().stdout;
    expect(out).toContain("[text TextBox 2]\n  2024");
    expect(out).toContain("  line one\n  line two");
    expect(out).toContain("[chart Chart 9: type=COLUMN_CLUSTERED (51) categories=['Q1', 'Q2', 'Q3']]");
    expect(out).toContain("  series Sales: [10.0, 12.5, 9.0]");
    expect(out).toContain("[table Table 3: 2 rows x 2 cols]");
    expect(out).toContain("[picture Picture 10: 2.0x1.0 in");
    expect(out).toContain("[shape Connector 4: type=LINE (9), no text]");
    expect(out).toContain("[text Rectangle 5: empty]");
  });
});
