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

import { copyFileSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { basename, extname, join, resolve } from "node:path";
import { sofficeToPdf } from "../../_shared/office.js";
import { rasterizePages, renderRoot } from "../../_shared/raster.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { dpi: { type: "string", default: "110" } },
});
const file = positionals[0];
const dpi = parseInt(values.dpi ?? "110", 10);
if (!file || !(dpi > 0)) {
  console.error("usage: xlsx_render.js FILE [--dpi 110]");
  process.exit(2);
}

const src = resolve(file);
const out = join(renderRoot(), "xlsx_render", basename(src, extname(src)));
mkdirSync(out, { recursive: true });
const copy = join(out, basename(src));
copyFileSync(src, copy);

const converted = sofficeToPdf(copy, out);
if ("error" in converted) {
  console.error(`LibreOffice conversion failed: ${converted.error}`);
  process.exit(1);
}

let pages;
try {
  pages = rasterizePages(converted.pdf, out, "page", { dpi });
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

console.log(`${pages.length} page(s) rendered from ${basename(src)}:`);
for (const p of pages) console.log(p.path);
