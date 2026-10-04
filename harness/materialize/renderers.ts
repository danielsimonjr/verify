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

/** Trajectory renderers and workbook cell TSV views (ExcelJS). */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import ExcelJS from "exceljs";
import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";

import { ensureDir, readText } from "../fsutil.js";

const OPAQUE = new Set([
  "provider_specific_fields",
  "thought_signature",
  "thinking_blocks",
  "images",
  "signature",
]);

function strip(obj: unknown, opaque: Set<string> = OPAQUE): unknown {
  if (Array.isArray(obj)) {
    return obj.map((x) => strip(x, opaque));
  }
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (!opaque.has(k)) out[k] = strip(v, opaque);
    }
    return out;
  }
  return obj;
}

function asText(v: unknown, opaque: Set<string> = OPAQUE): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(strip(v, opaque));
}

/**
 * Python truthiness: null, "", 0, false, an empty list and an empty dict are all falsy. The
 * archived formats carry `content: []` and `arguments: {}` where JavaScript's `if (x)` would
 * treat them as present and render an empty block.
 */
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** Python `a or b or c`: the first truthy value, else the last one. */
function firstTruthy(...vs: unknown[]): unknown {
  return vs.find(truthy) ?? vs[vs.length - 1];
}

export function renderOpenaiMessages(messages: Record<string, unknown>[]): string {
  const out: string[] = [];
  for (const m of messages) {
    const role = String(m.role ?? "?");
    if (role === "system") continue;
    const parts: string[] = [];
    if (truthy(m.reasoning_content)) {
      parts.push(`[thinking]\n${asText(m.reasoning_content)}`);
    }
    const c = m.content;
    if (truthy(c)) parts.push(asText(c));
    const toolCalls = (m.tool_calls as Record<string, unknown>[]) ?? [];
    for (const tc of toolCalls) {
      const fn = (tc.function as Record<string, unknown>) ?? {};
      parts.push(`[tool_call ${fn.name}]\n${asText(fn.arguments)}`);
    }
    if (truthy(m.name) && role === "tool") {
      parts.unshift(`[tool_result ${m.name}]`);
    }
    if (parts.length) out.push(`<${role}>\n${parts.join("\n")}`);
  }
  return out.join("\n\n");
}

export function renderOpencodeEvents(lines: string[]): string {
  const out: string[] = [];
  for (const line of lines) {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    // A line that parses to null, a number, a string or a list is as corrupt as one that does not parse.
    if (e === null || typeof e !== "object" || Array.isArray(e)) continue;
    const t = e.type;
    const part = (e.part as Record<string, unknown>) ?? {};
    if (t === "tool_use") {
      const st = (part.state as Record<string, unknown>) ?? {};
      out.push(
        `<tool ${part.tool}>\ninput: ${asText(st.input)}\noutput: ${asText(st.output)}`,
      );
    } else if (t === "text" || t === "message" || t === "assistant_text") {
      const txt = asText(firstTruthy(part.text, part.content));
      if (txt.trim()) out.push(`<assistant>\n${txt}`);
    } else if (t === "reasoning") {
      const txt = asText(part.text);
      if (txt.trim()) out.push(`<thinking>\n${txt}`);
    }
  }
  return out.join("\n\n");
}

export function wbToolResults(runDir: string): Record<string, string> {
  let raw: string | null = null;
  for (const name of ["cbc-output.txt", "cc-output.txt"]) {
    const p = `${runDir}/agent/${name}`;
    try {
      raw = readText(p);
      break;
    } catch {
      /* try next */
    }
  }
  // No prototype: a tool_use_id such as "constructor" must be an ordinary key, not Object's own.
  const out: Record<string, string> = Object.create(null);
  if (raw === null) return out;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.includes('"tool_result"')) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const msg = ev.message;
    if (!msg || typeof msg !== "object") continue;
    const content = (msg as Record<string, unknown>).content as unknown[];
    for (const b of content ?? []) {
      if (!b || typeof b !== "object") continue;
      const block = b as Record<string, unknown>;
      if (block.type !== "tool_result") continue;
      const tid = block.tool_use_id;
      if (!tid) continue;
      let c: unknown = block.content;
      if (Array.isArray(c)) {
        const txt = c
          .filter((x) => x && typeof x === "object" && (x as Record<string, unknown>).type === "text")
          .map((x) => String((x as Record<string, unknown>).text ?? ""))
          .join("\n");
        c = txt || c;
      }
      out[String(tid)] = asText(c);
      if (block.is_error) {
        out[String(tid)] = `[tool reported an error]\n${out[String(tid)]}`;
      }
    }
  }
  return out;
}

