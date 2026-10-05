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

import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { basename, extname, join, resolve } from "node:path";
import { ensureDir } from "../../_shared/dirs.js";
import { sofficeToPdf } from "../../_shared/office.js";
import { rasterizePages, renderRoot } from "../../_shared/raster.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { dpi: { type: "string", default: "110" } },
});
const file = positionals[0];
const dpi = parseInt(values.dpi ?? "110", 10);
if (!file || !(dpi > 0)) {
  console.error("usage: pptx_render.js FILE [--dpi 110]");
  process.exit(2);
}

function main(file: string): number {
  const src = resolve(file);
  const out = join(renderRoot(), "pptx_render", basename(src, extname(src)));
  ensureDir(out);
  // The conversion, its profile and its PDF live in a scratch directory that is removed
  // on the way out; only the slide images are kept.
  const td = mkdtempSync(join(tmpdir(), "pptx_render_"));
  try {
    const copy = join(td, basename(src));
    copyFileSync(src, copy);
    const converted = sofficeToPdf(copy, td);
    if ("error" in converted) {
      console.log("conversion failed:", converted.error.slice(-300));
      return 1;
    }
    let pages;
    try {
      pages = rasterizePages(converted.pdf, td, "slide", { dpi });
    } catch (e) {
      console.error((e as Error).message);
      return 1;
    }
    // A shorter deck must not leave the slides of an earlier render of the same name behind.
    for (const f of readdirSync(out)) if (/^slide-\d+\.png$/.test(f)) rmSync(join(out, f));
    for (const p of pages) {
      const dest = join(out, `slide-${String(p.page).padStart(2, "0")}.png`);
      copyFileSync(p.path, dest);
      console.log(dest);
    }
    console.log(`# ${pages.length} slides rendered`);
    return 0;
  } finally {
    rmSync(td, { recursive: true, force: true });
  }
}

process.exit(main(file));
