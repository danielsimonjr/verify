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
 * One worker: one session on one batch, in a temp copy of the batch's `spec/` and `workspace/`, so a
 * worker sees no other worker's files. The session's event stream, its deliverable and its record go
 * to `rollouts/<rollout>/` of the batch. The temp copy is deleted whatever happens.
 */

import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSessionEnv, classifyFailure, claudeCommand, parseStream } from "../claude/index.js";
import { VERIFIER_SETTINGS } from "../claude/env.js";
import { claudeTools, isClaudeCodeProvider } from "../claude/provider.js";
import * as config from "../config.js";
import { agentEnv, piCommandFor, planPiCommand } from "../driver.js";
import { copyTree, rmrf } from "../fsutil.js";
import { run, type RunResult } from "../grade/proc.js";
import type { ContextSize } from "../model/config.js";
import { materializePiHome, type PiProviderRecord } from "../model/pi.js";
import { validateSchema } from "./schema.js";
import {
  claudeStreamStats,
  parseJsonDeliverable,
  piStreamStats,
  turnCounter,
  type DeliverableForm,
  type StreamStats,
  type WorkerError,
  type WorkerRecord,
} from "./record.js";

/** The model of a worker and its pi tuning options. */
export interface WorkerModel {
  provider: string;
  model: string;
  baseUrl?: string;
  contextSize?: ContextSize;
  temperature?: number;
  thinking?: string;
  maxTokens?: number;
}

/** One rollout to run: the batch, the rollout name, the prompt, the model and the limits. */
export interface WorkerJob {
  batchDir: string;
  rollout: string;
  /** 1 for the first run of the rollout, 2 for the first retry, and so on. */
  attempt?: number;
  /** Seconds the attempts before this one took; `totalSeconds` adds them to this attempt's own. */
  priorSeconds?: number;
  prompt: string;
  model: WorkerModel;
  /** pi tool names; a Claude Code worker gets the matching Claude Code tools. */
  tools: string;
  deliverable: string;
  timeoutSec: number;
  /** The pi provider of a local model, as prepareLocalProvider builds it. Absent for other providers. */
  piProvider?: PiProviderRecord;
  /** The command that starts pi or Claude Code (default: the vendored pi, or `claude`). */
  command?: readonly string[];
  /** Stops the session; its record then says `stopped`. */
  signal?: AbortSignal;
  /** Most assistant turns: a session that passes it is stopped and its record says `max-turns`. */
  maxTurns?: number;
  /** A JSON Schema the deliverable must fit; a parsed value that does not fit ends as `schema`. */
  schema?: unknown;
  /**
   * Seconds for one nudge turn. Set: a pi session that ends without an answer (a timeout, a turn of
   * thought alone, a cut, no JSON) is continued once with a short message that asks for the answer
   * now. The session is saved in the temp copy for that. Absent: no nudge, and `--no-session`.
   */
  nudgeTimeoutSec?: number;
  /** Accept a rollout whose agent compacted its context. Otherwise it ends as `compacted`. */
  allowCompaction?: boolean;
}

/** Why a session ended without an answer decides what the nudge says. */
const NUDGE_TIME = "Time is nearly up. Stop investigating and do not read any more files. Write your final answer now, from what you have found, in the format the task asked for, as the text of your next message.";
const NUDGE_CUT = "Your last message ended without an answer: it was cut off or held only thinking. Do not think further. Write your final answer now, in the format the task asked for, as the text of your next message.";
const NUDGE_FORMAT = "Your last message did not hold the answer in the format the task asked for. Write your final answer now, in that format, as the text of your next message.";

/** The nudge message for a session that ended with `error`, or null when a nudge cannot help. */
function nudgeFor(error: WorkerError): string | null {
  if (error === "timeout") return NUDGE_TIME;
  if (error === "length" || error === "thinking-only") return NUDGE_CUT;
  if (error === "no-result" || error === "no-json") return NUDGE_FORMAT;
  return null;
}

/** What a test replaces: the process runner and the delete of the temp copy. */
export interface WorkerDeps {
  run?: typeof run;
  rmrf?: (path: string) => void;
}

