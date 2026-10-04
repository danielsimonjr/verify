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

import { spawn } from "node:child_process";
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

const DOCKER = ["docker"];
const BUILD_TIMEOUT_MS = 1_800_000;
const STDERR_TAIL = 4096;

interface DockerResult {
  status: number | null;
  stderr: string;
}

/**
 * Run `docker <args>` and collect the tail of its stderr. The child runs asynchronously: a
 * blocking spawn would hold the event loop for the whole build, so mapPool could not start
 * another image. A run past `timeoutMs` is killed and reported as timed out.
 */
function runDocker(
  docker: string[],
  args: string[],
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<DockerResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let tail = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: DockerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(docker[0]!, [...docker.slice(1), ...args], {
      stdio: [opts.input === undefined ? "ignore" : "pipe", "ignore", "pipe"],
    });
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, opts.timeoutMs);
    }
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      tail = (tail + chunk).slice(-STDERR_TAIL);
    });
    if (opts.input !== undefined) {
      child.stdin!.on("error", () => {}); // docker may exit before it reads the Dockerfile
      child.stdin!.end(opts.input);
    }
    child.once("error", (e) => finish({ status: null, stderr: e.message }));
    child.once("close", (status) =>
      finish({ status, stderr: timedOut ? `timed out after ${opts.timeoutMs}ms` : tail }),
    );
  });
}

async function imageExists(tag: string, docker: string[]): Promise<boolean> {
  return (await runDocker(docker, ["image", "inspect", tag])).status === 0;
}

async function build(base: string, docker: string[], timeoutMs: number): Promise<string> {
  const tag = derivedName(base);
  if (await imageExists(tag, docker)) return `${tag}: exists`;
  const r = await runDocker(docker, ["build", "-q", "-t", tag, "-"], {
    input: DOCKERFILE(base, STACK),
    timeoutMs,
  });
  if (r.status === 0) return `${tag}: ok`;
  return `${tag}: FAILED ${r.stderr.slice(-200)}`;
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

/**
 * Build `vh/<name>` for each base image, up to `jobs` at a time, and return one result line per
 * base in input order. `docker` is the command prefix; tests pass a stub.
 */
export function deriveImages(
  bases: string[],
  jobs: number,
  docker: string[] = DOCKER,
  timeoutMs = BUILD_TIMEOUT_MS,
): Promise<string[]> {
  return mapPool(bases, jobs, (base) => build(base, docker, timeoutMs));
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let jobs = 8;
  const only: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--jobs") {
      // parseInt("abc") is NaN: mapPool then starts no workers and the run builds nothing.
      const raw = argv[++i];
      if (raw === undefined || !/^\d+$/.test(raw.trim()) || Number(raw) < 1) {
        process.stderr.write(`error: --jobs must be an integer of at least 1, got '${raw ?? ""}'\n`);
        return 2;
      }
      jobs = Number(raw);
    } else if (argv[i] === "--only") {
      while (argv[i + 1] && !argv[i + 1]!.startsWith("-")) only.push(argv[++i]!);
    }
  }
  let bases = collectBases();
  if (only.length) bases = bases.filter((b) => only.includes(b));
  const lines = await deriveImages(bases, jobs);
  for (const line of lines) console.log(line);
  return 0;
}

if (isMain(import.meta.url)) {
  main().then((c) => process.exit(c));
}
