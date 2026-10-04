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
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const SHAPE_MAX = 200;
const TEXT_EXT = new Set([
  ".txt",
  ".md",
  ".csv",
  ".tsv",
  ".json",
  ".html",
  ".htm",
  ".xml",
  ".yaml",
  ".yml",
]);
const SPECIFIC = new RegExp(
  `\\b\\d{4}-\\d{2}-\\d{2}\\b` +
    `|\\b[A-Z]{2,}[-_/]?\\d[\\w-]*\\b` +
    `|(?<![\\w.])\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?` +
    `|(?<![\\w.])\\d+\\.\\d+%?` +
    `|(?<![\\w.])\\d{3,}%?(?![\\w])`,
  "g",
);

function jsonShape(obj: unknown, depth = 0): string {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    if (depth >= 2) return "object";
    const entries = Object.entries(obj as Record<string, unknown>).slice(0, 12);
    return (
      "{" +
      entries.map(([k, v]) => `${k}: ${jsonShape(v, depth + 1)}`).join(", ") +
      "}"
    );
  }
  if (Array.isArray(obj)) {
    const kinds = [
      ...new Set(obj.slice(0, 20).map((x) => jsonShape(x, depth + 1))),
    ];
    return "[" + (kinds.length ? kinds.join(" | ") : "empty") + "]";
  }
  if (typeof obj === "boolean") return "bool";
  if (typeof obj === "number") return "number";
  if (obj == null) return "null";
  return "str";
}

function fileShape(p: string, rel: string): string | null {
  try {
    if (rel.endsWith(".cells.tsv")) {
      const head = readFileSync(p, "utf-8").split("\n")[0]?.trim() ?? "";
      return head.startsWith("# sheets:") ? head.slice(2) : null;
    }
    const low = rel.toLowerCase();
    if (low.endsWith(".csv") || low.endsWith(".tsv")) {
      return "header: " + readFileSync(p, "utf-8").split("\n")[0]?.trim();
    }
    if (low.endsWith(".json")) {
      return jsonShape(JSON.parse(readFileSync(p, "utf-8")));
    }
  } catch {
    return null;
  }
  return null;
}

function norm(tok: string): string {
  let t = tok.replace(/,/g, "");
  if (/^\d+\.\d+%?$/.test(t)) {
    const pct = t.endsWith("%");
    t = t.replace(/%$/, "").replace(/0+$/, "").replace(/\.$/, "") + (pct ? "%" : "");
  }
  return t;
}

function readBundle(deliv: string) {
  const files: Record<string, number> = {};
  const lines: [string, string][] = [];
  const shapes: Record<string, string> = {};

  function walk(dir: string, prefix: string) {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(p).isDirectory()) walk(p, rel);
      else {
        const view = rel.endsWith(".text.txt") || rel.endsWith(".cells.tsv");
        if (!view) files[rel] = statSync(p).size;
        const src = view ? rel.split(".").slice(0, -2).join(".") : rel;
        const shape = fileShape(p, rel);
        if (shape) shapes[src] = shape.slice(0, SHAPE_MAX);
        const ext = name.includes(".") ? "." + name.split(".").pop()!.toLowerCase() : "";
        if (view || TEXT_EXT.has(ext)) {
          try {
            for (const ln of readFileSync(p, "utf-8").split("\n")) {
              if (ln.trim() && !ln.startsWith("# sheets:")) lines.push([src, ln.trim()]);
            }
          } catch {
            /* skip */
          }
        }
      }
    }
  }
  walk(deliv, "");
  return { files, lines, shapes };
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: "string" },
    "min-len": { type: "string", default: "4" },
    max: { type: "string", default: "60" },
  },
});
const rollouts = positionals[0];
if (!rollouts) {
  console.error("usage: bundle_inventory.py ROLLOUTS_DIR [--base rNN] [--min-len 4] [--max 60]");
  process.exit(1);
}

const base = values.base;
const minLen = parseInt(values["min-len"] ?? "4", 10);
const max = parseInt(values.max ?? "60", 10);

const cands = readdirSync(rollouts)
  .filter((d) => existsSync(join(rollouts, d, "deliverables")))
  .sort();

