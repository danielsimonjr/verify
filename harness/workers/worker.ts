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

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
import {
  claudeStreamStats,
  parseJsonDeliverable,
  piStreamStats,
  turnCounter,
  type DeliverableForm,
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
}

/** What a test replaces: the process runner and the delete of the temp copy. */
export interface WorkerDeps {
  run?: typeof run;
  rmrf?: (path: string) => void;
}

/** The command, stdin and environment of one worker. `home` is the pi home of a local model. */
export function workerArgs(job: WorkerJob, home: string): { cmd: string[]; input?: string; env: NodeJS.ProcessEnv } {
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
    "--no-session",
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
    message: job.prompt,
    continueSession: false,
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
function runError(r: RunResult, claude: boolean, finalText: string, overTurns: boolean): WorkerError {
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
  if (finalText.trim() === "") return "no-result";
  return null;
}

/** Run one worker in a temp copy of the batch and write its rollout. The copy is deleted in every case. */
export async function runWorker(job: WorkerJob, deps: WorkerDeps = {}): Promise<WorkerRecord> {
  const claude = isClaudeCodeProvider(job.model.provider);
  const out = join(job.batchDir, "rollouts", job.rollout);
  rmrf(out);
  mkdirSync(join(out, "trajectory"), { recursive: true });
  mkdirSync(join(out, "deliverables"), { recursive: true });

  const temp = mkdtempSync(join(tmpdir(), "vh-worker-"));
  try {
    const cwd = join(temp, "work");
    const home = join(temp, "pi-home");
    copyTree(join(job.batchDir, "spec"), join(cwd, "spec"));
    copyTree(join(job.batchDir, "workspace"), join(cwd, "workspace"));
    if (job.piProvider && !claude) materializePiHome(home, job.piProvider);

    const { cmd, input, env } = workerArgs(job, home);
    // Neither pi nor `claude -p` has a turn cap, so the worker counts turns in the live stream and stops
    // the session through its own signal, which the job's signal also trips.
    let overTurns = false;
    let signal = job.signal;
    let onStdout: ((chunk: Buffer) => void) | undefined;
    if (job.maxTurns !== undefined) {
      const cap = new AbortController();
      const maxTurns = job.maxTurns;
      const count = turnCounter(claude);
      signal = job.signal ? AbortSignal.any([job.signal, cap.signal]) : cap.signal;
      onStdout = (chunk) => {
        if (!overTurns && count(chunk) > maxTurns) {
          overTurns = true;
          cap.abort();
        }
      };
    }
    const started = Date.now();
    const r = await (deps.run ?? run)(cmd[0]!, cmd.slice(1), { input, timeoutMs: job.timeoutSec * 1000, cwd, env, signal, onStdout });
    const seconds = Math.round((Date.now() - started) / 1000);
    writeFileSync(join(out, "trajectory", "agent.jsonl"), r.stdout, "utf8");

    const stats = claude ? claudeStreamStats(r.stdout) : piStreamStats(r.stdout);
    let error = runError(r, claude, stats.finalText, overTurns);
    let form: DeliverableForm | null = null;
    if (error === null) {
      const target = join(out, "deliverables", job.deliverable);
      if (job.deliverable.toLowerCase().endsWith(".json")) {
        const parsed = parseJsonDeliverable(stats.finalText);
        if (parsed) {
          form = parsed.form;
          writeFileSync(target, JSON.stringify(parsed.value, null, 2) + "\n", "utf8");
        } else {
          error = "no-json";
          writeFileSync(`${target}.txt`, stats.finalText, "utf8");
        }
      } else {
        writeFileSync(target, stats.finalText, "utf8");
      }
    }
    const record: WorkerRecord = {
      rollout: job.rollout,
      exit: r.timedOut ? null : r.status,
      seconds,
      turns: stats.turns,
      tools: stats.tools,
      peakContext: stats.peakContext,
      outputTokens: stats.outputTokens,
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