/** The command, stdin and environment of one worker. `home` is the pi home of a local model. */
export function workerArgs(
  job: WorkerJob,
  home: string,
  /** A nudge turn: the message and `-c`, in the session saved under `home`. Absent: the first turn, with the job's prompt. */
  nudge?: string,
): { cmd: string[]; input?: string; env: NodeJS.ProcessEnv } {
  if (isClaudeCodeProvider(job.model.provider)) {
    const cmd = [
      ...(job.command ?? claudeCommand(undefined)),
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      job.model.model,
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--settings",
      VERIFIER_SETTINGS,
      "--no-session-persistence",
      "--tools",
      claudeTools(job.tools),
      "--permission-mode",
      "bypassPermissions",
    ];
    return { cmd, input: job.prompt, env: { ...claudeSessionEnv(process.env), DISABLE_AUTOUPDATER: "1" } };
  }
  const flags = [
    "--no-context-files",
    "--no-extensions",
    "--no-prompt-templates",
    "--no-skills",
    // A job with a nudge saves its session in the temp copy, so the nudge can continue it.
    ...(job.nudgeTimeoutSec === undefined ? ["--no-session"] : ["--session-dir", join(home, "session")]),
    "--mode",
    "json",
    "--tools",
    job.tools,
    "--provider",
    job.piProvider?.id ?? job.model.provider,
    "--model",
    job.model.model,
    ...(job.model.thinking ? ["--thinking", job.model.thinking] : []),
  ];
  const plan = planPiCommand({
    piCommand: job.command ?? piCommandFor(config.PI_BIN),
    flags,
    message: nudge ?? job.prompt,
    continueSession: nudge !== undefined,
    canPipe: true,
    // canPipe: a message too long for the command line goes on stdin, so no file is written.
    writeFile: (name) => join(home, name),
  });
  const env = agentEnv(process.env);
  env.PI_CODING_AGENT_DIR = job.piProvider ? home : (env.PI_CODING_AGENT_DIR ?? config.PI_HOME);
  env.PI_SKIP_VERSION_CHECK ??= "1";
  return { cmd: plan.cmd, input: plan.input, env };
}

/** The error of a finished session, before its deliverable is read. `overTurns`: the turn cap stopped it. */
function runError(r: RunResult, claude: boolean, stats: StreamStats, overTurns: boolean): WorkerError {
  const finalText = stats.finalText;
  if (r.error) return "start-failed";
  if (r.aborted) return overTurns ? "max-turns" : "stopped";
  if (r.timedOut) return "timeout";
  if (r.truncated) return "truncated";
  if (claude) {
    // A limit is reported in the result event, which is an error result, so finalText does not hold it.
    const result = parseStream(r.stdout).result;
    if (r.status !== 0 && classifyFailure(`${result?.text ?? ""}\n${r.stderr}`) === "usage-limit") return "usage-limit";
    // As for a verifier turn: only exit 0 with a result that is not an error is an answer. Text from
    // before an error result is a stray sentence, not a deliverable.
    if (r.status !== 0 || !result || result.isError) return "no-result";
  }
  // The stream says why the last turn ended: output cut at the limit, or all of it spent on thought.
  if (stats.stopReason === "length") return "length";
  if (stats.thinkingOnly) return "thinking-only";
  if (finalText.trim() === "") return "no-result";
  return null;
}

/**
 * Empties a rollout folder before a run. A retry keeps `trajectory/attempt-N/`: those hold the streams of
 * the attempts before it, which the caller moved there. A first run keeps nothing, so a rollout never
 * shows files of an older run.
 */
function clearRollout(out: string, keepAttempts: boolean): void {
  if (!keepAttempts || !existsSync(out)) {
    rmrf(out);
    return;
  }
  for (const entry of readdirSync(out)) {
    if (entry !== "trajectory") rmrf(join(out, entry));
  }
  const trajectory = join(out, "trajectory");
  if (!existsSync(trajectory)) return;
  for (const entry of readdirSync(trajectory)) {
    if (!/^attempt-\d+$/.test(entry)) rmrf(join(trajectory, entry));
  }
}

