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
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFPageProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
// A file URL, not a path: Node's ESM loader rejects "C:\..." on Windows.
GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
).href;

export async function loadPdf(path: string) {
  const data = new Uint8Array(readFileSync(path));
  return getDocument({ data, useSystemFonts: true }).promise;
}

export type Word = { top: number; x0: number; x1: number; text: string };

// pdfminer (so pdfplumber) boxes a glyph run from baseline + descent up one em; pdf.js
// reports the same descent per font, and this is the fallback when it does not.
const DEFAULT_DESCENT = -0.207;

/**
 * Words with a top-left origin in the coordinates of the page as displayed.
 *
 * pdf.js text transforms are in PDF user space (origin bottom-left, y up, page /Rotate
 * ignored). The four corners of each run's box go through the page viewport, which
 * flips y and applies the rotation, so `top` grows downward and rotated pages read as
 * they look.
 */
export async function extractWords(page: PDFPageProxy): Promise<Word[]> {
  const content = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1 });
  const words: Word[] = [];
  for (const item of content.items) {
    if (!("str" in item) || !item.str?.trim()) continue;
    const [a, b, c, d, e, f] = item.transform;
    const width = item.width ?? item.str.length * 5;
    const descent = content.styles[item.fontName]?.descent ?? DEFAULT_DESCENT;
    const along = Math.hypot(a, b) || 1;
    const ux = (a / along) * width;
    const uy = (b / along) * width;
    // Box corners in user space: baseline-left + descent, then one em up and one run across.
    const blx = e + c * descent;
    const bly = f + d * descent;
    const corners = [
      [blx, bly],
      [blx + ux, bly + uy],
      [blx + c, bly + d],
      [blx + c + ux, bly + d + uy],
    ].map(([x, y]) => viewport.convertToViewportPoint(x, y));
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    words.push({
      top: Math.min(...ys),
      x0: Math.min(...xs),
      x1: Math.max(...xs),
      text: item.str,
    });
  }
  words.sort((a, b) => Math.round(a.top / 3) - Math.round(b.top / 3) || a.x0 - b.x0);
  return words;
}
