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
import { closeSync, existsSync, openSync, realpathSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { timerDelay } from "./timer.js";

export const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/**
 * True when the module at `metaUrl` is the program's entry file.
 *
 * Node sets `import.meta.url` to the real path of the entry but leaves `process.argv[1]` as the path
 * it was started with. `npm i -g` links the bin, so both sides go through `realpathSync.native`:
 * that follows links and gives one spelling of a Windows path whatever case the shell passed.
 * `argv1` is a parameter so a test can name the link.
 */
export function isMain(metaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return realpathSync.native(fileURLToPath(metaUrl)) === realpathSync.native(resolve(argv1));
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

/**
 * Seconds between the progress lines of a running turn: `VERIHARNESS_PROGRESS_SEC`, else 60. A model
 * turn can run for many minutes and writes nothing to driver.log meanwhile; the line says it is alive.
 */
export function progressIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const sec = Number(env.VERIHARNESS_PROGRESS_SEC);
  return sec > 0 ? Math.round(sec * 1000) : 60_000;
}

export interface BudgetedRun {
  /** Exit code; null when the process was killed or never started. */
  code: number | null;
  timedOut: boolean;
  /** The last `stderrTailChars` characters of stderr. */
  stderr: string;
  /** True when stderr was longer than `stderrTailChars` and its start was dropped. */
  stderrCut: boolean;
  /** Set when the process could not be started (missing binary, permission). */
  spawnError?: string;
}

export interface BudgetedRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  budgetMs: number;
  stderrTailChars?: number;
  /** Text written to the child's stdin, which is then closed. Absent: stdin is closed at once. */
  input?: string;
  /** Append the child's stdout to this file, with no copy in memory. Absent: stdout is discarded. */
  stdoutFile?: string;
  /** Runs after the tree is killed, on every kill path (e.g. `docker rm -f` of a named container). */
  onKill?: () => void;
  /** With `onHeartbeat`: call it every `heartbeatMs` ms while the process runs, with the elapsed ms. */
  heartbeatMs?: number;
  onHeartbeat?: (elapsedMs: number) => void;
}

/** Node words a failed spawn as "spawn x ENOENT", Bun as "Executable not found"; keep the errno either way. */
function describeSpawnError(e: unknown): string {
  const code = (e as { code?: unknown }).code;
  const text = e instanceof Error ? e.message : String(e);
  return typeof code === "string" && !text.includes(code) ? `${code}: ${text}` : text;
}

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
    let outFd: number | undefined;
    if (opts.stdoutFile !== undefined) {
      try {
        outFd = openSync(opts.stdoutFile, "a");
      } catch (e) {
        resolveRun({
          code: null,
          timedOut: false,
          stderr: "",
          stderrCut: false,
          spawnError: `cannot open ${opts.stdoutFile}: ${describeSpawnError(e)}`,
        });
        return;
      }
    }
    let child: ChildProcess;
    try {
      child = spawn(cmd[0]!, cmd.slice(1), {
        cwd: opts.cwd,
        env: opts.env,
        // POSIX: a session of its own, so the group can be killed. Windows: not detached, so the
        // turn stays in the parent's job object and dies with it.
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: [opts.input === undefined ? "ignore" : "pipe", outFd ?? "ignore", "pipe"],
      });
    } catch (e) {
      resolveRun({ code: null, timedOut: false, stderr: "", stderrCut: false, spawnError: describeSpawnError(e) });
      return;
    } finally {
      // The child holds its own copy of the descriptor; keeping ours open would leak one per turn.
      if (outFd !== undefined) closeSync(outFd);
    }
    if (opts.input !== undefined) {
      // A child that exits without reading its stdin closes the pipe: that is its answer, not an error here.
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts.input);
    }
    const pid = child.pid;
    if (pid !== undefined) {
      live.set(pid, opts.onKill);
      hookLive();
    }

    let stderr = "";
    let stderrCut = false;
    const decoder = new StringDecoder("utf8");
    let timedOut = false;
    let spawnError: string | undefined;
    let closeGrace: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    let beat: ReturnType<typeof setInterval> | undefined;
    const settle = (code: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(beat);
      clearTimeout(closeGrace);
      if (pid !== undefined) live.delete(pid);
      unhookLive();
      resolveRun({ code, timedOut, stderr, stderrCut, ...(spawnError === undefined ? {} : { spawnError }) });
    };

    // A StringDecoder keeps a multi-byte character that a chunk boundary splits; toString() per chunk
    // turned each half into U+FFFD. The buffer is trimmed only when it is over the cap, so a long-running
    // child cannot grow it, and `stderrCut` tells the caller the start is gone.
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += decoder.write(chunk);
      if (stderr.length > tailChars) {
        stderr = stderr.slice(-tailChars);
        stderrCut = true;
      }
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
    }, timerDelay(opts.budgetMs));
    const began = Date.now();
    if (beat === undefined && opts.heartbeatMs !== undefined && opts.onHeartbeat !== undefined) {
      beat = setInterval(() => {
        try {
          opts.onHeartbeat!(Date.now() - began);
        } catch {
          /* a failed progress line must not end the turn */
        }
      }, opts.heartbeatMs);
    }
    child.on("error", (err) => {
      spawnError = describeSpawnError(err);
      settle(null);
    });
    child.on("close", (code) => settle(code));
  });
}

// Python 3 only: a bare `python` is Python 2 on some hosts, and that must not pass for a grader's interpreter.
const PYTHON_PROBE = "import sys; assert sys.version_info[0] >= 3; print(sys.executable)";
// `python3` is a Microsoft Store stub on many Windows hosts (it exits 9009), so the next names matter there.
const PYTHON_NAMES: readonly (readonly string[])[] = [["python3"], ["python"], ["py", "-3"]];
const PYTHON_PROBE_MS = 15_000;

/**
 * Builds a function that finds a working Python 3 interpreter: the first of `python3`, `python`,
 * `py -3` whose probe exits 0 and prints its path. The path is remembered once found. A miss is not
 * remembered, so an interpreter installed later is picked up. With none, the answer is `"python3"`
 * and the caller's own spawn names what is missing. `run` is a parameter so a test can fake the host.
 */
export function pythonFinder(run: typeof spawnSync = spawnSync): () => string {
  let found: string | undefined;
  return () => {
    if (found !== undefined) return found;
    for (const [cmd, ...pre] of PYTHON_NAMES) {
      const hit = run(cmd!, [...pre, "-c", PYTHON_PROBE], {
        encoding: "utf8",
        timeout: PYTHON_PROBE_MS,
        windowsHide: true,
      });
      const exe = hit.status === 0 ? String(hit.stdout).trim() : "";
      if (exe) return (found = exe);
    }
    return "python3";
  };
}

/** Path of a working Python 3 interpreter, as found by {@link pythonFinder}. */
export const python3: () => string = pythonFinder();
