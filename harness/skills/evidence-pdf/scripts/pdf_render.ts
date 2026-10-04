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

import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadPdf } from "../../_shared/pdf.js";

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

if (!file || !pageNo) {
  console.error("usage: pdf_render.py FILE PAGE [--dpi 150] [--crop x0,y0,x1,y1]");
  process.exit(2);
}

const pdf = await loadPdf(file);
if (pageNo < 1 || pageNo > pdf.numPages) {
  console.error(`page ${pageNo} out of range 1..${pdf.numPages}`);
  process.exit(1);
}
const page = await pdf.getPage(pageNo);
const viewport = page.getViewport({ scale: 1 });
let suffix = "";
const args = [
  "-r",
  String(dpi),
  "-f",
  String(pageNo),
  "-l",
  String(pageNo),
  "-png",
  "-singlefile",
];
if (crop) {
  const [x0, y0, x1, y1] = crop.split(",").map((v) => parseFloat(v));
  const w = viewport.width;
  const h = viewport.height;
  const px = (dpi / 72) * w;
  const py = (dpi / 72) * h;
  args.push(
    "-x",
    String(Math.round(x0 * px)),
    "-y",
    String(Math.round(y0 * py)),
    "-W",
    String(Math.round((x1 - x0) * px)),
    "-H",
    String(Math.round((y1 - y0) * py)),
  );
  suffix = "_crop";
}

const outDir = "/tmp/pdf_pages";
mkdirSync(outDir, { recursive: true });
const stem = basename(file).replace(/\.pdf$/i, "");
const prefix = join(outDir, `${stem}_p${pageNo}${suffix}`);
const r = spawnSync("pdftoppm", [...args, file, prefix], { encoding: "utf-8" });
if (r.status !== 0) {
  console.error(r.stderr || r.stdout);
  process.exit(r.status ?? 1);
}
const png = `${prefix}.png`;
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
