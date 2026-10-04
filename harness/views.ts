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

/** Pre-rendered plain-text siblings of binary artifacts. */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { exists, isSymlink, writeText } from "./fsutil.js";
import { renderCellsTsv } from "./materialize/renderers.js";

export const VIEW_SUFFIXES = [".cells.tsv", ".text.txt"] as const;
export const INSTRUMENT_SUFFIXES = [".pre-recalc.xlsx", ".recalc.xlsx"] as const;
export const TEXT_VIEW_CAP = 400_000;

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  preserveOrder: true,
});

export function isView(name: string): boolean {
  return (
    VIEW_SUFFIXES.some((s) => name.endsWith(s)) ||
    INSTRUMENT_SUFFIXES.some((s) => name.endsWith(s))
  );
}

function walkNoSymlinks(root: string, cb: (dir: string, files: string[]) => void): void {
  const walk = (dir: string) => {
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files: string[] = [];
    const subdirs: string[] = [];
    for (const ent of ents) {
      if (ent.isSymbolicLink()) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) subdirs.push(p);
      else if (ent.isFile()) files.push(ent.name);
    }
    cb(dir, files.sort());
    for (const sd of subdirs.sort()) walk(sd);
  };
  walk(root);
}

type OrderedNode = { [key: string]: unknown };

function textFromRuns(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) {
    if (node.length && typeof node[0] === "object" && node[0] !== null && !Array.isArray(node[0])) {
      const parts: string[] = [];
      for (const item of node as OrderedNode[]) {
        const key = Object.keys(item)[0];
        if (key === "t" || key === "r") parts.push(textFromRuns(item[key]));
      }
      return parts.join("");
    }
    return node.map(textFromRuns).join("");
  }
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    if ("t" in o) return String(o.t ?? "");
    if ("r" in o) return textFromRuns(o.r);
    return Object.values(o).map(textFromRuns).join("");
  }
  return "";
}

async function docxText(path: string): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) return "";
  const doc = xml.parse(docXml) as OrderedNode[];
  const document = doc.find((n) => "document" in n)?.document as OrderedNode[];
  const body = document?.find((n) => "body" in n)?.body as OrderedNode[];
  if (!body) return "";
  const lines: string[] = [];
  for (const block of body) {
    const tag = Object.keys(block)[0];
    const content = block[tag];
    if (tag === "p") {
      const paras = Array.isArray(content) ? content : [content];
      let style = "";
      const texts: string[] = [];
      for (const el of paras as OrderedNode[]) {
        const k = Object.keys(el)[0];
        if (k === "pPr") {
          const pPr = el.pPr as OrderedNode[];
          const pStyle = pPr?.find((x) => "pStyle" in x)?.pStyle as OrderedNode[] | undefined;
          const val = pStyle?.[0]?.["@_val"];
          if (typeof val === "string") style = val;
        } else if (k === "r") {
          texts.push(textFromRuns(el.r));
        }
      }
      const text = texts.join("").trim();
      if (text) {
        const heading = style.startsWith("Heading") || style.startsWith("Title");
        lines.push((heading ? "# " : "") + text);
      }
    } else if (tag === "tbl") {
      const tbl = (Array.isArray(content) ? content : [content]) as OrderedNode[];
      const trNodes = tbl.flatMap((x) => {
        const k = Object.keys(x)[0];
        return k === "tr" ? (Array.isArray(x.tr) ? x.tr : [x.tr]) : [];
      });
      for (const tr of trNodes as OrderedNode[]) {
        const row = tr.tr ?? tr;
        const rowContent = Array.isArray(row) ? row : [row];
        const cells: string[] = [];
        for (const cellWrap of rowContent as OrderedNode[]) {
          const ck = Object.keys(cellWrap)[0];
          if (ck !== "tc") continue;
          const tc = cellWrap.tc as OrderedNode[];
          cells.push(textFromRuns(tc).trim().replace(/\n/g, " "));
        }
        if (cells.length) lines.push(cells.join(" | "));
      }
    }
  }
  return lines.join("\n");
}

