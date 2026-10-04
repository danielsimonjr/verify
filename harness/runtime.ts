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

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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

/**
 * Every pid in `psTable` (lines of `pid ppid`) that descends from `root`, leaves first, so a
 * parent is never killed before the children it could still fork from.
 */
export function descendantsOf(root: number, psTable: string): number[] {
  const kids = new Map<number, number[]>();
  for (const line of psTable.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const list = kids.get(ppid);
    if (list) list.push(pid);
    else kids.set(ppid, [pid]);
  }
  const order: number[] = [];
  const seen = new Set<number>([root]);
  const walk = (parent: number): void => {
    for (const child of kids.get(parent) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      walk(child);
      order.push(child);
    }
  };
  walk(root);
  return order;
}

function signalQuietly(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone, or not ours to signal */
  }
}

/**
 * Kill `pid` and everything that descends from it, including descendants that left its
 * process group (setsid, `detached: true`). A group kill alone misses those on POSIX, and
 * Windows has no process groups at all, so `taskkill /T` follows the parent links instead.
 */
export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    const hit = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 15_000,
    });
    if (hit.status !== 0) signalQuietly(pid, "SIGKILL");
    return;
  }
  for (let pass = 0; pass < 3; pass++) {
    const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 10_000 });
    const below = ps.status === 0 ? descendantsOf(pid, ps.stdout) : [];
    for (const child of below) signalQuietly(child, "SIGKILL");
    signalQuietly(-pid, "SIGKILL");
    signalQuietly(pid, "SIGKILL");
    if (!below.length) break;
  }
}

export interface BudgetedRun {
  /** Exit code; null when the process was killed or never started. */
  code: number | null;
  timedOut: boolean;
  /** The last `stderrTailChars` characters of stderr. */
  stderr: string;
  /** Set when the process could not be started (missing binary, permission). */
  spawnError?: string;
}

export interface BudgetedRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  budgetMs: number;
  stderrTailChars?: number;
  /** Runs after the tree is killed, on every kill path (e.g. `docker rm -f` of a named container). */
  onKill?: () => void;
}

/** Node words a failed spawn as "spawn x ENOENT", Bun as "Executable not found"; keep the errno either way. */
function describeSpawnError(e: unknown): string {
  const code = (e as { code?: unknown }).code;
  const text = e instanceof Error ? e.message : String(e);
  return typeof code === "string" && !text.includes(code) ? `${code}: ${text}` : text;
}

/** setTimeout fires at once, with a warning, for a delay above this. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

const live = new Map<number, (() => void) | undefined>();
const signalHandlers = new Map<string, () => void>();

function killLive(): void {
  for (const [pid, onKill] of live) {
    killProcessTree(pid);
    try {
      onKill?.();
    } catch {
      /* the tree is dead; a failed container cleanup must not stop the rest */
    }
  }
  live.clear();
}

function hookLive(): void {
  if (signalHandlers.size) return;
  process.on("exit", killLive);
  for (const [name, code] of Object.entries(EXIT_CODES)) {
    const handler = (): void => {
      killLive();
      process.exit(code);
    };
    signalHandlers.set(name, handler);
    process.on(name as NodeJS.Signals, handler);
  }
}

function unhookLive(): void {
  if (live.size || !signalHandlers.size) return;
  process.removeListener("exit", killLive);
  for (const [name, handler] of signalHandlers) process.removeListener(name as NodeJS.Signals, handler);
  signalHandlers.clear();
}

/**
 * Run `cmd` for at most `budgetMs`, then kill its whole process tree. While it runs the
 * process is registered, so a driver that dies (signal, process.exit, uncaught error) takes
 * the turn down with it instead of leaving a model session running with no one to read it.
 */
export function runWithBudget(cmd: string[], opts: BudgetedRunOptions): Promise<BudgetedRun> {
  if (!(opts.budgetMs > 0)) {
    return Promise.reject(new RangeError(`budget must be a positive number of ms, got ${opts.budgetMs}`));
  }
  const tailChars = opts.stderrTailChars ?? 262_144;
  return new Promise((resolveRun) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd[0]!, cmd.slice(1), {
        cwd: opts.cwd,
        env: opts.env,
        // POSIX: a session of its own, so the group can be killed. Windows: not detached, so the
        // turn stays in the parent's job object and dies with it.
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (e) {
      resolveRun({ code: null, timedOut: false, stderr: "", spawnError: describeSpawnError(e) });
      return;
    }
    const pid = child.pid;
    if (pid !== undefined) {
      live.set(pid, opts.onKill);
      hookLive();
    }

    let stderr = "";
    let timedOut = false;
    let spawnError: string | undefined;
    let closeGrace: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const settle = (code: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(closeGrace);
      if (pid !== undefined) live.delete(pid);
      unhookLive();
      resolveRun({ code, timedOut, stderr, ...(spawnError === undefined ? {} : { spawnError }) });
    };

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-tailChars);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid !== undefined) killProcessTree(pid);
      try {
        opts.onKill?.();
      } catch {
        /* see killLive */
      }
      // 'close' waits for every holder of the stderr pipe. The tree is dead, but a process that
      // got away must not be able to hold the caller forever.
      closeGrace = setTimeout(() => {
        child.stderr?.destroy();
        settle(null);
      }, 5000);
    }, Math.min(opts.budgetMs, MAX_TIMER_MS));
    child.on("error", (err) => {
      spawnError = describeSpawnError(err);
      settle(null);
    });
    child.on("close", (code) => settle(code));
  });
}

export function python3(): string {
  const hit = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
    encoding: "utf8",
  });
  return hit.status === 0 && hit.stdout.trim() ? hit.stdout.trim() : "python3";
}
