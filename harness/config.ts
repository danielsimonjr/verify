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
 * Filesystem locations and verifier model lanes.
 *
 * Everything host-specific is read from the environment so the code carries no
 * machine paths, cloud project names or credentials:
 *
 *     VERIHARNESS_DATA        materialized rollout pools        (default: <repo>/data)
 *     VERIHARNESS_RUNS        run outputs                       (default: <repo>/runs)
 *     VERIHARNESS_BENCH_ROOT  checkout holding the upstream benchmarks and their archived
 *                             rollouts; needed only to materialize pools and to re-grade
 *                             revised artifacts (layout: see README, "Benchmarks")
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The repository root: the nearest ancestor of this module that holds package.json.
 *
 * Under Bun this module is <root>/harness/config.ts. After `npm run build` it is
 * <root>/dist/harness/config.js. The prompts, skills, scripts and pi-home that the paths
 * below name are plain files that tsc does not emit, so both layouts must resolve to the same
 * root. Do not add a package.json under dist/ or harness/: it would end this search early.
 */
function findRepoRoot(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return dir;
    if (dirname(dir) === dir) {
      throw new Error(`cannot locate the repository root: no package.json above ${from}`);
    }
  }
}

export const REPO = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
export const HARNESS_DIR = join(REPO, "harness");
export const PROMPTS_DIR = join(HARNESS_DIR, "prompts");
export const SKILLS_DIR = join(HARNESS_DIR, "skills");
export const SCRIPTS_DIR = join(HARNESS_DIR, "scripts");

function envPath(varName: string, fallback: string): string {
  const raw = process.env[varName];
  const p = raw && raw.length > 0 ? raw : fallback;
  return resolve(p.startsWith("~") ? join(homedir(), p.slice(1)) : p);
}

export const DATA = envPath("VERIHARNESS_DATA", join(REPO, "data"));
export const RUNS = envPath("VERIHARNESS_RUNS", join(REPO, "runs"));
/** Staging directory for the graders' containers (bind-mounted, so it must be a real directory). */
export const TMP_DIR = envPath("VERIHARNESS_TMP", "/var/tmp");
/**
 * The pi agent runtime and its config live inside the harness directory because the jail
 * exposes exactly these two paths to the verifier (scripts/setup_pi.sh installs pi).
 */
export const PI_BIN = join(HARNESS_DIR, "vendor", "node_modules", ".bin", "pi");
export const PI_HOME = join(HARNESS_DIR, "pi-home");

export const BENCHES = ["apex", "wsb", "wb", "sb2", "jb"] as const;
export type Bench = (typeof BENCHES)[number];

/**
 * A lane is the verifier model. By default a pool is verified by the model that
 * generated it (the same-model setting), so lanes and pools share names.
 */
export const LANES: Record<string, string[]> = {
  flash: [
    "--provider",
    "google-vertex",
    "--model",
    "gemini-3.5-flash",
    "--thinking",
    "high",
  ],
  opus: [
    "--provider",
    "vertex-litellm",
    "--model",
    "claude-opus-4-8",
    "--thinking",
    "high",
  ],
};

/** Lanes served through the local litellm proxy (scripts/litellm_up.sh). */
export const PROXIED_LANES = ["opus"] as const;

/** The upstream benchmark checkout. Throws with instructions when unset. */
export function benchRoot(): string {
  const root = process.env.VERIHARNESS_BENCH_ROOT;
  if (!root) {
    throw new Error(
      "VERIHARNESS_BENCH_ROOT is not set: point it at the directory that" +
        " holds benchmarks/<name>/ (see README, 'Benchmarks').",
    );
  }
  return resolve(root.startsWith("~") ? join(homedir(), root.slice(1)) : root);
}
