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
 * Child processes for the graders. The graders run inside `mapPool` workers, so a blocking
 * `spawnSync` would serialise the pool; and its timeout kills only the child's own pid, which
 * leaves the grandchildren (a judge's helper processes) running.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { timerDelay } from "../timer.js";

/** How {@link run} starts a process and when it stops it. Every run has a timeout. */
export type RunOptions = {
  input?: string;
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Most stdout bytes kept (default 256 MiB). More than that kills the process and sets `truncated`. */
  maxStdout?: number;
  /**
   * Runs when run() kills the process (the timeout, or stdout past `maxStdout`), besides the tree kill:
   * stop what the tree cannot reach (a container). The result waits for it, so a caller that exits on
   * the result does not cut the stop short.
   */
  onKill?: () => Promise<unknown>;
  /** How long a kill waits for the tree kill and onKill before run() returns anyway (default 10 s). */
  stopWaitMs?: number;
  /** Stops the run as the timeout does, and sets `aborted`. A signal that is already aborted stops it at once. */
  signal?: AbortSignal;
  /** Gets each stdout chunk as it arrives, before the result: a caller can watch a long run and stop it through `signal`. */
  onStdout?: (chunk: Buffer) => void;
};

/**
 * What {@link run} resolves with. A process that could not start sets `error`; a kill sets `timedOut` or
 * `truncated`.
 */
export type RunResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  /** The last 256 KiB. */
  stderr: string;
  /** Set when the process could not be started (ENOENT, EACCES, a bad argument). */
  error?: Error;
  timedOut: boolean;
  truncated: boolean;
  /** Set when `signal` stopped the run. */
  aborted?: boolean;
  timeoutMs: number;
};

const DEFAULT_MAX_STDOUT = 256 * 1024 * 1024;
const STDERR_KEEP = 256 * 1024;
const STOP_WAIT_MS = 10_000;

const live = new Set<ChildProcess>();
const forwarders = new Map<NodeJS.Signals, () => void>();
let exitHook = false;

/** POSIX: SIGKILL to the child's process group (the child leads one, see `detached` below). */
function killGroupNow(c: ChildProcess): void {
  if (c.pid === undefined) return;
  try {
    process.kill(-c.pid, "SIGKILL");
  } catch {
    try {
      c.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Kill the child and everything it started. */
async function killTree(c: ChildProcess): Promise<void> {
  if (c.pid === undefined) return;
  if (process.platform !== "win32") {
    killGroupNow(c);
    return;
  }
  await new Promise<void>((done) => {
    const k = spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    k.once("error", () => done());
    k.once("close", () => done());
  });
}

/**
 * A POSIX child leads its own process group so the whole tree can be killed. Such a child no
 * longer gets the terminal's Ctrl-C, so the signal is forwarded while any child is live.
 */
function track(c: ChildProcess): void {
  live.add(c);
  if (process.platform === "win32") return;
  if (!exitHook) {
    exitHook = true;
    process.on("exit", () => {
      for (const x of live) killGroupNow(x);
    });
  }
  if (forwarders.size) return;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const forward = () => {
      for (const x of live) killGroupNow(x);
      release();
      process.kill(process.pid, sig); // the default action, now that our handler is gone
    };
    forwarders.set(sig, forward);
    process.on(sig, forward);
  }
}

function release(): void {
  for (const [sig, f] of forwarders) process.removeListener(sig, f);
  forwarders.clear();
}

/** Resolves when `p` settles or after `ms`, whichever comes first. Leaves no timer behind. */
function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((done) => {
    const t = setTimeout(done, ms);
    void p.finally(() => {
      clearTimeout(t);
      done();
    });
  });
}

function untrack(c: ChildProcess): void {
  live.delete(c);
  if (!live.size) release();
}

/**
 * Runs `cmd` without blocking the event loop. The timeout and the stdout cap both kill the whole process tree and
 * run `onKill`. The promise never rejects: every failure is in the result.
 */
export function run(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const maxStdout = opts.maxStdout ?? DEFAULT_MAX_STDOUT;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let truncated = false;
    let aborted = false;
    let error: Error | undefined;
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    let stopTimer: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;
    let stopping: Promise<void> | undefined;
    const stopWaitMs = timerDelay(opts.stopWaitMs ?? STOP_WAIT_MS);

    const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(stopTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (child) untrack(child);
      const result: RunResult = {
        status,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        error,
        timedOut,
        truncated,
        ...(aborted ? { aborted } : {}),
        timeoutMs: opts.timeoutMs,
      };
      if (stopping) void stopping.then(() => resolve(result));
      else resolve(result);
    };

    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (e) {
      error = e as Error;
      finish(null, null);
      return;
    }
    const c = child;
    track(c);

    // The timeout and the stdout cap stop the run the same way. The child closes as soon as the tree
    // kill lands, which can be before onKill has stopped the container, so finish() waits for both,
    // up to stopWaitMs.
    const stop = (): void => {
      if (stopping) return;
      clearTimeout(timer);
      stopping = settleWithin(
        Promise.allSettled([killTree(c), Promise.resolve().then(() => opts.onKill?.())]),
        stopWaitMs,
      );
      // A process that survives the kill must not hold the caller for ever.
      stopTimer = setTimeout(() => finish(null, "SIGKILL"), stopWaitMs);
    };
    // A function declaration, so finish() can name it before the child starts.
    function onAbort(): void {
      if (finished) return;
      aborted = true;
      stop();
    }

    c.stdout!.on("data", (b: Buffer) => {
      if (truncated) return;
      out.push(b);
      outBytes += b.length;
      opts.onStdout?.(b);
      if (outBytes > maxStdout) {
        truncated = true;
        stop();
      }
    });
    c.stderr!.on("data", (b: Buffer) => {
      err.push(b);
      errBytes += b.length;
      while (err.length > 1 && errBytes - err[0]!.length >= STDERR_KEEP) errBytes -= err.shift()!.length;
    });
    c.stdin!.on("error", () => {
      /* the child exited before it read its input: its exit status says why */
    });
    c.stdin!.end(opts.input);

    c.once("error", (e) => {
      error = e;
      finish(null, null);
    });
    c.once("close", (status, signal) => finish(status, signal));

    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timerDelay(opts.timeoutMs));
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Why a run did not produce a result, in words. */
export function failureReason(r: RunResult): string {
  if (r.error) return r.error.message;
  if (r.timedOut) return `timed out after ${r.timeoutMs >= 1000 ? `${Math.round(r.timeoutMs / 1000)} s` : `${r.timeoutMs} ms`}`;
  if (r.truncated) return "output too large";
  if (r.signal) return `killed by ${r.signal}`;
  if (r.status !== 0) return `exit ${r.status}`;
  return "exit 0 without a result";
}

/** `label: reason: <tail of the output>`. Never empty, which a bare stderr tail can be. */
export function describeFailure(r: RunResult, label: string, tailChars = 800): string {
  const tail = (r.stderr || r.stdout).trim().slice(-tailChars);
  return tail ? `${label}: ${failureReason(r)}: ${tail}` : `${label}: ${failureReason(r)}`;
}
