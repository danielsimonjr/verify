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

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: false,
  isArray: (name) =>
    ["w:r", "w:t", "w:ins", "w:del", "w:comment", "w:p"].includes(name),
});

const { positionals } = parseArgs({ allowPositionals: true });
const docx = positionals[0];
if (!docx) {
  console.error("usage: docx_changes.py FILE");
  process.exit(2);
}

const zip = await JSZip.loadAsync(readFileSync(docx));
const docXml = await zip.file("word/document.xml")!.async("string");
const doc = parser.parse(docXml);
const root = doc["w:document"]?.["w:body"] ?? doc;

function textOf(el: unknown): string {
  const parts: string[] = [];
  function walk(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    const o = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (k === "w:t" || k === "w:delText") {
        if (typeof v === "string") parts.push(v);
        else if (Array.isArray(v)) {
          for (const t of v) {
            if (typeof t === "string") parts.push(t);
            else if (t && typeof t === "object" && "#text" in t)
              parts.push(String((t as { "#text": string })["#text"]));
          }
        } else if (v && typeof v === "object" && "#text" in v) {
          parts.push(String((v as { "#text": string })["#text"]));
        }
      } else walk(v);
    }
  }
  walk(el);
  return parts.join("");
}

function walkInsDel(node: unknown, fn: (kind: string, el: Record<string, unknown>) => void) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const x of node) walkInsDel(x, fn);
    return;
  }
  const o = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    if (k === "w:ins" || k === "w:del") {
      const arr = Array.isArray(v) ? v : [v];
      for (const el of arr) {
        if (el && typeof el === "object")
          fn(k === "w:ins" ? "INS" : "DEL", el as Record<string, unknown>);
      }
    }
    walkInsDel(v, fn);
  }
}

let n = 0;
walkInsDel(root, (kind, el) => {
  const author = el["@_w:author"] ?? "";
  const date = el["@_w:date"] ?? "";
  console.log(`${kind} [${author}, ${date}] ${JSON.stringify(textOf(el))}`);
  n++;
});
console.log(`# ${n} tracked changes`);

const commentsFile = zip.file("word/comments.xml");
if (commentsFile) {
  const comXml = await commentsFile.async("string");
  const com = parser.parse(comXml);
  const anchors: Record<string, string[]> = {};
  let current: string | null = null;

  function walkAnchors(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const x of node) walkAnchors(x);
      return;
    }
    const o = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (k === "w:commentRangeStart") {
        const arr = Array.isArray(v) ? v : [v];
        for (const el of arr) {
          if (el && typeof el === "object") {
            current = String((el as Record<string, string>)["@_w:id"] ?? "");
            anchors[current] = [];
          }
        }
      } else if (k === "w:commentRangeEnd") {
        current = null;
      } else if (k === "w:t" && current != null) {
        const arr = Array.isArray(v) ? v : [v];
        for (const t of arr) {
          const txt =
            typeof t === "string"
              ? t
              : t && typeof t === "object" && "#text" in t
                ? String((t as { "#text": string })["#text"])
                : "";
          anchors[current].push(txt);
        }
      } else walkAnchors(v);
    }
  }
  walkAnchors(root);

  const comments =
    com["w:comments"]?.["w:comment"] ??
    com?.["w:comment"] ??
    [];
  const carr = Array.isArray(comments) ? comments : [comments];
  let m = 0;
  for (const c of carr) {
    if (!c || typeof c !== "object") continue;
    const co = c as Record<string, string>;
    const cid = co["@_w:id"] ?? "";
    const author = co["@_w:author"] ?? "";
    const date = co["@_w:date"] ?? "";
    const anchor = (anchors[cid] ?? []).join("");
    console.log(
      `COMMENT ${cid} [${author}, ${date}] on ${JSON.stringify(anchor)}: ${JSON.stringify(textOf(c))}`,
    );
    m++;
  }
  console.log(`# ${m} comments`);
} else {
  console.log("# 0 comments (no comments part)");
}