async function pptxText(path: string): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const presXml = await zip.file("ppt/presentation.xml")?.async("string");
  if (!presXml) return "";
  const pres = xml.parse(presXml) as OrderedNode[];
  const presentation = pres.find((n) => "presentation" in n)?.presentation as OrderedNode[];
  const sldIdLst = presentation?.find((n) => "sldIdLst" in n)?.sldIdLst as OrderedNode[];
  const relsXml = (await zip.file("ppt/_rels/presentation.xml.rels")?.async("string")) ?? "";
  const rels = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" }).parse(
    relsXml,
  ) as Record<string, unknown>;
  const relArr = (rels.Relationships as Record<string, unknown>)?.Relationship;
  const relationships = Array.isArray(relArr) ? relArr : relArr ? [relArr] : [];
  const ridToTarget = new Map<string, string>();
  for (const r of relationships) {
    const rel = r as Record<string, string>;
    if (rel["@_Type"]?.includes("/slide")) {
      ridToTarget.set(rel["@_Id"], rel["@_Target"]!);
    }
  }
  const lines: string[] = [];
  let slideNum = 0;
  const sldIds = sldIdLst?.filter((n) => "sldId" in n).flatMap((n) => {
    const s = n.sldId;
    return Array.isArray(s) ? s : [s];
  }) ?? [];
  for (const sid of sldIds) {
    slideNum += 1;
    const attrs = (sid as OrderedNode[])[0] as Record<string, string>;
    const rid = attrs?.["@_r:id"] ?? attrs?.["@_id"];
    const target = ridToTarget.get(String(rid));
    if (!target) continue;
    const slidePath = target.startsWith("slides/") ? `ppt/${target}` : `ppt/slides/${target}`;
    const slideXml = await zip.file(slidePath)?.async("string");
    if (!slideXml) continue;
    lines.push(`# slide ${slideNum}`);
    const slide = xml.parse(slideXml) as OrderedNode[];
    const sld = slide.find((n) => "sld" in n)?.sld as OrderedNode[];
    const cSld = sld?.find((n) => "cSld" in n)?.cSld as OrderedNode[];
    const spTree = cSld?.find((n) => "spTree" in n)?.spTree as OrderedNode[];
    for (const node of spTree ?? []) {
      const tag = Object.keys(node)[0];
      if (tag === "sp") {
        const sp = node.sp as OrderedNode[];
        const txBody = sp?.find((x) => "txBody" in x)?.txBody;
        if (txBody) {
          const t = textFromRuns(txBody).trim();
          if (t) lines.push(t);
        }
      } else if (tag === "graphicFrame") {
        const t = textFromRuns(node.graphicFrame).trim();
        if (t.includes("|") || t) {
          const rows = t.split("\n").filter(Boolean);
          lines.push(...rows);
        }
      }
    }
  }
  return lines.join("\n");
}

async function pdfText(path: string): Promise<string> {
  const data = new Uint8Array(readFileSync(path));
  const doc = await getDocument({ data, useSystemFonts: true }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? String(item.str) : ""))
      .join(" ")
      .trim();
    parts.push(`# page ${i}\n${text}`);
  }
  return parts.join("\n");
}

const TEXT_RENDERERS: Record<string, (path: string) => string | Promise<string>> = {
  ".docx": docxText,
  ".pptx": pptxText,
  ".pdf": pdfText,
};

function staleCellsView(view: string): boolean {
  try {
    const first = readFileSync(view, "utf8").split("\n")[0] ?? "";
    return !first.startsWith("# sheets:");
  } catch {
    return true;
  }
}

function fileExtLower(fn: string): string {
  const low = fn.toLowerCase();
  const idx = low.lastIndexOf(".");
  return idx >= 0 ? low.slice(idx) : "";
}

export async function renderViews(root: string, refresh = false): Promise<number> {
  const pending: Promise<boolean>[] = [];

  walkNoSymlinks(root, (dirpath, files) => {
    for (const fn of files) {
      const p = join(dirpath, fn);
      if (isSymlink(p) || isView(fn)) continue;
      const ext = fileExtLower(fn);
      if (ext === ".xlsx" || ext === ".xlsm") {
        const out = join(dirpath, `${fn}.cells.tsv`);
        if (refresh || !exists(out) || staleCellsView(out)) {
          pending.push(renderCellsTsv(p, out));
        }
        continue;
      }
      const renderer = TEXT_RENDERERS[ext];
      if (!renderer) continue;
      const out = join(dirpath, `${fn}.text.txt`);
      if (exists(out)) continue;
      pending.push(
        Promise.resolve(renderer(p))
          .then((text) => {
            if (text.trim()) {
              writeText(out, text.slice(0, TEXT_VIEW_CAP));
              return true;
            }
            return false;
          })
          .catch(() => false),
      );
    }
  });

  const results = await Promise.all(pending);
  return results.filter(Boolean).length;
}
