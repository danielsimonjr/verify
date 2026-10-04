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

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  isArray: (n) =>
    ["sp", "grpSp", "pic", "graphicFrame", "p", "r", "tr", "tc"].includes(n),
});

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    slides: { type: "string" },
    "no-notes": { type: "boolean", default: false },
  },
});
const file = positionals[0];
if (!file) {
  console.error("usage: pptx_text.py FILE [--slides 3,5-7] [--no-notes]");
  process.exit(2);
}

function want(i: number): boolean {
  const spec = values.slides;
  if (!spec) return true;
  for (const part of spec.split(",")) {
    if (part.includes("-")) {
      const [lo, hi] = part.split("-").map((x) => parseInt(x, 10));
      if (i >= lo && i <= hi) return true;
    } else if (parseInt(part, 10) === i) return true;
  }
  return false;
}

function textFromTxBody(tx: unknown): string {
  if (!tx || typeof tx !== "object") return "";
  const ps = (tx as Record<string, unknown>).p ?? [];
  const parr = Array.isArray(ps) ? ps : [ps];
  const lines: string[] = [];
  for (const p of parr) {
    if (!p || typeof p !== "object") continue;
    const rs = (p as Record<string, unknown>).r ?? [];
    const rarr = Array.isArray(rs) ? rs : [rs];
    let line = "";
    for (const r of rarr) {
      if (!r || typeof r !== "object") continue;
      const t = (r as Record<string, unknown>).t;
      if (typeof t === "string") line += t;
      else if (t && typeof t === "object" && "#text" in t)
        line += String((t as { "#text": string })["#text"]);
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function shapeName(sp: Record<string, unknown>): string {
  const nv = sp.nvSpPr ?? sp.nvPicPr ?? sp.nvGraphicFramePr;
  if (!nv || typeof nv !== "object") return "shape";
  const cNv = (nv as Record<string, unknown>).cNvPr;
  if (cNv && typeof cNv === "object")
    return String((cNv as Record<string, string>)["@_name"] ?? "shape");
  return "shape";
}

function walkShapes(
  shapes: unknown,
  depth: number,
  lines: (s: string) => void,
) {
  const pad = "  ".repeat(depth);
  const arr = Array.isArray(shapes) ? shapes : shapes ? [shapes] : [];
  for (const sh of arr) {
    if (!sh || typeof sh !== "object") continue;
    const o = sh as Record<string, unknown>;
    const sp = (o.sp ?? o) as Record<string, unknown>;
    const name = shapeName(sp);
    try {
      if (o.grpSp) {
        const g = o.grpSp as Record<string, unknown>;
        lines(`${pad}[group ${name}]`);
        const tree = g.spTree as Record<string, unknown> | undefined;
        if (tree) {
          const kids: unknown[] = [];
          for (const key of ["sp", "grpSp", "pic", "graphicFrame"]) {
            const v = tree[key];
            if (Array.isArray(v)) kids.push(...v);
            else if (v) kids.push(v);
          }
          walkShapes(kids, depth + 1, lines);
        }
        continue;
      }
      if (o.graphicFrame || sp.graphicFrame) {
        const gf = (o.graphicFrame ?? sp.graphicFrame) as Record<string, unknown>;
        const uri = (gf.graphic as Record<string, unknown>)?.graphicData as Record<
          string,
          unknown
        >;
        if (uri?.tbl) {
          const tbl = uri.tbl as Record<string, unknown>;
          const trs = tbl.tr ?? [];
          const rowArr = Array.isArray(trs) ? trs : [trs];
          lines(
            `${pad}[table ${name}: ${rowArr.length} rows x ? cols]`,
          );
          for (const row of rowArr) {
            const tcs = (row as Record<string, unknown>).tc ?? [];
            const cells = Array.isArray(tcs) ? tcs : [tcs];
            const texts = cells.map((cell) => {
              const tx = (cell as Record<string, unknown>).txBody;
              return textFromTxBody(tx).replace(/\n/g, " ").trim();
            });
            lines(pad + "  " + texts.join("\t"));
          }
          continue;
        }
        if (uri?.chart) {
          lines(
            `${pad}[chart ${name}: type=chart categories=[]]`,
          );
          continue;
        }
      }
      if (sp.txBody) {
        const txt = textFromTxBody(sp.txBody).trim();
        const ph = sp.nvSpPr ? " placeholder" : "";
        if (txt) {
          lines(`${pad}[text ${name}${ph}]`);
          for (const l of txt.split("\n")) lines(pad + "  " + l);
        } else lines(`${pad}[text ${name}${ph}: empty]`);
        continue;
      }
      if (o.pic || sp.pic) {
        lines(
          `${pad}[picture ${name}: ?x? in — content not readable as text; render the slide]`,
        );
        continue;
      }
      lines(`${pad}[shape ${name}: type=unknown, no text]`);
    } catch (e) {
      lines(
        `${pad}[shape ${name}: UNREADABLE (${(e as Error).name}: ${(e as Error).message}) — render the slide to see it]`,
      );
    }
  }
}

const zip = await JSZip.loadAsync(readFileSync(file));
const slideFiles = Object.keys(zip.files)
  .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
  .sort((a, b) => parseInt(a.match(/(\d+)/)![1], 10) - parseInt(b.match(/(\d+)/)![1], 10));

const layoutNames = new Map<number, string>();
for (let i = 0; i < slideFiles.length; i++) {
  const xml = await zip.file(slideFiles[i])!.async("string");
  const m = xml.match(/<p:csld[^>]*name="([^"]+)"/);
  layoutNames.set(i + 1, m?.[1] ?? "slide");
}

const out: string[] = [];
const emit = (s: string) => out.push(s);

for (let i = 0; i < slideFiles.length; i++) {
  const slideNum = i + 1;
  if (!want(slideNum)) continue;
  const xml = await zip.file(slideFiles[i])!.async("string");
  const parsed = parser.parse(xml);
  const sld = parsed.sld ?? parsed;
  const spTree = sld?.cSld?.spTree ?? sld?.spTree;
  let title = "";
  const shapeList: unknown[] = [];
  if (spTree) {
    for (const key of ["sp", "grpSp", "pic", "graphicFrame"]) {
      const v = (spTree as Record<string, unknown>)[key];
      if (Array.isArray(v)) shapeList.push(...v);
      else if (v) shapeList.push(v);
    }
  }
  for (const sp of shapeList) {
    const ph = (sp as Record<string, unknown>).nvSpPr as Record<string, unknown>;
    const nv = ph?.nvPr as Record<string, unknown>;
    const phEl = nv?.ph as Record<string, string>;
    if (phEl?.["@_type"] === "title" || phEl?.["@_type"] === "ctrTitle") {
      title = textFromTxBody((sp as Record<string, unknown>).txBody).trim();
    }
  }
  const layout = layoutNames.get(slideNum) ?? "slide";
  emit(
    `=== slide ${slideNum} (layout: ${layout})${title ? " — " + title : ""}`,
  );
  walkShapes(shapeList, 0, emit);

  if (!values["no-notes"]) {
    const notesPath = `ppt/notesSlides/notesSlide${slideNum}.xml`;
    const notesFile = zip.file(notesPath);
    if (notesFile) {
      const nx = await notesFile.async("string");
      const np = parser.parse(nx);
      const nbody = np?.notes?.cSld?.spTree;
      let notes = "";
      if (nbody?.sp) {
        const nsp = Array.isArray(nbody.sp) ? nbody.sp : [nbody.sp];
        for (const s of nsp) {
          notes += textFromTxBody((s as Record<string, unknown>).txBody) + "\n";
        }
      }
      notes = notes.trim();
      if (notes) {
        emit("[notes]");
        for (const l of notes.split("\n")) emit("  " + l);
      }
    }
  }
  emit("");
}

console.log(out.join("\n"));
console.log(`# ${slideFiles.length} slides total`);
