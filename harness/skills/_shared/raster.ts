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
 * PDF pages to PNG, for the render skills.
 *
 * The task images guarantee Python with PyMuPDF (STACK in env/derive.ts), not Poppler, and
 * the pre-port scripts rasterized with PyMuPDF first and fell back to pdftoppm. Both paths
 * are kept: PyMuPDF through rasterize_pdf.py, pdftoppm directly. Which one runs is decided
 * by `chooseBackend`, whose probes are injectable so the choice is testable without either.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { findPython, sibling } from "./python.js";

/** A way to turn PDF pages into PNG files. */
export type Backend = { kind: "pymupdf"; python: string } | { kind: "pdftoppm" };

/** What the host has; injected so the choice of backend is testable without either tool. */
export type BackendProbes = {
  /** A Python that can import PyMuPDF, or null. */
  pymupdf: () => string | null;
  /** Whether pdftoppm runs. */
  pdftoppm: () => boolean;
};

/** The probes for this host: a Python that imports PyMuPDF, and a pdftoppm that runs. */
export const realProbes: BackendProbes = {
  pymupdf: () => findPython(["fitz"]),
  pdftoppm: () => spawnSync("pdftoppm", ["-v"], { stdio: "ignore" }).status === 0,
};

/** PyMuPDF when some Python has it (the pre-port order), else pdftoppm, else null. */
export function chooseBackend(probes: BackendProbes = realProbes): Backend | null {
  const python = probes.pymupdf();
  if (python) return { kind: "pymupdf", python };
  return probes.pdftoppm() ? { kind: "pdftoppm" } : null;
}

/** Resolution and page range of one render, and an optional crop of the first page's area. */
export type RasterOptions = {
  dpi: number;
  /** 1-based; default is the whole document. */
  first?: number;
  last?: number;
  /** `box` is x0,y0,x1,y1 as fractions of the page; width and height are the page size in pt. */
  crop?: { box: readonly [number, number, number, number]; width: number; height: number };
};

/** One rendered page: its 1-based number and the PNG written for it. */
export type RasterPage = { page: number; path: string };

/** Root directory of the render skills' output folders (default /tmp, as documented). */
export function renderRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.VERIHARNESS_RENDER_DIR || "/tmp";
}

/**
 * Render pages of `pdf` to `<outDir>/<prefix>-<page>.png` and return them in page order.
 * Existing `<prefix>-<n>.png` files in `outDir` are removed first, so the result lists
 * this run's pages only. Throws when no rasterizer is installed or the run fails.
 */
export function rasterizePages(
  pdf: string,
  outDir: string,
  prefix: string,
  opts: RasterOptions,
  probes: BackendProbes = realProbes,
): RasterPage[] {
  const backend = chooseBackend(probes);
  if (!backend) {
    throw new Error(
      "no PDF rasterizer found: install PyMuPDF for a Python on PATH (pip install pymupdf) " +
        "or Poppler's pdftoppm",
    );
  }
  const own = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)\\.png$`);
  for (const f of readdirSync(outDir)) if (own.test(f)) rmSync(join(outDir, f));

  const base = join(outDir, prefix);
  const r =
    backend.kind === "pymupdf"
      ? spawnSync(backend.python, pymupdfArgs(pdf, base, opts), { encoding: "utf-8" })
      : spawnSync("pdftoppm", pdftoppmArgs(pdf, base, opts), { encoding: "utf-8" });
  if (r.status !== 0) {
    const why = (r.stderr || r.stdout || r.error?.message || "").trim().slice(-400);
    throw new Error(`${backend.kind} failed${why ? `: ${why}` : ""}`);
  }

  const pages: RasterPage[] = [];
  for (const f of readdirSync(outDir)) {
    const m = own.exec(f);
    if (m) pages.push({ page: parseInt(m[1]!, 10), path: join(outDir, f) });
  }
  if (!pages.length) throw new Error(`${backend.kind} wrote no pages`);
  return pages.sort((a, b) => a.page - b.page);
}

function pymupdfArgs(pdf: string, base: string, o: RasterOptions): string[] {
  const args = [sibling(import.meta.url, "rasterize_pdf.py"), pdf, base, "--dpi", String(o.dpi)];
  if (o.first) args.push("--first", String(o.first));
  if (o.last) args.push("--last", String(o.last));
  if (o.crop) args.push("--clip", o.crop.box.join(","));
  return args;
}

function pdftoppmArgs(pdf: string, base: string, o: RasterOptions): string[] {
  const args = ["-r", String(o.dpi), "-png"];
  if (o.first) args.push("-f", String(o.first));
  if (o.last) args.push("-l", String(o.last));
  if (o.crop) {
    const [x0, y0, x1, y1] = o.crop.box;
    const px = (o.dpi / 72) * o.crop.width;
    const py = (o.dpi / 72) * o.crop.height;
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
  }
  args.push(pdf, base);
  return args;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