export function renderAtifSteps(
  traj: unknown,
  results: Record<string, string> = {},
): string {
  const steps =
    traj !== null && typeof traj === "object" && "steps" in (traj as object)
      ? (traj as Record<string, unknown>).steps
      : traj;
  const out: string[] = [];
  for (const st of (steps as unknown[]) ?? []) {
    if (!st || typeof st !== "object") continue;
    const step = st as Record<string, unknown>;
    const parts: string[] = [];
    if (truthy(step.thinking)) parts.push(`[thinking]\n${asText(step.thinking)}`);
    if (truthy(step.message)) parts.push(asText(step.message));
    for (const tc of (step.tool_calls as Record<string, unknown>[]) ?? []) {
      const fn = (tc.function as Record<string, unknown>) ?? {};
      const nm = firstTruthy(tc.tool_name, tc.name, tc.function_name, fn.name);
      const args = firstTruthy(tc.arguments, tc.input, fn.arguments);
      parts.push(`[tool_call ${nm}]\n${asText(args)}`);
      // WorkBuddy's ATIF conversion drops tool results, often as an explicit null: only a
      // real inline value may suppress the rejoin from the raw CLI stream.
      const inline = tc.result ?? tc.output;
      const id = tc.tool_call_id;
      if (inline !== undefined && inline !== null) {
        parts.push(`[tool_result ${nm}]\n${asText(inline)}`);
      } else if (id !== undefined && id !== null && Object.hasOwn(results, String(id))) {
        parts.push(`[tool_result ${nm}]\n${results[String(id)]}`);
      }
    }
    for (const tr of (step.tool_results as unknown[]) ?? []) {
      parts.push(`[tool_result]\n${asText(tr)}`);
    }
    if (parts.length) {
      out.push(`<${step.source ?? "step"} ${step.step_id ?? ""}>\n${parts.join("\n")}`);
    }
  }
  return out.join("\n\n");
}

export function renderWsbTraj(f: string): string {
  try {
    const tr = (JSON.parse(readText(f, "utf8")) as Record<string, unknown>).trace ?? {};
    const trace = tr as Record<string, unknown>;
    const out: string[] = [];
    for (const st of (trace.executionTrace as unknown[]) ?? []) {
      if (!st || typeof st !== "object") continue;
      const step = st as Record<string, unknown>;
      if (step.type === "tool") {
        const head = `[tool_call ${step.tool}]\n${asText(step.input)}`;
        const status = `status=${step.status} exitCode=${step.exitCode}`;
        out.push(
          `<tool>\n${head}\n[tool_result ${step.tool}] ${status}\n${asText(step.output)}`,
        );
      } else {
        const c = asText(step.content);
        if (c.trim()) out.push(`<${step.role ?? "assistant"}>\n${c}`);
      }
    }
    return out.join("\n\n");
  } catch (e) {
    const err = e as Error;
    return `(trajectory unreadable: ${err.name}: ${err.message})`;
  }
}

const SB2_OPAQUE = new Set([...OPAQUE, "tool_calls"]);

export function renderSb2Traj(f: string): string {
  try {
    const h = (JSON.parse(readText(f, "utf8")) as Record<string, unknown>).history ?? [];
    const out: string[] = [];
    for (const m of h as Record<string, unknown>[]) {
      const role = String(m.role ?? "?");
      if (m.message_type === "system_prompt") continue;
      const parts: string[] = [];
      if (truthy(m.thought)) parts.push(`[thinking]\n${asText(m.thought, SB2_OPAQUE)}`);
      if (truthy(m.action)) parts.push(`[action]\n${asText(m.action, SB2_OPAQUE)}`);
      const c = m.content;
      if (truthy(c)) parts.push(asText(c, SB2_OPAQUE));
      if (parts.length) out.push(`<${role}>\n${parts.join("\n")}`);
    }
    return out.join("\n\n");
  } catch (e) {
    const err = e as Error;
    return `(trajectory unreadable: ${err.name}: ${err.message})`;
  }
}