if (!cands.length) {
  console.error("no candidates with deliverables/ found");
  process.exit(1);
}

const files: Record<string, Record<string, number>> = {};
const heads = new Map<string, Set<string>>();
const specs = new Map<string, Map<string, [string, string]>>();
const shapes = new Map<string, Map<string, string>>();

for (const c of cands) {
  const { files: f, lines, shapes: shp } = readBundle(join(rollouts, c, "deliverables"));
  files[c] = f;
  for (const [fpath, line] of Object.entries(shp)) {
    if (!shapes.has(fpath)) shapes.set(fpath, new Map());
    shapes.get(fpath)!.set(c, line);
  }
  for (const [src, ln] of lines) {
    if (ln.startsWith("#") && ln.length < 120) {
      const h = ln.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
      if (!heads.has(h)) heads.set(h, new Set());
      heads.get(h)!.add(c);
    }
    for (const m of ln.matchAll(SPECIFIC)) {
      const tok = norm(m[0]);
      if (tok.length >= minLen) {
        if (!specs.has(tok)) specs.set(tok, new Map());
        if (!specs.get(tok)!.has(c)) specs.get(tok)!.set(c, [src, ln.slice(0, 160)]);
      }
    }
  }
}

const n = cands.length;
console.log(`# files (${n} candidates)`);
for (const c of cands) {
  console.log(
    `${c}: ` +
      Object.entries(files[c])
        .map(([f, s]) => `${f} (${s.toLocaleString()}B)`)
        .join(", "),
  );
}

const names = new Map<string, Set<string>>();
for (const c of cands) {
  for (const f of Object.keys(files[c])) {
    if (!names.has(f)) names.set(f, new Set());
    names.get(f)!.add(c);
  }
}
const partial = [...names.entries()].filter(([, cs]) => cs.size < n);
if (partial.length) {
  console.log("\n# files not delivered by everyone");
  for (const [f, cs] of partial.sort((a, b) => b[1].size - a[1].size)) {
    console.log(`${f}: ${[...cs].sort().join(" ")}`);
  }
}

const diverging = [...shapes.entries()].filter(([, by]) => new Set(by.values()).size > 1);
if (diverging.length) {
  console.log(
    "\n# shape differences (header row / sheets and cached values / JSON field types)",
  );
  for (const [f, by] of diverging.sort((a, b) => a[0].localeCompare(b[0]))) {
    const groups = new Map<string, string[]>();
    for (const [c, line] of by) {
      if (!groups.has(line)) groups.set(line, []);
      groups.get(line)!.push(c);
    }
    console.log(`${f}:`);
    for (const [line, cs] of [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, max)) {
      console.log(`  [${cs.length}/${n}] ${[...cs].sort().join(" ")}: ${line}`);
    }
  }
}

const wanted = (holders: Set<string>) =>
  holders.size > 0 && holders.size < n && (!base || !holders.has(base));

const headRows = [...heads.entries()].filter(([h, cs]) => h && wanted(cs));
if (headRows.length) {
  console.log(
    "\n# headings not shared by all" + (base ? ` (absent from ${base})` : ""),
  );
  for (const [h, cs] of headRows.sort((a, b) => b[1].size - a[1].size).slice(0, max)) {
    console.log(`[${cs.size}/${n}] ${h}  <- ${[...cs].sort().join(" ")}`);
  }
}

const specRows = [...specs.entries()].filter(([, hs]) => wanted(new Set(hs.keys())));
console.log(
  "\n# specifics not shared by all" +
    (base ? ` (absent from ${base})` : "") +
    `: ${specRows.length} (showing ${Math.min(specRows.length, max)}; most widely held first)`,
);
for (const [tok, hs] of specRows
  .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
  .slice(0, max)) {
  const c0 = [...hs.keys()].sort()[0]!;
  const [src, ln] = hs.get(c0)!;
  console.log(
    `[${hs.size}/${n}] ${tok}  <- ${[...hs.keys()].sort().join(" ")}\n        ${c0}:${src}: ${ln}`,
  );
}

process.exit(0);
