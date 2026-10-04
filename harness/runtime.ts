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
 * Dual-runtime helpers: Bun for development, Node for production.
 *
 * Source is TypeScript. `bun harness/cli.ts` runs it directly. `npm run build`
 * emits `dist/` for `node dist/harness/cli.js`. Avoid Bun-only APIs so the same
 * sources run under both interpreters.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

export function isMain(metaUrl: string): boolean {
  const meta = import.meta as ImportMeta & { main?: boolean };
  if (typeof meta.main === "boolean" && meta.url === metaUrl) {
    return meta.main;
  }
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return metaUrl === pathToFileURL(resolve(argv1)).href;
  } catch {
    return false;
  }
}

/** Sibling module path with the same extension as the caller (.ts under Bun, .js under Node). */
export function siblingModule(metaUrl: string, name: string): string {
  const ext = extname(fileURLToPath(metaUrl)) || (isBun ? ".ts" : ".js");
  return join(dirname(fileURLToPath(metaUrl)), `${name}${ext}`);
}

/**
 * Command to re-invoke a harness entry (driver, etc.) as a subprocess.
 * Bun: `bun <thisDir>/driver.ts`. Node: `node <thisDir>/driver.js`.
 */
export function harnessCommand(metaUrl: string, entry: string, args: string[]): string[] {
  const script = siblingModule(metaUrl, entry);
  if (isBun) {
    return [process.execPath, script, ...args];
  }
  if (existsSync(script)) {
    return [process.execPath, script, ...args];
  }
  const bun = process.env.BUN_INSTALL
    ? join(process.env.BUN_INSTALL, "bin", "bun")
    : "bun";
  const ts = script.replace(/\.js$/, ".ts");
  if (existsSync(ts)) {
    return [bun, ts, ...args];
  }
  return [process.execPath, script, ...args];
}

export function python3(): string {
  const hit = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
    encoding: "utf8",
  });
  return hit.status === 0 && hit.stdout.trim() ? hit.stdout.trim() : "python3";
}
