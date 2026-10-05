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

import { renameSync } from "node:fs";
import { parseArgs } from "node:util";
import { basename, join } from "node:path";
import { ensureDir } from "../../_shared/dirs.js";
import { loadPdf } from "../../_shared/pdf.js";
import { rasterizePages, renderRoot } from "../../_shared/raster.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    dpi: { type: "string", default: "150" },
    crop: { type: "string" },
  },
});
const file = positionals[0];
const pageNo = parseInt(positionals[1] ?? "", 10);
const dpi = parseInt(values.dpi ?? "150", 10);
const crop = values.crop;
const box = crop ? crop.split(",").map((v) => parseFloat(v)) : null;

if (!file || !pageNo || !(dpi > 0) || (box && (box.length !== 4 || box.some((v) => !isFinite(v))))) {
  console.error("usage: pdf_render.js FILE PAGE [--dpi 150] [--crop x0,y0,x1,y1]");
  process.exit(2);
}

const pdf = await loadPdf(file);
if (pageNo < 1 || pageNo > pdf.numPages) {
  console.error(`page ${pageNo} out of range 1..${pdf.numPages}`);
  process.exit(1);
}
const page = await pdf.getPage(pageNo);
const viewport = page.getViewport({ scale: 1 });
const suffix = box ? "_crop" : "";

const outDir = join(renderRoot(), "pdf_pages");
ensureDir(outDir);
const stem = basename(file).replace(/\.pdf$/i, "");
const name = `${stem}_p${pageNo}${suffix}`;
let rendered;
try {
  rendered = rasterizePages(file, outDir, name, {
    dpi,
    first: pageNo,
    last: pageNo,
    crop: box
      ? {
          box: box as [number, number, number, number],
          width: viewport.width,
          height: viewport.height,
        }
      : undefined,
  });
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const png = join(outDir, `${name}.png`);
renameSync(rendered[0]!.path, png);
let label = "n/a";
try {
  const labels = await pdf.getPageLabels();
  label = labels?.[pageNo - 1] ?? "n/a";
} catch {
  /* optional */
}
console.log(
  `${png}  (${pdf.numPages} pages in document; page label: ${label || "n/a"})`,
);