export const CELLS_TSV_CAP = 200_000;

/** The text of a cell note. A loaded workbook holds it as `{ texts: [{ text }] }`, not a string. */
function noteText(note: unknown): string {
  if (typeof note === "string") return note;
  const texts = (note as { texts?: { text?: string }[] } | null | undefined)?.texts;
  return Array.isArray(texts) ? texts.map((t) => t.text ?? "").join("") : "";
}

function cellNote(cell: ExcelJS.Cell): string {
  const raw = noteText(cell.note);
  if (!raw.trim()) return "";
  return `\t# ${raw.split(/\s+/).filter(Boolean).join(" ")}`;
}

function cellFormula(cell: ExcelJS.Cell): string | null {
  if (cell.formula) return String(cell.formula).startsWith("=") ? String(cell.formula) : `=${cell.formula}`;
  const v = cell.value;
  if (v !== null && typeof v === "object" && "formula" in (v as object)) {
    const f = String((v as { formula: string }).formula);
    return f.startsWith("=") ? f : `=${f}`;
  }
  if (typeof v === "string" && v.startsWith("=")) return v;
  return null;
}

function cachedValue(cell: ExcelJS.Cell): unknown {
  if (cell.result !== undefined && cell.result !== null) return cell.result;
  const v = cell.value;
  if (v !== null && typeof v === "object" && "result" in (v as object)) {
    return (v as { result: unknown }).result;
  }
  if (typeof v === "string" && v.startsWith("=")) return undefined;
  return v;
}

/** The text a reader of stored values sees for a cell value (rich text, errors and hyperlinks included). */
function displayValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as { richText?: { text: string }[]; error?: unknown; text?: unknown };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join("");
    if (typeof o.error === "string") return o.error;
    if (o.text !== undefined) return displayValue(o.text);
    return JSON.stringify(v);
  }
  return String(v);
}

const COMMENT_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: false,
  isArray: (name) => ["sheet", "Relationship", "comment"].includes(name),
});

/** All the text under a `<text>` node: plain `<t>` and rich-text `<r><t>` runs. */
function xmlText(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(xmlText).join("");
  const o = node as Record<string, unknown>;
  return xmlText(o["#text"]) + xmlText(o.t) + xmlText(o.r);
}

function zipTarget(base: string, target: string): string {
  return target.startsWith("/") ? target.slice(1) : posix.join(posix.dirname(base), target);
}

/** A real cell address: column A..XFD, row 1..1048576 (the limits of the format). */
function isCellRef(ref: string): boolean {
  const m = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(ref);
  if (!m) return false;
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col <= 16384 && Number(m[2]) <= 1_048_576;
}

/**
 * Cell notes read straight from the workbook's comment parts: sheet name -> cell ref -> text.
 * exceljs attaches a comment only to a cell that exists in the sheet XML, so a note on an
 * otherwise empty, unstyled cell (the usual way a template states its convention) never
 * reaches `cell.note`. Best effort: a workbook whose parts cannot be followed yields no extra notes.
 */
