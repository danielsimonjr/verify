// Copyright 2026 The VeriHarness Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Document-order XML for OOXML parts.
 *
 * The default fast-xml-parser object groups sibling tags by name, so `<w:r>` runs, a
 * `<w:commentRangeStart>` and a `<w:ins>` that were interleaved in the file come out as one
 * list per tag. The helpers here parse with `preserveOrder`, which keeps siblings in file
 * order, and keep text exactly as written (no trimming, no number or boolean coercion), as
 * Python's ElementTree did.
 */

import { XMLParser } from "fast-xml-parser";

/** One parsed node: a single tag key holding its children, plus optional `:@` attributes. */
export type XNode = Record<string, unknown>;

const ATTRS = ":@";
const TEXT = "#text";

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  // fast-xml-parser 4.x capped all `&quot;`, `&lt;`, `&gt;` and `&apos;` references in a part at 1000
  // by default, so a long document failed to parse at all; 5.x leaves the count unbounded. The option
  // stays explicit so a default that returns cannot break a long document. The caps that guard DTD
  // entity bombs (expanded length, nesting) stay at their defaults; Office parts carry no DTD.
  processEntities: { enabled: true, maxTotalExpansions: Infinity },
});

const BYTE_ORDER_MARK = 0xfeff;

/**
 * Conventional prefix for each standard OOXML namespace, in the Transitional and Strict forms. The
 * readers match these prefixes (`w:p`, `p:sldId`, `a:t`); the spreadsheet and package namespaces
 * are matched without one.
 */
// A Map: the keys are namespace URIs from the document, and a plain object would answer for
// "constructor" or "__proto__".
const CANONICAL_PREFIX = new Map<string, string>();
for (const [prefix, path] of [
  ["w", "wordprocessingml/2006/main"],
  ["p", "presentationml/2006/main"],
  ["a", "drawingml/2006/main"],
  ["r", "officeDocument/2006/relationships"],
  ["c", "drawingml/2006/chart"],
  ["wp", "drawingml/2006/wordprocessingDrawing"],
  ["pic", "drawingml/2006/picture"],
  ["", "spreadsheetml/2006/main"],
] as const) {
  CANONICAL_PREFIX.set(`http://schemas.openxmlformats.org/${path}`, prefix);
  CANONICAL_PREFIX.set(`http://purl.oclc.org/ooxml/${path.replace("/2006/", "/")}`, prefix);
}
CANONICAL_PREFIX.set("http://schemas.openxmlformats.org/package/2006/relationships", "");
CANONICAL_PREFIX.set("http://schemas.openxmlformats.org/package/2006/content-types", "");
CANONICAL_PREFIX.set("http://schemas.openxmlformats.org/markup-compatibility/2006", "mc");
const CANONICAL_PREFIXES = new Set([...CANONICAL_PREFIX.values()].filter((p) => p !== ""));

type NsScope = Map<string, string>;

/** `prefix:local` of a qualified name; `prefix` is "" for an unprefixed one. */
function splitQName(name: string): [string, string] {
  const i = name.indexOf(":");
  return i < 0 ? ["", name] : [name.slice(0, i), name.slice(i + 1)];
}

/**
 * The name a qualified name has once its namespace is resolved: the conventional prefix for a
 * standard namespace, the name as written for any other, and `{uri}local` for a name that holds a
 * conventional prefix but is bound elsewhere (so it never matches a reader). `isAttr`: an
 * unprefixed attribute is in no namespace, unlike an unprefixed element.
 */
function canonicalName(name: string, scope: NsScope, isAttr: boolean): string {
  const [prefix, local] = splitQName(name);
  if (prefix === "" && isAttr) return name;
  const uri = scope.get(prefix);
  if (uri === undefined) return name;
  const canon = CANONICAL_PREFIX.get(uri);
  if (canon !== undefined) return canon === "" ? local : `${canon}:${local}`;
  return prefix !== "" && CANONICAL_PREFIXES.has(prefix) ? `{${uri}}${local}` : name;
}

