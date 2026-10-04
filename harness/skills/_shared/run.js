#!/usr/bin/env node
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

/** Dual-runtime skill entry: Bun (dev) or compiled/Node (prod). */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function launchSkill(metaUrl: string): Promise<void> {
  const dir = dirname(fileURLToPath(metaUrl));
  const base = basename(fileURLToPath(metaUrl), ".js");
  const skill = basename(join(dir, ".."));
  const ts = join(dir, `${base}.ts`);
  const compiled = join(
    dir,
    "..",
    "..",
    "..",
    "..",
    "dist",
    "harness",
    "skills",
    skill,
    "scripts",
    `${base}.js`,
  );
  const extra = process.argv.slice(2);

  if (typeof globalThis.Bun !== "undefined") {
    await import(pathToFileURL(ts).href);
    return;
  }
  if (existsSync(compiled)) {
    await import(pathToFileURL(compiled).href);
    return;
  }
  const bun = spawnSync("bun", [ts, ...extra], { stdio: "inherit" });
  if (bun.error && bun.error.code === "ENOENT") {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", ts, ...extra], {
      stdio: "inherit",
    });
    process.exit(r.status ?? 1);
  }
  process.exit(bun.status ?? 1);
}
