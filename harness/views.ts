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
import JSZip from "jszip";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { exists, isSymlink, writeText } from "./fsutil.js";
import { renderCellsTsv } from "./materialize/renderers.js";
import {
  docxParagraphText,
  isHeadingStyle,
  paragraphStyles,
  styleNameOf,
  tableRows,
} from "./skills/_shared/docx.js";
import { readPart } from "./skills/_shared/opc.js";
import {
  frameText,
  notesText,
  paragraphText,
  shapeNodes,
  slidesInOrder,
} from "./skills/_shared/pptx.js";
import { pyStrip } from "./skills/_shared/pytext.js";
import {
  type XNode,
  child,
  childrenNamed,
  childrenOf,
  descend,
  tagOf,
} from "./skills/_shared/xml.js";

export const VIEW_SUFFIXES = [".cells.tsv", ".text.txt"] as const;
export const INSTRUMENT_SUFFIXES = [".pre-recalc.xlsx", ".recalc.xlsx"] as const;
export const TEXT_VIEW_CAP = 400_000;

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

async function docxText(path: string): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const body = descend(await readPart(zip, "word/document.xml"), "w:body");
  if (!body) return "";
  const styles = await paragraphStyles(zip);
  const lines: string[] = [];
  for (const block of childrenOf(body)) {
    const tag = tagOf(block);
    if (tag === "w:p") {
      const text = pyStrip(docxParagraphText(block));
      if (text) lines.push((isHeadingStyle(styleNameOf(block, styles)) ? "# " : "") + text);
    } else if (tag === "w:tbl") {
      for (const row of tableRows(block)) {
        lines.push(row.map((t) => pyStrip(t).replace(/\n/g, " ")).join(" | "));
      }
    }
  }
  return lines.join("\n");
}

/** The text lines of the shapes in `container`, in z-order; groups are entered. */
function shapeText(container: XNode | undefined, lines: string[]): void {
  for (const sh of shapeNodes(container)) {
    const tag = tagOf(sh);
    if (tag === "p:sp") {
      for (const p of childrenNamed(child(sh, "p:txBody"), "a:p")) {
        const text = pyStrip(paragraphText(p));
        if (text) lines.push(text);
      }
    } else if (tag === "p:grpSp") {
      shapeText(sh, lines);
    } else if (tag === "p:graphicFrame") {
      const tbl = descend(sh, "a:graphic", "a:graphicData", "a:tbl");
      for (const row of childrenNamed(tbl, "a:tr")) {
        const cells = childrenNamed(row, "a:tc").map((tc) => pyStrip(frameText(child(tc, "a:txBody"))));
        lines.push(cells.join(" | "));
      }
    }
  }
}

async function pptxText(path: string): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const lines: string[] = [];
  for (const slide of await slidesInOrder(zip)) {
    lines.push(`# slide ${slide.number}`);
    shapeText(descend(await readPart(zip, slide.path), "p:cSld", "p:spTree"), lines);
    const notes = await notesText(zip, slide.path);
    if (notes) lines.push(`[notes] ${notes}`);
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
