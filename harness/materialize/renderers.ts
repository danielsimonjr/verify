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
import { dirname } from "node:path";
import ExcelJS from "exceljs";

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

export function renderOpenaiMessages(messages: Record<string, unknown>[]): string {
  const out: string[] = [];
  for (const m of messages) {
    const role = String(m.role ?? "?");
    if (role === "system") continue;
    const parts: string[] = [];
    if (m.reasoning_content) {
      parts.push(`[thinking]\n${asText(m.reasoning_content)}`);
    }
    const c = m.content;
    if (c) parts.push(asText(c));
    const toolCalls = (m.tool_calls as Record<string, unknown>[]) ?? [];
    for (const tc of toolCalls) {
      const fn = (tc.function as Record<string, unknown>) ?? {};
      parts.push(`[tool_call ${fn.name}]\n${asText(fn.arguments)}`);
    }
    if (m.name && role === "tool") {
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
    const t = e.type;
    const part = (e.part as Record<string, unknown>) ?? {};
    if (t === "tool_use") {
      const st = (part.state as Record<string, unknown>) ?? {};
      out.push(
        `<tool ${part.tool}>\ninput: ${asText(st.input)}\noutput: ${asText(st.output)}`,
      );
    } else if (t === "text" || t === "message" || t === "assistant_text") {
      const txt = asText(part.text ?? part.content);
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
  if (raw === null) return {};
  const out: Record<string, string> = {};
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
    if (step.thinking) parts.push(`[thinking]\n${asText(step.thinking)}`);
    if (step.message) parts.push(asText(step.message));
    for (const tc of (step.tool_calls as Record<string, unknown>[]) ?? []) {
      const fn = (tc.function as Record<string, unknown>) ?? {};
      const nm =
        tc.tool_name ??
        tc.name ??
        tc.function_name ??
        fn.name;
      const args = tc.arguments ?? tc.input ?? fn.arguments;
      parts.push(`[tool_call ${nm}]\n${asText(args)}`);
      if (tc.result !== undefined || tc.output !== undefined) {
        parts.push(`[tool_result ${nm}]\n${asText(tc.result ?? tc.output)}`);
      } else if (tc.tool_call_id && results[String(tc.tool_call_id)]) {
        parts.push(`[tool_result ${nm}]\n${results[String(tc.tool_call_id)]}`);
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
      if (m.thought) parts.push(`[thinking]\n${asText(m.thought, SB2_OPAQUE)}`);
      if (m.action) parts.push(`[action]\n${asText(m.action, SB2_OPAQUE)}`);
      const c = m.content;
      if (c) parts.push(asText(c, SB2_OPAQUE));
      if (parts.length) out.push(`<${role}>\n${parts.join("\n")}`);
    }
    return out.join("\n\n");
  } catch (e) {
    const err = e as Error;
    return `(trajectory unreadable: ${err.name}: ${err.message})`;
  }
}

export const CELLS_TSV_CAP = 200_000;

function cellNote(cell: ExcelJS.Cell): string {
  let raw: string | undefined;
  if (cell.note) {
    raw = typeof cell.note === "string" ? cell.note : String(cell.note);
  } else {
    const model = (cell as ExcelJS.Cell & { model?: { comment?: { texts?: { text?: string }[] } } })
      .model;
    raw = model?.comment?.texts?.map((t) => t.text ?? "").join("");
  }
  if (!raw) return "";
  return `\t# ${raw.split(/\s+/).join(" ")}`;
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

function displayValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && "richText" in (v as object)) {
    return ((v as { richText: { text: string }[] }).richText ?? [])
      .map((r) => r.text)
      .join("");
  }
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export async function renderCellsTsv(xlsxPath: string, outPath: string): Promise<boolean> {
  try {
    const buf = readFileSync(xlsxPath);
    const wb = new ExcelJS.Workbook();
    // exceljs typings target Node's legacy Buffer alias; Node 22's Buffer is structurally fine.
    await wb.xlsx.load(buf as never);
    let n = 0;
    let formulas = 0;
    let uncached = 0;
    const lines: string[] = [];
    const sheetNames = wb.worksheets.map((ws) => ws.name);

    for (const ws of wb.worksheets) {
      ws.eachRow({ includeEmpty: true }, (row) => {
        row.eachCell({ includeEmpty: true }, (cell) => {
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
          if (n >= CELLS_TSV_CAP) {
            lines.push(`# cut at ${CELLS_TSV_CAP} cells\n`);
          }
        });
        if (n >= CELLS_TSV_CAP) return false;
      });
      if (n >= CELLS_TSV_CAP) break;
    }

    ensureDir(dirname(outPath));
    const header =
      `# sheets: ${sheetNames.join(", ")}; cells ${n}; formulas ${formulas}, without cached value ${uncached}\n`;
    writeFileSync(outPath, header + lines.join(""), "utf8");
    return true;
  } catch {
    return false;
  }
}
