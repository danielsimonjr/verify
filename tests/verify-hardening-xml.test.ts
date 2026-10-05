// fast-xml-parser 5.x (Dependabot alert #1): the parsers keep reading OOXML parts the way the 4.x
// ones did, and a long part is no longer cut short by the 4.x cap of 1000 entity references.
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { sheetNotes } from "../harness/materialize/renderers.ts";
import { ownText, parseOrdered, rootOf } from "../harness/skills/_shared/xml.ts";

async function workbookWithComment(commentsXml: string): Promise<Buffer> {
  const z = new JSZip();
  z.file(
    "xl/workbook.xml",
    '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  z.file(
    "xl/_rels/workbook.xml.rels",
    '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  z.file(
    "xl/worksheets/_rels/sheet1.xml.rels",
    '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/></Relationships>',
  );
  z.file("xl/comments1.xml", commentsXml);
  return z.generateAsync({ type: "nodebuffer" });
}

describe("sheetNotes on a comment part with many entity references", () => {
  // fast-xml-parser 4.x threw "Entity expansion limit exceeded: N > 1000" for the default parser, and
  // sheetNotes swallows a parse failure, so a long note silently vanished from the cells view.
  test("keeps a note that holds 1500 references", async () => {
    const note = `${"&quot;".repeat(1500)} end`;
    const buf = await workbookWithComment(
      `<comments><commentList><comment ref="A1"><text><t>${note}</t></text></comment></commentList></comments>`,
    );
    const notes = await sheetNotes(buf);
    expect(notes.get("S")?.get("A1")).toBe(`${"\"".repeat(1500)} end`);
  });
});

describe("parseOrdered keeps text exactly as written", () => {
  test("no trimming, no number or boolean coercion", () => {
    const root = rootOf(parseOrdered("<w:t> 007 </w:t>"));
    expect(root && ownText(root)).toBe(" 007 ");
    const flag = rootOf(parseOrdered("<w:t>true</w:t>"));
    expect(flag && ownText(flag)).toBe("true");
  });

  test("a part with 200000 references parses, text intact", () => {
    const root = rootOf(parseOrdered(`<w:t>${"&lt;".repeat(200_000)}</w:t>`));
    expect(root && ownText(root)).toBe("<".repeat(200_000));
  });
});