export async function sheetNotes(buf: Buffer): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  try {
    const zip = await JSZip.loadAsync(buf);
    const read = async (name: string) => {
      const f = zip.file(name);
      if (!f) return null;
      const xml = await f.async("string");
      // An OOXML part never needs a DTD; refusing one rules out entity-expansion payloads.
      return /<!DOCTYPE|<!ENTITY/i.test(xml) ? null : COMMENT_PARSER.parse(xml);
    };
    const wbXml = await read("xl/workbook.xml");
    const wbRels = await read("xl/_rels/workbook.xml.rels");
    const sheets = (wbXml?.workbook?.sheets?.sheet ?? []) as Record<string, string>[];
    const rels = (wbRels?.Relationships?.Relationship ?? []) as Record<string, string>[];
    for (const sh of sheets) {
      const rel = rels.find((r) => r["@_Id"] === sh["@_r:id"]);
      if (!rel) continue;
      const sheetPath = zipTarget("xl/workbook.xml", rel["@_Target"]!);
      const sheetRels = await read(`${posix.dirname(sheetPath)}/_rels/${posix.basename(sheetPath)}.rels`);
      for (const r of (sheetRels?.Relationships?.Relationship ?? []) as Record<string, string>[]) {
        if (!String(r["@_Type"]).endsWith("/comments")) continue;
        const cx = await read(zipTarget(sheetPath, r["@_Target"]!));
        const notes = out.get(sh["@_name"]!) ?? new Map<string, string>();
        for (const c of (cx?.comments?.commentList?.comment ?? []) as Record<string, unknown>[]) {
          const ref = String(c["@_ref"] ?? "");
          const text = xmlText(c.text);
          if (isCellRef(ref) && text.trim()) notes.set(ref, text);
        }
        out.set(sh["@_name"]!, notes);
      }
    }
  } catch {
    /* supplementary: exceljs's own notes are still used */
  }
  return out;
}

/**
 * Sibling view of a workbook: one line per non-empty cell, `Sheet!A1<TAB>value<TAB>formula`, plus
 * `<TAB># note` where the cell carries one. Cached values sit next to formulas. At most `cap`
 * cells are written, then ONE cut marker. Returns false when the workbook cannot be read; a
 * failure to write the view is thrown.
 */
export async function renderCellsTsv(
  xlsxPath: string,
  outPath: string,
  cap: number = CELLS_TSV_CAP,
): Promise<boolean> {
  let n = 0;
  let formulas = 0;
  let uncached = 0;
  const lines: string[] = [];
  let sheetNames: string[];
  try {
    const wb = new ExcelJS.Workbook();
    // exceljs typings target Node's legacy Buffer alias; Node 22's Buffer is structurally fine.
    const buf = readFileSync(xlsxPath);
    await wb.xlsx.load(buf as never);
    sheetNames = wb.worksheets.map((ws) => ws.name);
    // Each injected note creates a cell, so they count against the same cap as the output.
    let injected = 0;
    for (const [name, notes] of await sheetNotes(buf)) {
      const ws = wb.getWorksheet(name);
      if (!ws) continue;
      for (const [ref, text] of notes) {
        if (injected >= cap) break;
        const cell = ws.getCell(ref);
        if (!noteText(cell.note).trim()) {
          cell.note = text;
          injected += 1;
        }
      }
    }

    sheets: for (const ws of wb.worksheets) {
      // exceljs eachRow/eachCell ignore the callback's return value, so they cannot be stopped:
      // walk the rows by index and guard each cell instead. findRow does not create the rows
      // that are not there; getRow would allocate one per index up to the last row.
      const rows = ws.rowCount;
      for (let r = 1; r <= rows; r++) {
        const row = ws.findRow(r);
        if (!row) continue;
        row.eachCell({ includeEmpty: true }, (cell) => {
          if (n >= cap) return;
          const note = cellNote(cell);
          const formula = cellFormula(cell);
          const hasValue = cell.value !== null && cell.value !== undefined;
          if (!hasValue && !note) return;

          const addr = cell.address;
          if (formula) {
            const cached = cachedValue(cell);
            formulas += 1;
            if (cached === undefined || cached === null) uncached += 1;
            lines.push(
              `${ws.name}!${addr}\t${cached === undefined || cached === null ? "" : displayValue(cached)}\t${formula}${note}\n`,
            );
          } else {
            const v = hasValue ? displayValue(cell.value) : "";
            lines.push(`${ws.name}!${addr}\t${v}\t${note}\n`);
          }
          n += 1;
          if (n >= cap) lines.push(`# cut at ${cap} cells\n`);
        });
        if (n >= cap) break sheets;
      }
    }
  } catch {
    return false;
  }

  ensureDir(dirname(outPath));
  const header =
    `# sheets: ${sheetNames.join(", ")}; cells ${n}; formulas ${formulas}, without cached value ${uncached}\n`;
  writeFileSync(outPath, header + lines.join(""), "utf8");
  return true;
}
