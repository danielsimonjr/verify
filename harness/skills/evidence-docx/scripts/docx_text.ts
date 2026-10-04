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

const W =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
});

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { tables: { type: "boolean", default: false } },
});
const file = positionals[0];
if (!file) {
  console.error("usage: docx_text.py FILE [--tables]");
  process.exit(2);
}

const zip = await JSZip.loadAsync(readFileSync(file));
const docXml = await zip.file("word/document.xml")!.async("string");
const doc = parser.parse(docXml);

function local(el: unknown): string {
  if (!el || typeof el !== "object") return "";
  const o = el as Record<string, unknown>;
  return String(o["w:tag"] ?? o.tag ?? "");
}

function textOfPara(p: unknown): string {
  if (!p || typeof p !== "object") return "";
  const o = p as Record<string, unknown>;
  const runs = o.r ?? o["w:r"];
  const arr = Array.isArray(runs) ? runs : runs ? [runs] : [];
  let t = "";
  for (const r of arr) {
    if (!r || typeof r !== "object") continue;
    const ro = r as Record<string, unknown>;
    const ts = ro.t ?? ro["w:t"];
    if (typeof ts === "string") t += ts;
    else if (ts && typeof ts === "object" && "#text" in (ts as object)) {
      t += String((ts as { "#text": string })["#text"]);
    }
  }
  return t;
}

function styleOfPara(p: unknown): string {
  if (!p || typeof p !== "object") return "Normal";
  const o = p as Record<string, unknown>;
  const pPr = o.pPr ?? o["w:pPr"];
  if (!pPr || typeof pPr !== "object") return "Normal";
  const pPro = pPr as Record<string, unknown>;
  const ps = pPro.pStyle ?? pPro["w:pStyle"];
  if (!ps || typeof ps !== "object") return "Normal";
  return String((ps as { "@_w:val": string; "@_val": string })["@_w:val"] ??
    (ps as { "@_val": string })["@_val"] ??
    "Normal");
}

function walkBody(body: unknown): { paragraphs: unknown[]; tables: unknown[] } {
  if (!body || typeof body !== "object") return { paragraphs: [], tables: [] };
  const o = body as Record<string, unknown>;
  const ps = o.p ?? o["w:p"];
  const ts = o.tbl ?? o["w:tbl"];
  return {
    paragraphs: Array.isArray(ps) ? ps : ps ? [ps] : [],
    tables: Array.isArray(ts) ? ts : ts ? [ts] : [],
  };
}

const body = doc?.document?.body ?? doc?.["w:document"]?.["w:body"];
const { paragraphs, tables } = walkBody(body);

let inlineImages = 0;
const docStr = docXml;
inlineImages = (docStr.match(/<w:drawing/g) ?? []).length;

const sections = (docStr.match(/<w:sectPr/g) ?? []).length || 1;

console.log(
  `# ${file}: ${paragraphs.length} paragraphs, ${tables.length} tables, ${sections} sections, ${inlineImages} inline images`,
);

for (const p of paragraphs) {
  const text = textOfPara(p);
  if (text.trim()) console.log(`[${styleOfPara(p)}] ${text}`);
}

if (values.tables) {
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    const rows = (t as Record<string, unknown>).tr ??
      (t as Record<string, unknown>)["w:tr"];
    const rowArr = Array.isArray(rows) ? rows : rows ? [rows] : [];
    let ncols = 0;
    const rowTexts: string[][] = [];
    for (const row of rowArr) {
      const cells = (row as Record<string, unknown>).tc ??
        (row as Record<string, unknown>)["w:tc"];
      const cellArr = Array.isArray(cells) ? cells : cells ? [cells] : [];
      ncols = Math.max(ncols, cellArr.length);
      const line: string[] = [];
      for (const cell of cellArr) {
        const paras = (cell as Record<string, unknown>).p ??
          (cell as Record<string, unknown>)["w:p"];
        const parr = Array.isArray(paras) ? paras : paras ? [paras] : [];
        const ct = parr.map((pp) => textOfPara(pp)).join(" ");
        line.push(ct.replace(/\n/g, " ").trim());
      }
      rowTexts.push(line);
    }
    console.log(`\n## table ${i + 1} (${rowArr.length} rows x ${ncols} cols)`);
    for (const line of rowTexts) console.log(line.join("\t"));
  }
}
