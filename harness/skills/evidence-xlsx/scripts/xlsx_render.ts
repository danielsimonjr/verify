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

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
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
  console.error("usage: xlsx_render.py FILE [--dpi 110]");
  process.exit(2);
}

const src = resolve(file);
const out = join("/tmp/xlsx_render", basename(src, ".xlsx"));
mkdirSync(out, { recursive: true });
const copy = join(out, basename(src));
copyFileSync(src, copy);

const env = { ...process.env, HOME: out };
const profile = join(out, "profile");
const r = spawnSync(
  "soffice",
  [
    `-env:UserInstallation=file://${profile}`,
    "--headless",
    "--convert-to",
    "pdf",
    "--outdir",
    out,
    copy,
  ],
  { encoding: "utf-8", timeout: 300_000, env },
);

const pdf = join(out, `${basename(src, ".xlsx")}.pdf`);
if (!existsSync(pdf)) {
  const msg = (r.stderr || r.stdout || "").trim().slice(-400);
  console.error(`LibreOffice conversion failed: ${msg}`);
  process.exit(1);
}

const ppm = spawnSync(
  "pdftoppm",
  ["-r", String(dpi), "-png", pdf, join(out, "page")],
  { stdio: "inherit" },
);
if (ppm.status !== 0) process.exit(ppm.status ?? 1);

const pages = readdirSync(out)
  .filter((f) => /^page-\d+\.png$/.test(f))
  .sort((a, b) => parseInt(a.split("-")[1]!, 10) - parseInt(b.split("-")[1]!, 10))
  .map((f) => join(out, f));

console.log(`${pages.length} page(s) rendered from ${basename(src)}:`);
for (const p of pages) console.log(p);
