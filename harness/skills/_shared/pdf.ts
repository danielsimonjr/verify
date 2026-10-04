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
const require = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = require.resolve(
  "pdfjs-dist/legacy/build/pdf.worker.mjs",
);

export async function loadPdf(path: string) {
  const data = new Uint8Array(readFileSync(path));
  return getDocument({ data, useSystemFonts: true }).promise;
}

export type Word = { top: number; x0: number; x1: number; text: string };

/** Group pdf.js text items into words (approximates pdfplumber extract_words). */
export async function extractWords(page: PDFPageProxy): Promise<Word[]> {
  const content = await page.getTextContent();
  const words: Word[] = [];
  for (const item of content.items) {
    if (!("str" in item) || !item.str?.trim()) continue;
    const [, , , , x, y] = item.transform;
    const w = item.width ?? item.str.length * 5;
    words.push({ top: y, x0: x, x1: x + w, text: item.str });
  }
  words.sort((a, b) => Math.round(a.top / 3) - Math.round(b.top / 3) || a.x0 - b.x0);
  return words;
}
