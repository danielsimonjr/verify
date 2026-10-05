import { describe, expect, test } from "bun:test";

import { shapeNodes } from "../harness/skills/_shared/pptx.ts";
import { attr, findAll, ownText, parseOrdered, rootOf, tagOf } from "../harness/skills/_shared/xml.ts";

// Real Office parts are not tidy: Word writes a UTF-8 byte-order mark before the XML
// declaration, and a long document holds thousands of `&amp;`-style references.
describe("parseOrdered and rootOf on real-world parts", () => {
  test("a byte-order mark before the declaration does not become the root", () => {
    const bom = String.fromCharCode(0xfeff);
    const root = rootOf(parseOrdered(`${bom}<?xml version="1.0" encoding="utf-8"?><w:document><w:body/></w:document>`));
    expect(root && tagOf(root)).toBe("w:document");
  });

  test("a part with more than a thousand entity references parses, text intact", () => {
    // fast-xml-parser counts every `&quot;`, `&lt;`, `&gt;` and `&apos;` against a default cap of 1000
    const root = rootOf(parseOrdered(`<w:t>${"&quot;".repeat(1500)}&lt;&amp;</w:t>`));
    expect(root && ownText(root)).toBe(`${'"'.repeat(1500)}<&`);
  });

  test("a comment or a processing instruction before the root is not the root", () => {
    const root = rootOf(parseOrdered(`<?xml version="1.0"?><!-- note --><p:sld><p:cSld/></p:sld>`));
    expect(root && tagOf(root)).toBe("p:sld");
  });
});

// A part may bind a standard namespace to any prefix, or to the default namespace. Readers match the
// conventional prefix (`w:p`, `p:sldId`, `a:t`, `r:id`), so parsing maps each standard namespace to it.
describe("parseOrdered maps standard namespaces to their conventional prefixes", () => {
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

  test("a Word part with another prefix reads as w:", () => {
    const root = rootOf(parseOrdered(`<x:document xmlns:x="${W}"><x:body><x:p><x:r><x:t>hi</x:t></x:r></x:p></x:body></x:document>`));
    expect(root && tagOf(root)).toBe("w:document");
    const t = findAll(root, "w:t")[0];
    expect(t && ownText(t)).toBe("hi");
  });

  test("a default namespace gets the conventional prefix", () => {
    const root = rootOf(parseOrdered(`<document xmlns="${W}"><body><p/></body></document>`));
    expect(root && tagOf(root)).toBe("w:document");
    expect(findAll(root, "w:p")).toHaveLength(1);
  });

  test("an attribute in a standard namespace is renamed too, and a plain attribute is not", () => {
    const root = rootOf(parseOrdered(`<sldId xmlns:q="${R}" q:id="rId2" id="256" xmlns="http://schemas.openxmlformats.org/presentationml/2006/main"/>`));
    expect(root && tagOf(root)).toBe("p:sldId");
    expect(root && attr(root, "r:id")).toBe("rId2");
    expect(root && attr(root, "id")).toBe("256");
  });

  test("the spreadsheet and package-relationship namespaces stay unprefixed", () => {
    const ss = rootOf(parseOrdered(`<s:workbook xmlns:s="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>`));
    expect(ss && tagOf(ss)).toBe("workbook");
    const rels = rootOf(parseOrdered(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="a"/></Relationships>`));
    expect(rels && tagOf(rels)).toBe("Relationships");
  });

  test("markup compatibility under another prefix is read as mc:, and shapeNodes follows it", () => {
    const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
    const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
    const root = rootOf(
      parseOrdered(
        `<p:spTree xmlns:p="${P}" xmlns:m="${MC}"><m:AlternateContent><m:Choice Requires="x"><p:sp/></m:Choice><m:Fallback><p:pic/></m:Fallback></m:AlternateContent></p:spTree>`,
      ),
    );
    expect(shapeNodes(root).map(tagOf)).toEqual(["p:sp"]);
  });

  test("a non-standard URI bound to mc is not taken for markup compatibility", () => {
    const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
    const root = rootOf(
      parseOrdered(`<p:spTree xmlns:p="${P}" xmlns:mc="urn:other"><mc:AlternateContent><mc:Choice><p:sp/></mc:Choice></mc:AlternateContent></p:spTree>`),
    );
    expect(shapeNodes(root)).toEqual([]);
  });

  test("a namespace URI that names an Object.prototype member is not a standard namespace", () => {
    for (const uri of ["constructor", "__proto__", "toString"]) {
      const root = rootOf(parseOrdered(`<x:p xmlns:x="${uri}"/>`));
      expect(root && tagOf(root)).toBe("x:p");
    }
  });

  test("an inner redeclaration wins inside its element only", () => {
    const root = rootOf(parseOrdered(`<w:document xmlns:w="${W}"><w:body xmlns:w="urn:other"><w:p/></w:body><w:p/></w:document>`));
    expect(findAll(root, "w:p")).toHaveLength(1);
    expect(findAll(root, "w:body")).toHaveLength(0);
  });
});
