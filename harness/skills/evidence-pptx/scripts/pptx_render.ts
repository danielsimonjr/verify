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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { dpi: { type: "string", default: "110" } },
});
const file = positionals[0];
const dpi = parseInt(values.dpi ?? "110", 10);
if (!file) {
  console.error("usage: pptx_render.py FILE [--dpi 110]");
  process.exit(2);
}

const src = resolve(file);
const out = join("/tmp/pptx_render", basename(src, ".pptx"));
mkdirSync(out, { recursive: true });
const td = mkdtempSync(join(tmpdir(), "pptx_render_"));
const copy = join(td, basename(src));
copyFileSync(src, copy);

const r = spawnSync(
  "soffice",
  [
    "--headless",
    `-env:UserInstallation=file://${join(td, "profile")}`,
    "--convert-to",
    "pdf",
    "--outdir",
    td,
    copy,
  ],
  { encoding: "utf-8", timeout: 300_000, env: { ...process.env, HOME: td } },
);

const pdf = join(td, `${basename(src, ".pptx")}.pdf`);
if (!existsSync(pdf)) {
  console.log("conversion failed:", (r.stderr || r.stdout || "").slice(-300));
  process.exit(1);
}

const ppm = spawnSync(
  "pdftoppm",
  ["-r", String(dpi), "-png", pdf, join(td, "slide")],
  { stdio: "inherit" },
);
if (ppm.status !== 0) process.exit(ppm.status ?? 1);

const raw = readdirSync(td)
  .filter((f) => /^slide-\d+\.png$/.test(f))
  .sort((a, b) => parseInt(a.split("-")[1]!, 10) - parseInt(b.split("-")[1]!, 10));

let count = 0;
for (const f of raw) {
  count++;
  const dest = join(out, `slide-${String(count).padStart(2, "0")}.png`);
  copyFileSync(join(td, f), dest);
  console.log(dest);
}
console.log(`# ${count} slides rendered`);
