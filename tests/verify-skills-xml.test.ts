import { describe, expect, test } from "bun:test";

import { ownText, parseOrdered, rootOf, tagOf } from "../harness/skills/_shared/xml.ts";

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
