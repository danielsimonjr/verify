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
 * Directories for the skill scripts' output.
 *
 * A skill runs on its own, so it cannot import `harness/fsutil.ts` (the jail shows a verifier
 * only harness/skills): this is the skill-side twin of `ensureDir` there.
 */

import { mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Create `path` and its parents. The path is resolved first: Bun on Windows throws EEXIST for a
 * recursive mkdir of "." or ".." and ENOENT for "./" (oven-sh/bun#44576), where Node succeeds,
 * and an output directory comes from the command line, so `--out .` is an ordinary thing to type.
 * A directory that exists is left alone, because a recursive mkdir of a Windows drive root throws
 * EPERM in Node and Bun.
 */
export function ensureDir(path: string): void {
  const dir = resolve(path);
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return;
  mkdirSync(dir, { recursive: true });
}
