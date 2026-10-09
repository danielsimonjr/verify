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
import { homedir, tmpdir } from "node:os";
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
export function findRepoRoot(from: string): string {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
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
/**
 * Staging directory for the graders' containers (bind-mounted, so it must be a real directory).
 * `/var/tmp` where it exists; elsewhere (native Windows) the operating system's temporary directory.
 */
export function defaultTmpDir(varTmpExists: boolean = existsSync("/var/tmp"), osTmp: string = tmpdir()): string {
  return varTmpExists ? "/var/tmp" : osTmp;
}
export const TMP_DIR = envPath("VERIHARNESS_TMP", defaultTmpDir());
/**
 * The pi agent runtime and its config live inside the harness directory because the jail
 * exposes exactly these two paths to the verifier (scripts/setup_pi.sh installs pi).
 */
export const PI_BIN = join(HARNESS_DIR, "vendor", "node_modules", ".bin", "pi");
/** pi's entry script: what `.bin/pi` runs. On Windows `.bin/pi` is a POSIX shell script, so the driver runs this with Node. */
export const PI_CLI_JS = join(
  HARNESS_DIR,
  "vendor",
  "node_modules",
  "@danielsimonjr",
  "pi",
  "dist",
  "bundle",
  "cli.js",
);
export const PI_HOME = join(HARNESS_DIR, "pi-home");

export const BENCHES = ["apex", "wsb", "wb", "sb2", "jb"] as const;
export type Bench = (typeof BENCHES)[number];

/**
 * A lane is the verifier model. By default a pool is verified by the model that
 * generated it (the same-model setting), so lanes and pools share names.
 */
export const LANES: Record<string, string[]> = {
  // Every lane runs through Claude Code (docs/claude-code.md). Full model ids, not aliases,
  // so a run stays reproducible when an alias moves to a newer model.
  fable: ["--provider", "claude-code", "--model", "claude-fable-5-1"],
  opus: ["--provider", "claude-code", "--model", "claude-opus-5-5"],
  haiku: ["--provider", "claude-code", "--model", "claude-haiku-5-5"],
  sonnet: ["--provider", "claude-code", "--model", "claude-sonnet-5-5"],
};

/**
 * Context window, in tokens, of each Claude model a lane runs. Claude Code reports no window before a
 * run, so `--context-size auto` reads this table. Source: Anthropic's model overview,
 * https://platform.claude.com/docs/en/about-claude/models/overview
 */
export const CLAUDE_CODE_WINDOWS: Readonly<Record<string, number>> = {
  "claude-fable-5-1": 1_000_000,
  "claude-opus-5-5": 1_000_000,
  "claude-haiku-5-5": 1_000_000,
  "claude-sonnet-5-5": 1_000_000,
};

/** The table window of a Claude model id, or undefined. Inherited keys such as `constructor` are not ids. */
export function claudeCodeWindow(model: string): number | undefined {
  return Object.hasOwn(CLAUDE_CODE_WINDOWS, model) ? CLAUDE_CODE_WINDOWS[model] : undefined;
}

/**
 * The lane that checks a pool whose name is not a lane. The archived `flash` pools hold Gemini 3.5 Flash
 * rollouts; no lane runs Gemini, so the `fable` lane checks them. `--lane` overrides this.
 */
export const POOL_LANES: Record<string, string> = { flash: "fable" };

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
