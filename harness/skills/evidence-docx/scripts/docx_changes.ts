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
import {
  attr,
  childrenOf,
  ownText,
  parseOrdered,
  textIn,
  walk,
} from "../../_shared/xml.js";

const TEXT_TAGS = ["w:t", "w:delText"] as const;

const { positionals } = parseArgs({ allowPositionals: true });
const docx = positionals[0];
if (!docx) {
  console.error("usage: docx_changes.py FILE");
  process.exit(2);
}

const zip = await JSZip.loadAsync(readFileSync(docx));
const doc = parseOrdered(await zip.file("word/document.xml")!.async("string"));

// Tracked changes, in document order (a parent is printed before any change nested in it).
let n = 0;
walk(doc, (el, tag) => {
  if (tag !== "w:ins" && tag !== "w:del") return;
  const kind = tag === "w:ins" ? "INS" : "DEL";
  const author = attr(el, "w:author") ?? "";
  const date = attr(el, "w:date") ?? "";
  console.log(`${kind} [${author}, ${date}] ${JSON.stringify(textIn(childrenOf(el), TEXT_TAGS))}`);
  n++;
});
console.log(`# ${n} tracked changes`);

const commentsFile = zip.file("word/comments.xml");
if (commentsFile) {
  const com = parseOrdered(await commentsFile.async("string"));

  // Anchored text: every w:t between a comment's range start and end, in document order.
  // Ranges can overlap, so each text run goes to every range that is open at that point.
  const anchors = new Map<string, string[]>();
  const open = new Set<string>();
  walk(doc, (el, tag) => {
    if (tag === "w:commentRangeStart") {
      const id = attr(el, "w:id") ?? "";
      anchors.set(id, []);
      open.add(id);
    } else if (tag === "w:commentRangeEnd") {
      open.delete(attr(el, "w:id") ?? "");
    } else if (tag === "w:t" && open.size) {
      const text = ownText(el);
      for (const id of open) anchors.get(id)!.push(text);
      return false;
    }
  });

  let m = 0;
  walk(com, (c, tag) => {
    if (tag !== "w:comment") return;
    const cid = attr(c, "w:id") ?? "";
    const author = attr(c, "w:author") ?? "";
    const date = attr(c, "w:date") ?? "";
    const anchor = (anchors.get(cid) ?? []).join("");
    console.log(
      `COMMENT ${cid} [${author}, ${date}] on ${JSON.stringify(anchor)}: ${JSON.stringify(textIn(childrenOf(c), TEXT_TAGS))}`,
    );
    m++;
    return false;
  });
  console.log(`# ${m} comments`);
} else {
  console.log("# 0 comments (no comments part)");
}
