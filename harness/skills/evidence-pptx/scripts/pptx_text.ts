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
 * Slide-by-slide contents of a .pptx: titles, text frames (in shape order), tables cell by
 * cell, charts, speaker notes, and an explicit line for every shape that could not be read.
 *
 *     node pptx_text.js FILE [--slides 3,5-7] [--no-notes]
 *
 * Slides come in presentation order and shapes in z-order, groups included. The lines are the
 * ones the python-pptx version of this script printed.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import JSZip from "jszip";
import { type Rel, readPart, readRels } from "../../_shared/opc.js";
import {
  frameText,
  layoutName,
  notesText,
  placeholderOf,
  shapeName,
  shapeNodes,
  slidesInOrder,
  titleShape,
} from "../../_shared/pptx.js";
import { pyStrip, splitLines } from "../../_shared/pytext.js";
import {
  type XNode,
  attr,
  child,
  childrenNamed,
  childrenOf,
  descend,
  findAll,
  ownText,
  tagOf,
} from "../../_shared/xml.js";

const TABLE_URI = "http://schemas.openxmlformats.org/drawingml/2006/table";
const CHART_URI = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const OLE_URI = "http://schemas.openxmlformats.org/presentationml/2006/ole";

const EMU_PER_INCH = 914400;
const PRINTED_VALUES = 12; // categories and series values past the twelfth are not printed

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    slides: { type: "string" },
    "no-notes": { type: "boolean", default: false },
  },
});
const file = positionals[0];
if (!file) {
  console.error("usage: pptx_text.js FILE [--slides 3,5-7] [--no-notes]");
  process.exit(2);
}

function want(i: number): boolean {
  const spec = values.slides;
  if (!spec) return true;
  for (const part of spec.split(",")) {
    if (part.includes("-")) {
      const [lo, hi] = part.split("-").map((x) => parseInt(x, 10));
      if (i >= lo && i <= hi) return true;
    } else if (parseInt(part, 10) === i) return true;
  }
  return false;
}

/** An error named as python-pptx named it, so "could not read" lines stay comparable. */
function fail(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

/** Python's repr() of a str. */
function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === "\\" || ch === quote) out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || (c >= 0x7f && c <= 0xa0)) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return quote + out + quote;
}

