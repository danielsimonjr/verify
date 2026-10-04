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
 * Hand-off to a Python script that ships next to a skill script.
 *
 * Some evidence tools have no equivalent in the Node stack (pdfplumber's table finder) or
 * need a library the task images guarantee only for Python (PyMuPDF; see STACK in
 * env/derive.ts). Those scripts stay Python, as grade/wb.py does, and the TypeScript entry
 * point finds an interpreter that can import what the script needs.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Whether `python` can import every one of `modules`. */
export type PythonProbe = (python: string, modules: readonly string[]) => boolean;

/**
 * Interpreters to try, in order. `VERIHARNESS_PYTHON` (comma-separated) replaces the
 * defaults, for a venv or a Python that is not on PATH under the usual names.
 */
export function pythonCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const forced = (env.VERIHARNESS_PYTHON ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (forced.length) return forced;
  return process.platform === "win32" ? ["python", "python3", "py"] : ["python3", "python"];
}

/** Real probe: a missing binary, a Store stub or a failed import all count as "no". */
export const importProbe: PythonProbe = (python, modules) =>
  spawnSync(python, ["-c", modules.map((m) => `import ${m}`).join(";")], {
    stdio: "ignore",
    timeout: 60_000,
  }).status === 0;

/** The first candidate interpreter that can import every module, or null. */
export function findPython(
  modules: readonly string[],
  probe: PythonProbe = importProbe,
  candidates: readonly string[] = pythonCandidates(),
): string | null {
  return candidates.find((python) => probe(python, modules)) ?? null;
}

/**
 * Path of a file that sits next to the calling script. `tsc` copies only .ts output, so
 * from `dist/harness/...` the file is looked up in the matching source directory.
 */
export function sibling(metaUrl: string, name: string): string {
  const dir = dirname(fileURLToPath(metaUrl));
  const here = join(dir, name);
  if (existsSync(here)) return here;
  const source = join(dir.replace(/[\\/]dist(?=[\\/]harness[\\/])/, ""), name);
  return existsSync(source) ? source : here;
}

/** Run a Python script with inherited stdio and return its exit status (1 if it never ran). */
export function runPythonScript(python: string, script: string, args: readonly string[]): number {
  return spawnSync(python, [script, ...args], { stdio: "inherit" }).status ?? 1;
}
