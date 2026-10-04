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

import { parseArgs } from "node:util";
import { extractWords, loadPdf } from "../../_shared/pdf.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { grep: { type: "string" } },
});
const path = positionals[0];
const pageNo = parseInt(positionals[1] ?? "", 10);
const pat = values.grep ? new RegExp(values.grep) : null;

if (!path || !pageNo) {
  console.error("usage: pdf_words.py FILE PAGE [--grep REGEX]");
  process.exit(2);
}

const pdf = await loadPdf(path);
if (pageNo < 1 || pageNo > pdf.numPages) {
  console.error(`page ${pageNo} out of range 1..${pdf.numPages}`);
  process.exit(1);
}
const page = await pdf.getPage(pageNo);
const viewport = page.getViewport({ scale: 1 });
const words = await extractWords(page);
console.log(
  `# page ${pageNo} of ${pdf.numPages}  size ${viewport.width.toFixed(0)}x${viewport.height.toFixed(0)} pt  words ${words.length}`,
);
for (const w of words) {
  if (pat && !pat.test(w.text)) continue;
  console.log(
    `${w.top.toFixed(1).padStart(7)} ${w.x0.toFixed(1).padStart(7)} ${w.x1.toFixed(1).padStart(7)}  ${w.text}`,
  );
}