/** Python's repr() of a float. */
function pyFloat(n: number): string {
  if (Number.isNaN(n)) return "nan";
  if (!Number.isFinite(n)) return n > 0 ? "inf" : "-inf";
  if (n === 0) return Object.is(n, -0) ? "-0.0" : "0.0";
  const [mantissa, exponent] = n.toExponential().split("e");
  const exp = parseInt(exponent, 10);
  if (exp < -4 || exp >= 16) {
    return `${mantissa}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  const plain = String(n);
  return plain.includes(".") ? plain : `${plain}.0`;
}

function toFloat(text: string): number {
  const t = text.trim();
  const n = Number(t);
  if (t === "" || Number.isNaN(n)) throw fail("ValueError", `could not convert string to float: ${pyRepr(text)}`);
  return n;
}

const pyList = (items: string[]) => `[${items.join(", ")}]`;

// --- charts: what python-pptx's chart_type, categories and series report ----------------------

type XlType = [name: string, value: number];
const xl = ([name, value]: XlType) => `${name} (${value})`;

const BAR_TYPES: Record<string, XlType> = {
  clustered: ["BAR_CLUSTERED", 57],
  stacked: ["BAR_STACKED", 58],
  percentStacked: ["BAR_STACKED_100", 59],
};
const COLUMN_TYPES: Record<string, XlType> = {
  clustered: ["COLUMN_CLUSTERED", 51],
  stacked: ["COLUMN_STACKED", 52],
  percentStacked: ["COLUMN_STACKED_100", 53],
};
const LINE_TYPES: Record<string, XlType> = {
  standard: ["LINE", 4],
  stacked: ["LINE_STACKED", 63],
  percentStacked: ["LINE_STACKED_100", 64],
};
const LINE_MARKER_TYPES: Record<string, XlType> = {
  standard: ["LINE_MARKERS", 65],
  stacked: ["LINE_MARKERS_STACKED", 66],
  percentStacked: ["LINE_MARKERS_STACKED_100", 67],
};
const AREA_TYPES: Record<string, XlType> = {
  standard: ["AREA", 1],
  stacked: ["AREA_STACKED", 76],
  percentStacked: ["AREA_STACKED_100", 77],
};
const AREA_3D_TYPES: Record<string, XlType> = {
  standard: ["THREE_D_AREA", -4098],
  stacked: ["THREE_D_AREA_STACKED", 78],
  percentStacked: ["THREE_D_AREA_STACKED_100", 79],
};

const PLOT_TAGS = new Set([
  "c:areaChart",
  "c:area3DChart",
  "c:barChart",
  "c:bar3DChart",
  "c:bubbleChart",
  "c:doughnutChart",
  "c:line3DChart",
  "c:lineChart",
  "c:ofPieChart",
  "c:pie3DChart",
  "c:pieChart",
  "c:radarChart",
  "c:scatterChart",
  "c:stockChart",
  "c:surface3DChart",
  "c:surfaceChart",
]);
const READABLE_PLOTS = new Set([
  "c:areaChart",
  "c:area3DChart",
  "c:barChart",
  "c:bubbleChart",
  "c:doughnutChart",
  "c:lineChart",
  "c:pieChart",
  "c:radarChart",
  "c:scatterChart",
]);

function plotAt(plots: XNode[], i: number): XNode {
  const plot = plots[i];
  if (!plot) throw fail("IndexError", "list index out of range");
  if (!READABLE_PLOTS.has(tagOf(plot))) throw fail("ValueError", `unsupported plot type ${tagOf(plot)}`);
  return plot;
}

function byGrouping(table: Record<string, XlType>, plot: XNode, whenAbsent: string): string {
  const el = child(plot, "c:grouping");
  const grouping = el ? (attr(el, "val") ?? "standard") : whenAbsent;
  if (!Object.hasOwn(table, grouping)) throw fail("KeyError", pyRepr(grouping));
  return xl(table[grouping]);
}

/** True when the first series that sets a marker symbol sets it to "none". */
const firstSymbolIsNone = (sers: XNode[]) =>
  attr(sers.map((s) => descend(s, "c:marker", "c:symbol")).find((n) => n) ?? {}, "val") === "none";

function chartType(plot: XNode): string {
  const sers = childrenNamed(plot, "c:ser");
  switch (tagOf(plot)) {
    case "c:barChart": {
      const dir = attr(child(plot, "c:barDir") ?? {}, "val") ?? "col";
      if (dir === "bar") return byGrouping(BAR_TYPES, plot, "clustered");
      if (dir === "col") return byGrouping(COLUMN_TYPES, plot, "clustered");
      throw fail("ValueError", `invalid barChart.barDir value '${dir}'`);
    }
    case "c:lineChart": {
      const noMarkers = sers.some((s) => attr(descend(s, "c:marker", "c:symbol") ?? {}, "val") === "none");
      return byGrouping(noMarkers ? LINE_TYPES : LINE_MARKER_TYPES, plot, "standard");
    }
    case "c:areaChart":
      return byGrouping(AREA_TYPES, plot, "standard");
    case "c:area3DChart":
      return byGrouping(AREA_3D_TYPES, plot, "standard");
    case "c:pieChart":
      return sers.some((s) => child(s, "c:explosion")) ? xl(["PIE_EXPLODED", 69]) : xl(["PIE", 5]);
    case "c:doughnutChart":
      return sers.some((s) => child(s, "c:explosion")) ? xl(["DOUGHNUT_EXPLODED", 80]) : xl(["DOUGHNUT", -4120]);
    case "c:bubbleChart": {
      const flag = sers.map((s) => child(s, "c:bubble3D")).find((n) => n !== undefined);
      const on = flag !== undefined && ["1", "true"].includes(attr(flag, "val") ?? "true");
      return on ? xl(["BUBBLE_THREE_D_EFFECT", 87]) : xl(["BUBBLE", 15]);
    }
    case "c:radarChart": {
      const style = child(plot, "c:radarStyle");
      if (!style) throw fail("IndexError", "list index out of range");
      const val = attr(style, "val");
      if (val === undefined) return xl(["RADAR", -4151]);
      if (val === "filled") return xl(["RADAR_FILLED", 82]);
      return firstSymbolIsNone(sers) ? xl(["RADAR", -4151]) : xl(["RADAR_MARKERS", 81]);
    }
    case "c:scatterChart": {
      const style = child(plot, "c:scatterStyle");
      if (!style) throw fail("IndexError", "list index out of range");
      const noMarkers = firstSymbolIsNone(sers);
      if (attr(style, "val") === "lineMarker") {
        const noLine = sers.some((s) => descend(s, "c:spPr", "a:ln", "a:noFill"));
        if (noLine) return xl(["XY_SCATTER", -4169]);
        return noMarkers ? xl(["XY_SCATTER_LINES_NO_MARKERS", 75]) : xl(["XY_SCATTER_LINES", 74]);
      }
      if (attr(style, "val") === "smoothMarker") {
        return noMarkers ? xl(["XY_SCATTER_SMOOTH_NO_MARKERS", 73]) : xl(["XY_SCATTER_SMOOTH", 72]);
      }
      return xl(["XY_SCATTER", -4169]);
    }
  }
  throw fail("NotImplementedError", `chart_type() not implemented for ${tagOf(plot)}`);
}

/** Category labels of the plot's first series ("" for a category with no label). */
function categories(plot: XNode): string[] {
  const sers = childrenNamed(plot, "c:ser");
  const count = Number(
    attr(sers.map((s) => findAll(child(s, "c:cat"), "c:ptCount")[0]).find((n) => n) ?? {}, "val") ?? 0,
  );
  const cat = child(sers[0], "c:cat");
  const lvl = findAll(cat, "c:lvl")[0];
  let pts = lvl ? childrenNamed(lvl, "c:pt") : [];
  if (!pts.length) pts = findAll(cat, "c:pt");
  const byIdx = new Map(pts.map((pt) => [Number(attr(pt, "idx")), pt] as const));
  return Array.from({ length: Math.min(count, PRINTED_VALUES) }, (_, i) => {
    const pt = byIdx.get(i);
    return pt ? ownText(child(pt, "c:v") ?? {}) : "";
  });
}

function seriesName(ser: XNode): string {
  const names = findAll(child(ser, "c:tx"), "c:pt").map((pt) => ownText(child(pt, "c:v") ?? {}));
  return names.find((t) => t !== "") ?? "";
}

function seriesValues(plot: XNode, ser: XNode): (number | null)[] {
  const xy = tagOf(plot) === "c:scatterChart" || tagOf(plot) === "c:bubbleChart";
  const src = child(ser, xy ? "c:yVal" : "c:val");
  if (!src) return [];
  const count = Number(attr(findAll(src, "c:ptCount")[0] ?? {}, "val") ?? 0);
  const pts = findAll(src, "c:pt");
  return Array.from({ length: Math.min(count, PRINTED_VALUES) }, (_, idx) => {
    const pt = pts.find((p) => Number(attr(p, "idx")) === idx);
    return pt ? toFloat(ownText(child(pt, "c:v") ?? {})) : null;
  });
}

/** Series of a plot in c:order sequence (not document order), as python-pptx lists them. */
function seriesOf(plot: XNode): XNode[] {
  const order = (s: XNode) => parseInt(attr(child(s, "c:order") ?? {}, "val") ?? "0", 10);
  return childrenNamed(plot, "c:ser").sort((a, b) => order(a) - order(b));
}

// --- shapes ----------------------------------------------------------------------------------

type Ctx = { zip: JSZip; rels: Map<string, Rel>; emit: (line: string) => void };

async function chartLines(ctx: Ctx, data: XNode | undefined, name: string, pad: string): Promise<void> {
  const rid = attr(child(data, "c:chart") ?? {}, "r:id");
  const target = rid === undefined ? undefined : ctx.rels.get(rid)?.target;
  const part = target ? await readPart(ctx.zip, target) : undefined;
  if (!part) throw fail("KeyError", `chart part ${rid} not found`);
  const plots = childrenOf(descend(part, "c:chart", "c:plotArea") ?? {}).filter((n) => PLOT_TAGS.has(tagOf(n)));
  try {
    const cats = plots.length ? categories(plotAt(plots, 0)) : [];
    const type = chartType(plotAt(plots, 0));
    ctx.emit(`${pad}[chart ${name}: type=${type} categories=${pyList(cats.map(pyRepr))}]`);
    for (let i = 0; i < plots.length; i++) {
      const plot = plotAt(plots, i);
      for (const ser of seriesOf(plot)) {
        const vals = seriesValues(plot, ser).map((v) => (v === null ? "None" : pyFloat(v)));
        ctx.emit(`${pad}  series ${seriesName(ser)}: ${pyList(vals)}`);
      }
    }
  } catch (e) {
    ctx.emit(`${pad}[chart ${name}: could not read series (${(e as Error).name}) — render the slide]`);
  }
}

function tableLines(ctx: Ctx, data: XNode | undefined, name: string, pad: string): void {
  const tbl = child(data, "a:tbl");
  if (!tbl) throw fail("AttributeError", "the graphic frame holds no table");
  const rows = childrenNamed(tbl, "a:tr");
  const cols = childrenNamed(child(tbl, "a:tblGrid"), "a:gridCol").length;
  ctx.emit(`${pad}[table ${name}: ${rows.length} rows x ${cols} cols]`);
  for (const row of rows) {
    const cells = childrenNamed(row, "a:tc").map((tc) =>
      pyStrip(frameText(child(tc, "a:txBody")).replace(/\n/g, " ")),
    );
    ctx.emit(`${pad}  ${cells.join("\t")}`);
  }
}

/** The shape type python-pptx reports for a shape that has no text of its own. */
function kindOf(sh: XNode): string {
  switch (tagOf(sh)) {
    case "p:cxnSp":
      return "LINE (9)";
    case "p:pic":
      return "MEDIA (16)"; // a picture with a video file; plain pictures are described before this
    case "p:graphicFrame": {
      const data = descend(sh, "a:graphic", "a:graphicData");
      if (attr(data ?? {}, "uri") !== OLE_URI) return "None";
      return child(child(data, "p:oleObj"), "p:embed") ? "EMBEDDED_OLE_OBJECT (7)" : "LINKED_OLE_OBJECT (10)";
    }
  }
  return "None";
}

/** Inches to one decimal as Python's `:.1f` rounds: an exact tie (0.25, 1.25, ...) goes to the even digit. */
function inches(emu: string | undefined): string {
  const v = Number(emu) / EMU_PER_INCH;
  const quarters = v * 4;
  if (Number.isInteger(quarters) && quarters % 2 !== 0) {
    const tenths = Math.floor(v * 10);
    return ((tenths % 2 === 0 ? tenths : tenths + 1) / 10).toFixed(1);
  }
  return v.toFixed(1);
}

async function describe(ctx: Ctx, sh: XNode, name: string, pad: string, depth: number): Promise<void> {
  const tag = tagOf(sh);
  if (tag === "p:grpSp") {
    ctx.emit(`${pad}[group ${name}]`);
    await walkShapes(ctx, sh, depth + 1);
    return;
  }
  if (tag === "p:graphicFrame") {
    const data = descend(sh, "a:graphic", "a:graphicData");
    const uri = attr(data ?? {}, "uri");
    if (uri === TABLE_URI) return tableLines(ctx, data, name, pad);
    if (uri === CHART_URI) return chartLines(ctx, data, name, pad);
  }
  if (tag === "p:sp") {
    const text = pyStrip(frameText(child(sh, "p:txBody")));
    const ph = placeholderOf(sh) ? " placeholder" : "";
    if (!text) {
      ctx.emit(`${pad}[text ${name}${ph}: empty]`);
      return;
    }
    ctx.emit(`${pad}[text ${name}${ph}]`);
    for (const line of splitLines(text)) ctx.emit(`${pad}  ${line}`);
    return;
  }
  if (tag === "p:pic" && !descend(sh, "p:nvPicPr", "p:nvPr", "a:videoFile")) {
    const ext = descend(sh, "p:spPr", "a:xfrm", "a:ext");
    if (!ext) throw fail("TypeError", "the picture has no size of its own");
    ctx.emit(
      `${pad}[picture ${name}: ${inches(attr(ext, "cx"))}x${inches(attr(ext, "cy"))} in — content not readable as text; render the slide]`,
    );
    return;
  }
  ctx.emit(`${pad}[shape ${name}: type=${kindOf(sh)}, no text]`);
}

async function walkShapes(ctx: Ctx, container: XNode | undefined, depth: number): Promise<void> {
  const pad = "  ".repeat(depth);
  for (const sh of shapeNodes(container)) {
    const name = shapeName(sh);
    try {
      await describe(ctx, sh, name, pad, depth);
    } catch (e) {
      const { name: kind, message } = e as Error;
      ctx.emit(`${pad}[shape ${name}: UNREADABLE (${kind}: ${message}) — render the slide to see it]`);
    }
  }
}

// --- main ------------------------------------------------------------------------------------

let zip: JSZip;
try {
  zip = await JSZip.loadAsync(readFileSync(file));
  if (!zip.file("ppt/presentation.xml")) throw fail("ValueError", "not a PowerPoint file (no ppt/presentation.xml)");
} catch (e) {
  console.log(`cannot open ${file}: ${(e as Error).name}: ${(e as Error).message}`);
  process.exit(1);
}

const slides = await slidesInOrder(zip);
const out: string[] = [];
const emit = (line: string) => out.push(line);

for (const { number, path } of slides) {
  if (!want(number)) continue;
  const spTree = descend(await readPart(zip, path), "p:cSld", "p:spTree");
  const titleSp = titleShape(spTree);
  const title = titleSp && tagOf(titleSp) === "p:sp" ? pyStrip(frameText(child(titleSp, "p:txBody"))) : "";
  emit(`=== slide ${number} (layout: ${await layoutName(zip, path)})${title ? " — " + title : ""}`);
  const rels = new Map((await readRels(zip, path)).map((r) => [r.id, r] as const));
  await walkShapes({ zip, rels, emit }, spTree, 0);

  if (!values["no-notes"]) {
    const notes = await notesText(zip, path);
    if (notes) {
      emit("[notes]");
      for (const line of splitLines(notes)) emit(`  ${line}`);
    }
  }
  emit("");
}

if (out.length) console.log(out.join("\n"));
console.log(`# ${slides.length} slides total`);
