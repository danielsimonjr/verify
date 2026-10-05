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
 * Reading a .pptx package in document order: which slides there are and in what order, what
 * each slide's shapes and text are, and which notes part belongs to which slide.
 *
 * The pre-port scripts used python-pptx, which resolves all of this through the package's
 * relationships. Here slide order is the order of `p:sldIdLst` in presentation.xml, and
 * layouts, notes and charts are found through a slide's own relationships (see opc.ts).
 * Names carry their usual prefixes (`p:`, `a:`, `r:`, `c:`), as in every file PowerPoint,
 * LibreOffice and python-pptx write.
 */

import type JSZip from "jszip";

import { readPart, readRels, relatedPart } from "./opc.js";
import { pyStrip } from "./pytext.js";
import {
  type XNode,
  attr,
  child,
  childrenNamed,
  childrenOf,
  descend,
  tagOf,
  textIn,
} from "./xml.js";

export type SlideRef = { number: number; path: string };

/** Slides in presentation order. Falls back to file-name order for a package without one. */
export async function slidesInOrder(zip: JSZip): Promise<SlideRef[]> {
  const pres = await readPart(zip, "ppt/presentation.xml");
  const ordered: SlideRef[] = [];
  if (pres) {
    const rels = new Map((await readRels(zip, "ppt/presentation.xml")).map((r) => [r.id, r]));
    for (const id of childrenNamed(child(pres, "p:sldIdLst"), "p:sldId")) {
      const rel = rels.get(attr(id, "r:id") ?? "");
      if (rel && zip.file(rel.target)) ordered.push({ number: ordered.length + 1, path: rel.target });
    }
  }
  if (ordered.length) return ordered;
  return Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/(\d+)/)![1]!, 10) - parseInt(b.match(/(\d+)/)![1]!, 10))
    .map((path, i) => ({ number: i + 1, path }));
}

const SHAPE_TAGS = new Set(["p:sp", "p:grpSp", "p:graphicFrame", "p:cxnSp", "p:pic", "p:contentPart"]);

/**
 * The shapes directly inside a `p:spTree` or `p:grpSp`, in z-order (file order). Shapes
 * wrapped in `mc:AlternateContent` are taken from the `mc:Choice` that PowerPoint would
 * show (or the fallback when there is none), so they are not silently skipped.
 */
export function shapeNodes(container: XNode | undefined): XNode[] {
  const out: XNode[] = [];
  for (const n of container ? childrenOf(container) : []) {
    const tag = tagOf(n);
    if (SHAPE_TAGS.has(tag)) out.push(n);
    else if (tag === "mc:AlternateContent") {
      const branch = child(n, "mc:Choice") ?? child(n, "mc:Fallback");
      out.push(...shapeNodes(branch));
    }
  }
  return out;
}

/** The `p:nv*Pr` element that holds a shape's name and placeholder link. */
function nonVisual(shape: XNode): XNode | undefined {
  return childrenOf(shape).find((c) => /^p:nv\w+Pr$/.test(tagOf(c)));
}

export function shapeName(shape: XNode): string {
  return attr(child(nonVisual(shape), "p:cNvPr") ?? {}, "name") ?? "";
}

/** The `p:ph` element when the shape is a placeholder. */
export function placeholderOf(shape: XNode): XNode | undefined {
  return descend(nonVisual(shape), "p:nvPr", "p:ph");
}

/** Text of one `a:p`: its runs and fields in order, a line break as "\n". */
export function paragraphText(p: XNode): string {
  let out = "";
  for (const n of childrenOf(p)) {
    const tag = tagOf(n);
    if (tag === "a:r" || tag === "a:fld") out += textIn(childrenOf(n), ["a:t"]);
    else if (tag === "a:br") out += "\n";
  }
  return out;
}

/** Text of a text frame (`p:txBody` or `a:txBody`): its paragraphs joined by "\n". */
export function frameText(txBody: XNode | undefined): string {
  return childrenNamed(txBody, "a:p").map(paragraphText).join("\n");
}

/** Speaker notes of a slide: the text of its notes page's body placeholder ("" if none). */
export async function notesText(zip: JSZip, slidePath: string): Promise<string> {
  const notesPath = await relatedPart(zip, slidePath, "/notesSlide");
  if (!notesPath) return "";
  const root = await readPart(zip, notesPath);
  for (const shape of shapeNodes(descend(root, "p:cSld", "p:spTree"))) {
    if (tagOf(shape) === "p:sp" && attr(placeholderOf(shape) ?? {}, "type") === "body") {
      return pyStrip(frameText(child(shape, "p:txBody")));
    }
  }
  return "";
}

/** Name of the layout a slide uses ("" when it has none), as python-pptx's `slide_layout.name`. */
export async function layoutName(zip: JSZip, slidePath: string): Promise<string> {
  const layoutPath = await relatedPart(zip, slidePath, "/slideLayout");
  const root = layoutPath ? await readPart(zip, layoutPath) : undefined;
  return attr(child(root, "p:cSld") ?? {}, "name") ?? "";
}

/**
 * The slide's title shape, as python-pptx's `slides.shapes.title`: the first top-level
 * placeholder whose idx is 0 (a placeholder without an idx counts as 0), whatever its type.
 */
export function titleShape(spTree: XNode | undefined): XNode | undefined {
  return shapeNodes(spTree).find((s) => {
    const ph = placeholderOf(s);
    return ph !== undefined && (attr(ph, "idx") ?? "0") === "0";
  });
}