/** Rename every element and attribute of `nodes` by the namespace it is bound to. */
function canonicalize(nodes: XNode[], parent: NsScope): XNode[] {
  return nodes.map((node) => {
    const tag = tagOf(node);
    if (tag === TEXT || tag.startsWith("?") || tag.startsWith("#")) return node;
    const attrs = node[ATTRS] as Record<string, string> | undefined;
    let scope = parent;
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "@_xmlns" || k.startsWith("@_xmlns:")) {
          if (scope === parent) scope = new Map(parent);
          scope.set(k === "@_xmlns" ? "" : k.slice("@_xmlns:".length), v);
        }
      }
    }
    const out: XNode = { [canonicalName(tag, scope, false)]: canonicalize(childrenOf(node), scope) };
    if (attrs) {
      const renamed: Record<string, string> = {};
      for (const [k, v] of Object.entries(attrs)) {
        renamed[k.startsWith("@_xmlns") ? k : `@_${canonicalName(k.slice(2), scope, true)}`] = v;
      }
      out[ATTRS] = renamed;
    }
    return out;
  });
}

/**
 * Parse an XML part into top-level nodes in file order. A leading byte-order mark is dropped. A
 * standard OOXML namespace reads under its conventional prefix whatever prefix the part binds to it.
 */
export function parseOrdered(xml: string): XNode[] {
  const text = xml.charCodeAt(0) === BYTE_ORDER_MARK ? xml.slice(1) : xml;
  return canonicalize(parser.parse(text) as XNode[], new Map());
}

/** The element name of a node, or `#text` for a text node. */
export function tagOf(node: XNode): string {
  for (const k of Object.keys(node)) if (k !== ATTRS) return k;
  return "";
}

/** The attributes of a node (names keep the `@_` prefix the parser adds). */
export function attrsOf(node: XNode): Record<string, string> {
  return (node[ATTRS] as Record<string, string> | undefined) ?? {};
}

/** The value of one attribute, without the parser's `@_` prefix in the name asked for. */
export function attr(node: XNode, name: string): string | undefined {
  return attrsOf(node)[`@_${name}`];
}

/** The children of an element node, in file order (empty for a text node). */
export function childrenOf(node: XNode): XNode[] {
  const v = node[tagOf(node)];
  return Array.isArray(v) ? (v as XNode[]) : [];
}

/** The string of a `#text` node, or undefined when the node is an element. */
export function textOfNode(node: XNode): string | undefined {
  const v = node[TEXT];
  return v === undefined ? undefined : String(v);
}

/**
 * Visit every element under `nodes` in document order (parents before children).
 * Return `false` from `visit` to skip the element's children.
 */
export function walk(nodes: XNode[], visit: (node: XNode, tag: string) => boolean | void): void {
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === TEXT) continue;
    if (visit(node, tag) === false) continue;
    walk(childrenOf(node), visit);
  }
}

/** The text directly inside an element such as `w:t`, as written. */
export function ownText(node: XNode): string {
  return childrenOf(node)
    .map((c) => textOfNode(c) ?? "")
    .join("");
}

/** Concatenate the text of every descendant element named in `tags`, in document order. */
export function textIn(nodes: XNode[], tags: readonly string[]): string {
  const parts: string[] = [];
  walk(nodes, (n, tag) => {
    if (!tags.includes(tag)) return;
    parts.push(ownText(n));
    return false;
  });
  return parts.join("");
}

/** The root element of a parsed part: the first element, past the `<?xml ?>` declaration and any text. */
export function rootOf(nodes: XNode[]): XNode | undefined {
  return nodes.find((n) => {
    const tag = tagOf(n);
    return tag !== TEXT && !tag.startsWith("?");
  });
}

/** The first child element named `tag`. */
export function child(node: XNode | undefined, tag: string): XNode | undefined {
  return node ? childrenOf(node).find((c) => tagOf(c) === tag) : undefined;
}

/** Every child element named `tag`, in file order. */
export function childrenNamed(node: XNode | undefined, tag: string): XNode[] {
  return node ? childrenOf(node).filter((c) => tagOf(c) === tag) : [];
}

/** Follow `tags` down through the first matching child at each step. */
export function descend(node: XNode | undefined, ...tags: string[]): XNode | undefined {
  let cur = node;
  for (const tag of tags) cur = child(cur, tag);
  return cur;
}

/** Every descendant element named `tag`, in document order (the node itself is not included). */
export function findAll(node: XNode | undefined, tag: string): XNode[] {
  const found: XNode[] = [];
  if (node) {
    walk(childrenOf(node), (n, t) => {
      if (t === tag) found.push(n);
    });
  }
  return found;
}
