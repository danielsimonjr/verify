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

/** Office file to PDF through headless LibreOffice, for the pptx and xlsx render skills. */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

export type Run = typeof spawnSync;

/**
 * Convert `copy` (a private copy, so the original is never touched) to a PDF in `workDir`.
 *
 * LibreOffice gets its own profile under `workDir`: it refuses to start for a user whose
 * profile directory it cannot create, and HOME alone is not enough inside a task image run
 * as a foreign uid. The profile is a file URL (a bare Windows path is not one).
 */
export function sofficeToPdf(
  copy: string,
  workDir: string,
  run: Run = spawnSync,
): { pdf: string } | { error: string } {
  const profile = pathToFileURL(join(workDir, "profile")).href;
  const r = run(
    "soffice",
    ["--headless", `-env:UserInstallation=${profile}`, "--convert-to", "pdf", "--outdir", workDir, copy],
    { encoding: "utf-8", timeout: 300_000, env: { ...process.env, HOME: workDir } },
  );
  const pdf = join(workDir, `${basename(copy, extname(copy))}.pdf`);
  if (existsSync(pdf)) return { pdf };
  // r.error is set when soffice could not be started or timed out; its streams are empty then.
  return { error: (r.stderr || r.stdout || r.error?.message || "").trim().slice(-400) };
}