/** Run one worker in a temp copy of the batch and write its rollout. The copy is deleted in every case. */
export async function runWorker(job: WorkerJob, deps: WorkerDeps = {}): Promise<WorkerRecord> {
  const claude = isClaudeCodeProvider(job.model.provider);
  const out = join(job.batchDir, "rollouts", job.rollout);
  clearRollout(out, (job.attempt ?? 1) > 1);
  mkdirSync(join(out, "trajectory"), { recursive: true });
  mkdirSync(join(out, "deliverables"), { recursive: true });

  const temp = mkdtempSync(join(tmpdir(), "vh-worker-"));
  try {
    const cwd = join(temp, "work");
    const home = join(temp, "pi-home");
    copyTree(join(job.batchDir, "spec"), join(cwd, "spec"));
    copyTree(join(job.batchDir, "workspace"), join(cwd, "workspace"));
    if (job.piProvider && !claude) materializePiHome(home, job.piProvider);

    // Neither pi nor `claude -p` has a turn cap, so the worker counts turns in the live stream and stops
    // the session through its own signal, which the job's signal also trips.
    let overTurns = false;
    let signal = job.signal;
    let overCap: ((chunk: Buffer) => void) | undefined;
    if (job.maxTurns !== undefined) {
      const cap = new AbortController();
      const maxTurns = job.maxTurns;
      const count = turnCounter(claude);
      signal = job.signal ? AbortSignal.any([job.signal, cap.signal]) : cap.signal;
      overCap = (chunk) => {
        if (!overTurns && count(chunk) > maxTurns) {
          overTurns = true;
          cap.abort();
        }
      };
    }
    // The event stream goes to agent.jsonl as it arrives, so a running worker can be watched. The
    // complete stdout replaces it at the end.
    const streamPath = join(out, "trajectory", "agent.jsonl");
    const isJson = job.deliverable.toLowerCase().endsWith(".json");
    const exec = async (nudge: string | undefined, timeoutSec: number): Promise<RunResult> => {
      const { cmd, input, env } = workerArgs(job, home, nudge);
      const live = openSync(streamPath, nudge === undefined ? "w" : "a");
      const onStdout = (chunk: Buffer): void => {
        writeSync(live, chunk);
        overCap?.(chunk);
      };
      try {
        return await (deps.run ?? run)(cmd[0]!, cmd.slice(1), { input, timeoutMs: timeoutSec * 1000, cwd, env, signal, onStdout });
      } finally {
        closeSync(live);
      }
    };
    /** What a finished session says: its numbers, its error, and the deliverable it parsed to. */
    const judge = (r: RunResult, stdout: string) => {
      const stats = claude ? claudeStreamStats(stdout) : piStreamStats(stdout);
      let error = runError(r, claude, stats, overTurns);
      let parsed: ReturnType<typeof parseJsonDeliverable> = null;
      if (error === null && isJson) {
        parsed = parseJsonDeliverable(stats.finalText);
        if (parsed === null) error = "no-json";
      }
      return { stats, error, parsed };
    };

    if (!claude) mkdirSync(join(home, "session"), { recursive: true });
    const started = Date.now();
    let r = await exec(undefined, job.timeoutSec);
    let stdout = r.stdout;
    let verdict = judge(r, stdout);
    // A session that ends without an answer is asked once for it, in the same session: a timeout or a
    // turn of thought alone otherwise throws away everything the worker found. Claude Code workers do not
    // save a session, so only pi workers get the nudge.
    let nudged = false;
    const message = job.nudgeTimeoutSec !== undefined && !claude && !overTurns && !r.aborted && !r.error ? nudgeFor(verdict.error) : null;
    if (message !== null) {
      nudged = true;
      r = await exec(message, job.nudgeTimeoutSec!);
      stdout += r.stdout;
      verdict = judge(r, stdout);
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    writeFileSync(streamPath, stdout, "utf8");

    const { stats, parsed } = verdict;
    let error = verdict.error;
    let form: DeliverableForm | null = null;
    const target = join(out, "deliverables", job.deliverable);
    // A session that ended without a deliverable still said something: keep the last text, so a
    // timeout or a cut does not lose what the worker had written.
    if (error !== null && error !== "start-failed" && stats.finalText.trim() !== "") {
      writeFileSync(error === "no-json" ? `${target}.txt` : `${target}.partial.txt`, stats.finalText, "utf8");
    }
    if (error === null) {
      if (parsed) {
        form = parsed.form;
        writeFileSync(target, JSON.stringify(parsed.value, null, 2) + "\n", "utf8");
        const problems = job.schema === undefined ? [] : validateSchema(parsed.value, job.schema);
        if (problems.length > 0) {
          error = "schema";
          writeFileSync(`${target}.schema-errors.txt`, problems.join("\n") + "\n", "utf8");
        }
      } else {
        writeFileSync(target, stats.finalText, "utf8");
      }
      // An answer from a context the agent compacted rests on turns it no longer held. The deliverable
      // is kept, and the rollout is not complete unless the job accepts compaction.
      if (error === null && stats.compactions > 0 && !job.allowCompaction) error = "compacted";
    }
    const record: WorkerRecord = {
      rollout: job.rollout,
      exit: r.timedOut ? null : r.status,
      seconds,
      totalSeconds: (job.priorSeconds ?? 0) + seconds,
      turns: stats.turns,
      tools: stats.tools,
      peakContext: stats.peakContext,
      outputTokens: stats.outputTokens,
      compactions: stats.compactions,
      toolErrors: stats.toolErrors,
      nudged,
      attempts: job.attempt ?? 1,
      form,
      error,
    };
    writeFileSync(join(out, "trajectory", "worker.json"), JSON.stringify(record) + "\n", "utf8");
    return record;
  } finally {
    // The record is already on disk: a temp copy that will not go must not turn it into an error.
    try {
      (deps.rmrf ?? rmrf)(temp);
    } catch (err) {
      process.stderr.write(`workers: could not delete ${temp}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}
