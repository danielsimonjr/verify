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
 * Derive task images that also carry the harness tool stack.
 *
 *     bun harness/env/derive.ts [--jobs 8] [--only NAME ...]
 *     node dist/harness/env/derive.js [--jobs 8] [--only NAME ...]
 *     veriharness env-derive [--jobs 8] [--only NAME ...]
 *
 * A benchmark's task image holds the task's own environment and nothing else; the
 * verifier's skills additionally need Node (mounted from harness/vendor) and, for
 * native Python task images, the document libraries models still reach for.
 * <data>/_worlds/wb/<task>/.exported marker, a derived image `vh/<name>` = the task
 * image plus that stack, which env.imageFor prefers when it exists. Images whose
 * Python has no pip are left as they are (the task image is used unchanged).
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import * as config from "../config.js";
import { isMain } from "../runtime.js";
import { mapPool } from "../pool.js";
import { exists, readText } from "../fsutil.js";

export const STACK =
  "openpyxl xlrd python-docx python-pptx pymupdf pdfplumber pypdf PyPDF2 " +
  "pandas numpy scipy statsmodels matplotlib reportlab tabulate pytest";

const DOCKERFILE = (base: string, stack: string) =>
  `FROM ${base}\nRUN python3 -m pip install --no-cache-dir -q ${stack} || pip install --no-cache-dir -q ${stack} || true\n`;

export function derivedName(base: string): string {
  return "vh/" + base.split("/").pop()!.split(":")[0];
}

function imageExists(tag: string): boolean {
  return spawnSync("docker", ["image", "inspect", tag], { encoding: "utf8" }).status === 0;
}

function build(base: string): string {
  const tag = derivedName(base);
  if (imageExists(tag)) return `${tag}: exists`;
  const r = spawnSync("docker", ["build", "-q", "-t", tag, "-"], {
    input: DOCKERFILE(base, STACK),
    encoding: "utf8",
    timeout: 1_800_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (r.status === 0) return `${tag}: ok`;
  const err = (r.stderr || "").slice(-200);
  return `${tag}: FAILED ${err}`;
}

function collectBases(): string[] {
  const root = join(config.DATA, "_worlds", "wb");
  const bases = new Set<string>();
  try {
    for (const name of readdirSync(root)) {
      const marker = join(root, name, ".exported");
      if (exists(marker)) bases.add(readText(marker).trim());
    }
  } catch {
    /* no wb worlds */
  }
  return [...bases].sort();
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let jobs = 8;
  const only: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--jobs" && argv[i + 1]) {
      jobs = parseInt(argv[++i], 10);
    } else if (argv[i] === "--only") {
      while (argv[i + 1] && !argv[i + 1]!.startsWith("-")) only.push(argv[++i]!);
    }
  }
  let bases = collectBases();
  if (only.length) bases = bases.filter((b) => only.includes(b));
  const lines = await mapPool(bases, jobs, async (base) => build(base));
  for (const line of lines) console.log(line);
  return 0;
}

if (isMain(import.meta.url)) {
  main().then((c) => process.exit(c));
}
