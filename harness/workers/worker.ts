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

import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSessionEnv, classifyFailure, claudeCommand, parseStream } from "../claude/index.js";
import { VERIFIER_SETTINGS } from "../claude/env.js";
import { claudeTools, isClaudeCodeProvider } from "../claude/provider.js";
import * as config from "../config.js";
import { agentEnv, piCommandFor, planPiCommand } from "../driver.js";
import { piTools as realPiTools, type PiTools } from "../model/pitools.js";
import { ANSWER_SHAPE_ENV, runawayOf, type AnswerShape, type Runaway } from "../pi-extensions/repeat-guard.js";
import { copyTree, rmrf } from "../fsutil.js";
import { run, type RunResult } from "../grade/proc.js";
import type { ContextSize } from "../model/config.js";
import { materializePiHome, type PiProviderRecord } from "../model/pi.js";
import type { ModelIdentity } from "../model/types.js";
import { validateSchema } from "./schema.js";
import {
  claudeStreamStats,
  ABORT_MESSAGE,
  jsonProblem,
  openMessageKind,
  parseJsonDeliverable,
  piStreamStats,
  textCallOf,
  turnCounter,
  type DeliverableForm,
  type StreamStats,
  type TextCall,
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
  frequencyPenalty?: number;
  thinking?: string;
  maxTokens?: number;
  /** The weights the name stood for when the run began; the worker's record carries it. */
  identity?: ModelIdentity;
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
   * The ids the deliverable must cover: the records of its array `array` each have an id in `field`, and
   * those ids are `expected`, each once. A deliverable that fits the schema and does not ends as `ids`.
   */
  ids?: WorkerIds;
  /**
   * Seconds for one nudge turn. Set: a pi session that ends without an answer (a timeout, a turn of
   * thought alone, a cut, no JSON) is continued once with a short message that asks for the answer
   * now. The session is saved in the temp copy for that. Absent: no nudge, and `--no-session`.
   */
  nudgeTimeoutSec?: number;
  /** Accept a rollout whose agent compacted its context. Otherwise it ends as `compacted`. */
  allowCompaction?: boolean;
}

/** Where a deliverable holds the ids of its records, and the ids it must hold. */
export interface WorkerIds {
  array: string;
  field: string;
  expected: readonly string[];
}

/** Most ids one error line names: a longer list would bury the line, and the nudge. */
const IDS_LISTED = 12;

/**
 * Tokens that one record of an answer may take, and tokens for the rest of the message (the braces, a
 * fence, a line of prose). The longest record that a model was measured to write took 378 tokens (107
 * records of run 7), so this is the room of about 2.7 of them. It is a bound for a runaway, not an aim.
 */
export const ANSWER_TOKENS_PER_RECORD = 1024;
export const ANSWER_OVERHEAD_TOKENS = 1024;
/**
 * The least that the limit is cut to. The limit is the one of every turn of the session, not only of the
 * answer: a batch of one record would otherwise leave a model 2048 tokens for each turn, and the
 * summary that pi writes when it compacts is cut to the limit too.
 */
export const ANSWER_MIN_TOKENS = 4096;

/** The most output tokens that an answer of `records` records needs. */
export function answerCap(records: number): number {
  return Math.max(ANSWER_MIN_TOKENS, records * ANSWER_TOKENS_PER_RECORD + ANSWER_OVERHEAD_TOKENS);
}

/**
 * The pi provider of a job with the output limit of its model cut to the answer that its batch needs.
 * Without it the limit is the default of the provider (8192 tokens), so a model that loops on one record
 * writes for most of a turn before the limit ends it, and a context that has few tokens left is spent
 * on the loop. The limit of the user is the user's: a job whose model has `maxTokens` keeps the
 * provider as it is built, and the cap never raises a limit. A job that asks the model to think keeps it
 * too: the thought is output, and its size does not follow the size of the answer.
 */
function withAnswerCap(job: WorkerJob): PiProviderRecord | undefined {
  const provider = job.piProvider;
  if (provider === undefined || job.ids === undefined || job.model.maxTokens !== undefined || job.model.thinking) return provider;
  const models = provider.config.models;
  if (!Array.isArray(models)) return provider;
  const cap = answerCap(job.ids.expected.length);
  const capped = models.map((m: unknown) => {
    if (m === null || typeof m !== "object") return m;
    const have = (m as { maxTokens?: unknown }).maxTokens;
    return { ...(m as object), maxTokens: typeof have === "number" ? Math.min(have, cap) : cap };
  });
  return { ...provider, config: { ...provider.config, models: capped } };
}

/** Ids for a message to the model: the first IDS_LISTED, then how many more. */
function showIds(xs: readonly string[]): string {
  return xs.slice(0, IDS_LISTED).join(", ") + (xs.length > IDS_LISTED ? ` (and ${xs.length - IDS_LISTED} more)` : "");
}

/** The errors of the ids of a deliverable against the ids of its batch; none when they are the same set. */
function idProblems(value: unknown, ids: WorkerIds): string[] {
  const list = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[ids.array] : undefined;
  if (!Array.isArray(list)) return [`$.${ids.array}: the deliverable has no array '${ids.array}'`];
  const seen = new Map<string, number>();
  let without = 0;
  for (const record of list) {
    const raw = record !== null && typeof record === "object" ? (record as Record<string, unknown>)[ids.field] : undefined;
    if (typeof raw !== "string" && typeof raw !== "number") {
      without++;
      continue;
    }
    seen.set(String(raw), (seen.get(String(raw)) ?? 0) + 1);
  }
  const expected = new Set(ids.expected);
  const missing = ids.expected.filter((id) => !seen.has(id));
  const extra = [...seen.keys()].filter((id) => !expected.has(id));
  const repeated = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  const out: string[] = [];
  if (without > 0) out.push(`${without} record(s) of '${ids.array}' have no '${ids.field}' that is a string or a number`);
  if (missing.length > 0) out.push(`ids missing from ${ids.array}: ${showIds(missing)}`);
  if (extra.length > 0) out.push(`ids not in the batch: ${showIds(extra)}`);
  if (repeated.length > 0) out.push(`ids repeated: ${showIds(repeated)}`);
  if (out.length > 0) out.push(`the batch has ${ids.expected.length} ids: ${showIds([...ids.expected])}`);
  return out;
}

/** Why a session ended without an answer decides what the nudge says. */
const NUDGE_TIME = "Time is nearly up. Stop investigating and do not read any more files. Write your final answer now, from what you have found, in the format the task asked for, as the text of your next message.";
const NUDGE_CUT = "Your last message ended without an answer: it was cut off or held only thinking. Do not think further. Write your final answer now, in the format the task asked for, as the text of your next message.";
const NUDGE_FORMAT = "Your last message did not hold the answer in the format the task asked for. Write your final answer now, in that format, as the text of your next message.";
const NUDGE_STUCK = "Your tool calls failed or repeated an earlier call, so no tool is offered now. Write your final answer now, from what you have found, in the format the task asked for, as the text of your next message.";

/**
 * The nudge for a message that the guard of the session cut, with what the guard saw. The model that is
 * only told that its message "was cut off" writes the same message again.
 */
function cutBy(runaway: Runaway, ids: WorkerIds | undefined): string {
  if (runaway.kind === "records") {
    const batch = ids === undefined ? `${runaway.allowed} ids` : `${runaway.allowed} ids: ${showIds(ids.expected)}`;
    return (
      `Your last message was stopped because it held ${runaway.found} records, and the batch has ${batch}. ` +
      "Write your final answer once, with one record for each id and each id once, as the text of your next message."
    );
  }
  if (runaway.kind === "calls") {
    return (
      `Your last message was stopped because it wrote ${runaway.found} tool calls as text. A message holds one call. ` +
      "Write your final answer once, in the format the task asked for, as the text of your next message."
    );
  }
  return (
    "Your last message was stopped because it wrote the same text again and again. " +
    "Write your final answer once, in the format the task asked for, as the text of your next message."
  );
}

/**
 * The errors of a session whose last message can be a call that did not run: no error (the text parsed to
 * something that is not an answer), text that is not JSON, a session that made no call, and a message that
 * the guard cut because it wrote several calls.
 */
const ANSWER_ERRORS: ReadonlySet<WorkerError | null> = new Set<WorkerError | null>([null, "no-json", "no-tool-calls", "length"]);

/** Most errors a nudge lists: a model that was given more would lose the first ones. */
const NUDGE_LISTED = 8;

/** The message that sends an answer back with a list of what is wrong in it. */
function nudgeList(heading: string, problems: readonly string[]): string {
  const shown = problems.slice(0, NUDGE_LISTED).map((p) => `- ${p.slice(0, 200)}`);
  const more = problems.length - shown.length;
  return [
    heading,
    ...shown,
    ...(more > 0 ? [`(and ${more} more)`] : []),
    "Write the corrected answer now, as the text of your next message, and nothing else.",
  ].join("\n");
}

/**
 * The nudge for a message that wrote a tool call as text. The model meant to call a tool, and the call did
 * not run; it is told that, and why, and asked for the call again. It is not told that its answer is wrong:
 * it gave none.
 */
function callNudge(call: TextCall): string {
  let head: string;
  const why: string[] = [];
  if (call.calls > 1) {
    head = `Your last message wrote ${call.calls} tool calls as text, and no tool ran.`;
    why.push("A message holds one call.");
  } else {
    head = `Your last message wrote a call to the ${call.tool} tool as text, and the tool did not run.`;
    if (call.around) why.push("The call has other text around it.");
  }
  if (call.problem !== null) why.push(`The call is not valid JSON: ${call.problem}`);
  return [
    head,
    ...why.map((w) => `- ${w.slice(0, 300)}`),
    `Make one call now. Write only the JSON object {"name": "${call.tool}", "parameters": {...}} as your whole message. ` +
      "Use JSON values in the arguments: strings in double quotes, numbers, true, false, null.",
  ].join("\n");
}

/** The ways an answer can fail that a nudge can put right. A session is sent back once for each. */
type NudgeKind = "time" | "cut" | "format" | "json" | "schema" | "ids" | "stuck" | "call";

/**
 * The nudge for a session that ended with `error`, or null when a nudge cannot help.
 * `problems`: what the schema or the ids check found in an answer that parsed.
 */
function nudgeFor(error: WorkerError, problems: readonly string[] = [], cut: string | null = null): { kind: NudgeKind; message: string } | null {
  if (error === "timeout") return { kind: "time", message: NUDGE_TIME };
  if (error === "length" && cut !== null) return { kind: "cut", message: cut };
  if (error === "length" || error === "thinking-only") return { kind: "cut", message: NUDGE_CUT };
  if (error === "stuck") return { kind: "stuck", message: NUDGE_STUCK };
  // A JSON that stops being JSON at a place is sent back with the place and the rule; without a JSON in
  // it, the answer is only said to be in the wrong format.
  if (error === "no-json" && problems.length > 0) {
    return { kind: "json", message: nudgeList("Your answer is not valid JSON:", problems) };
  }
  if (error === "no-result" || error === "no-json") return { kind: "format", message: NUDGE_FORMAT };
  if ((error === "schema" || error === "ids") && problems.length > 0) {
    return { kind: error, message: nudgeList("Your answer does not fit the format the task asked for:", problems) };
  }
  return null;
}

/** What a test replaces: the process runner and the delete of the temp copy. */
export interface WorkerDeps {
  run?: typeof run;
  rmrf?: (path: string) => void;
  /** Provides the binaries behind pi's `find` and `grep` (default: the harness's own, which downloads them once). */
  piTools?: PiTools;
}

/** The pi extension that blocks a repeated tool call. Pi loads TypeScript, so the source file is the one it is given. */
const REPEAT_GUARD = join(config.HARNESS_DIR, "pi-extensions", "repeat-guard.ts");

/** What a pi worker is told about its directory, in place of pi's default system prompt. */
export const WORKER_CHARTER = [
  "You are a worker. Your task is in the current directory.",
  "",
  "- `spec/task.md` is the task. Read it first.",
  "- `workspace/` holds the task inputs. Read from it. Do not change it.",
  "- Use only the tools you are given. Call each tool with its own parameters.",
  "- Make one tool call in each message. Read its result before you make the next call.",
  "- Every path is relative to the current directory. Do not use an absolute path.",
  "- When the task asks for a final answer in a given format, your final message is that answer and nothing else.",
  "",
].join("\n");

/**
 * The charter of one job. A job with a schema states it here: the charter is the one text that every
 * turn and every compaction keeps, so a model that has lost the task text still has the format. A job
 * with `ids` states the ids of its batch the same way: a model that is not told them has used the
 * number of the record in its list, or a line number from another file of the task.
 */
export function workerCharter(schema?: unknown, ids?: WorkerIds): string {
  if (schema === undefined && ids === undefined) return WORKER_CHARTER;
  const parts = [WORKER_CHARTER];
  if (schema !== undefined) {
    parts.push("Your final message is one JSON value that fits this JSON Schema, and nothing else:", "", "```json", JSON.stringify(schema, null, 2), "```", "");
  }
  if (ids !== undefined) {
    parts.push(
      `In your final message, \`${ids.array}\` has one record for each of these ids, and no other record. The \`${ids.field}\` of a record is its id. Use each id once:`,
      "",
      ids.expected.join(", "),
      "",
    );
  }
  return parts.join("\n");
}

/** The command, stdin and environment of one worker. `home` is the pi home of a local model. */
export function workerArgs(
  job: WorkerJob,
  home: string,
  /** A nudge turn: the message and `-c`, in the session saved under `home`. Absent: the first turn, with the job's prompt. */
  nudge?: string,
  /** A nudge turn that offers the tools: the nudge asks for a tool call, which a turn with none cannot make. */
  withTools = false,
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
    // The one extension a worker loads. It blocks a call that repeats an earlier call of the session, and it
    // cuts a runaway message. A nudge turn has no tools to guard, but its answer can be a runaway too.
    "-e",
    REPEAT_GUARD,
    "--no-prompt-templates",
    "--no-skills",
    // pi's default prompt names the pi docs under the harness checkout; a model takes that path for the
    // task's own and prefixes every file it reads with it.
    "--system-prompt",
    workerCharter(job.schema, job.ids),
    // A job with a nudge saves its session in the temp copy, so the nudge can continue it.
    ...(job.nudgeTimeoutSec === undefined ? ["--no-session"] : ["--session-dir", join(home, "session")]),
    "--mode",
    "json",
    // A nudge asks for the answer, and a model that is offered tools is told by some chat templates
    // (llama3.1's) to answer with a function call. The first turn keeps the tools, and so does the nudge
    // that asks for a call that did not run.
    ...(nudge === undefined || withTools ? ["--tools", job.tools] : ["--no-tools"]),
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
  // The guard needs the id field, the item count and the name of the list: it cuts a message that has more
  // records than the batch has items, and it knows a tool call that holds the answer.
  const shape = answerShapeOf(job);
  if (shape !== undefined) env[ANSWER_SHAPE_ENV] = JSON.stringify(shape);
  return { cmd: plan.cmd, input: plan.input, env };
}

/** What the guard is told about the answer: the field of the id, the number of items and the list of records. */
function answerShapeOf(job: WorkerJob): AnswerShape | undefined {
  if (job.ids === undefined) return undefined;
  return { idField: job.ids.field, records: job.ids.expected.length, listField: job.ids.array };
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
  // A session that ends in its tool calls has not answered: the guard of the session stopped it after tool
  // calls that failed in a row (pi-extensions/repeat-guard.ts), or the agent loop ended on a call. What
  // the model needs is a turn with no tools, which is not what a cut message needs, so it has its own kind.
  if (!claude && stats.stoppedInTools) return "stuck";
  // The stream says why the last turn ended: output cut at the limit, or all of it spent on thought. A turn
  // that ends `aborted` with text was cut by the runaway guard of the session: a message that was on its
  // way to the limit, so it is the same failure, found sooner.
  if (stats.stopReason === "length" || stats.stopReason === "aborted") return "length";
  if (stats.thinkingOnly) return "thinking-only";
  if (finalText.trim() === "") return "no-result";
  return null;
}

/** The newest `.jsonl` file under `dir`, or null. */
function newestSessionFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  let best: { file: string; mtime: number } | null = null;
  for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
    if (!entry.endsWith(".jsonl")) continue;
    const file = join(dir, entry);
    const mtime = statSync(file).mtimeMs;
    if (best === null || mtime > best.mtime) best = { file, mtime };
  }
  return best?.file ?? null;
}

/**
 * Removes the last message of a saved pi session when it holds no answer to continue from: its output was
 * cut at the limit, the runaway guard aborted it, or it is the empty turn that an abort ended after a tool
 * result. A nudge continues that session. A message cut at the limit is a runaway more often than a near
 * answer (one row written 129 times), so carrying it makes the model read its own loop again and spends
 * the window. The event stream keeps the message: the stream is the record, the session is the context.
 * Returns true when a message was removed.
 */
export function dropCutReply(sessionDir: string): boolean {
  const file = newestSessionFile(sessionDir);
  if (file === null) return false;
  const lines = readFileSync(file, "utf8").split("\n");
  let last = lines.length - 1;
  while (last >= 0 && lines[last]!.trim() === "") last--;
  if (last < 0) return false;
  let entry: { type?: unknown; message?: { role?: unknown; stopReason?: unknown; content?: unknown; errorMessage?: unknown } };
  try {
    entry = JSON.parse(lines[last]!);
  } catch {
    return false;
  }
  const stop = entry.message?.stopReason;
  const emptyAbort =
    stop === "error" &&
    Array.isArray(entry.message?.content) &&
    entry.message.content.length === 0 &&
    ABORT_MESSAGE.test(typeof entry.message.errorMessage === "string" ? entry.message.errorMessage : "");
  if (entry.type !== "message" || entry.message?.role !== "assistant" || (stop !== "length" && stop !== "aborted" && !emptyAbort)) return false;
  lines.splice(last, 1);
  writeFileSync(file, lines.join("\n"), "utf8");
  return true;
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
    const provider = withAnswerCap(job);
    if (provider && !claude) materializePiHome(home, provider);
    // pi downloads the binary of `find` and `grep` on first use and its parallel tool calls race on that
    // download, so the harness provides them first and offers only the tools that can run.
    let offered = job;
    let dropped: string[] = [];
    if (!claude) {
      const piTools = deps.piTools ?? realPiTools;
      const provided = await piTools.provide(job.tools);
      piTools.seed(job.piProvider ? home : (process.env.PI_CODING_AGENT_DIR ?? config.PI_HOME));
      if (provided.dropped.length > 0) {
        offered = { ...job, tools: provided.tools };
        dropped = provided.dropped.map((d) => d.tool);
      }
    }

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
    const toolNames = offered.tools.split(",").map((t) => t.trim()).filter((t) => t !== "");
    const exec = async (nudge: string | undefined, timeoutSec: number, withTools = false): Promise<RunResult> => {
      const { cmd, input, env } = workerArgs(offered, home, nudge, withTools);
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
      // A pi session that was offered tools and made no call read nothing, so its answer is invented
      // whether or not it fits the schema. The rule covers the pi lane, where a small model was seen to
      // do this; the claude lane has not shown the failure, so it is not held to it.
      if (error === null && !claude && stats.tools === 0 && offered.tools.trim() !== "") error = "no-tool-calls";
      let parsed: ReturnType<typeof parseJsonDeliverable> = null;
      let problems: string[] = [];
      let problemKind: "schema" | "ids" = "schema";
      // A message that the guard cut: ask the guard's question of it again, to tell the model what was seen.
      let cut: string | null = null;
      if (error === "length" && !claude) {
        const runaway = runawayOf(stats.finalText, answerShapeOf(job), toolNames);
        if (runaway !== null) cut = cutBy(runaway, job.ids);
      }
      if (error === null && isJson) {
        parsed = parseJsonDeliverable(stats.finalText);
        if (parsed === null) {
          error = "no-json";
          // Text that began a JSON value and broke has a place where it broke; text with none has no problem.
          const broken = jsonProblem(stats.finalText);
          if (broken !== null) problems = [broken];
        } else {
          if (job.schema !== undefined) problems = validateSchema(parsed.value, job.schema);
          // The ids are checked when the shape is right: a record that has the wrong type has no id to read.
          if (problems.length === 0 && job.ids !== undefined) {
            problems = idProblems(parsed.value, job.ids);
            problemKind = "ids";
          }
        }
      }
      // A message that holds a tool call written as text: the model meant to call a tool, the server did
      // not run the call, and the session ended with the text. It is not an answer, whatever it parses to.
      let call: TextCall | null = null;
      const answered = error === null && parsed !== null && problems.length === 0;
      if (!claude && isJson && !answered && toolNames.length > 0 && ANSWER_ERRORS.has(error)) {
        call = textCallOf(stats.finalText, toolNames);
      }
      return { stats, error, parsed, problems, problemKind, cut, call };
    };

    if (!claude) mkdirSync(join(home, "session"), { recursive: true });
    const started = Date.now();
    let r = await exec(undefined, job.timeoutSec);
    let stdout = r.stdout;
    let verdict = judge(r, stdout);
    // A session that ends without a good answer is sent back for it, in the same session: a timeout or a
    // turn of thought alone otherwise throws away everything the worker found. It is sent back once for
    // each kind of failure, not once in all: an answer that is put right can still fail the next check
    // (a model that answered in prose, then in the wrong shape, then with the wrong ids). A kind is never
    // sent twice, so the loop ends. Claude Code workers do not save a session, so only pi workers get it.
    const nudgeSec = job.nudgeTimeoutSec;
    const sentFor = new Set<NudgeKind>();
    while (nudgeSec !== undefined && !claude && !overTurns && !r.aborted && !r.error) {
      const failing: WorkerError | null = verdict.error ?? (verdict.problems.length > 0 ? verdict.problemKind : null);
      // A call that did not run is asked for again, with the tools offered. It is asked for once; a call
      // that is written as text again is then read as the answer it failed to be, and sent back as one.
      let nudge: { kind: NudgeKind; message: string } | null = null;
      if (verdict.call !== null && !sentFor.has("call")) nudge = { kind: "call", message: callNudge(verdict.call) };
      else if (failing !== null) nudge = nudgeFor(failing, verdict.problems, verdict.cut);
      if (nudge === null || sentFor.has(nudge.kind)) break;
      sentFor.add(nudge.kind);
      dropCutReply(join(home, "session"));
      // A call nudge goes on with the work: it has the time of a first turn, not of an answer, and the tools.
      const asCall = nudge.kind === "call";
      r = await exec(nudge.message, asCall ? Math.max(nudgeSec, job.timeoutSec) : nudgeSec, asCall);
      stdout += r.stdout;
      verdict = judge(r, stdout);
    }
    const nudges = sentFor.size;
    const seconds = Math.round((Date.now() - started) / 1000);
    writeFileSync(streamPath, stdout, "utf8");

    const { stats, parsed, problems, problemKind } = verdict;
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
        if (problems.length > 0) {
          error = problemKind;
          writeFileSync(`${target}.${problemKind}-errors.txt`, problems.join("\n") + "\n", "utf8");
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
      toolErrorKinds: stats.toolErrorKinds,
      nudged: nudges > 0,
      nudges,
      attempts: job.attempt ?? 1,
      form,
      error,
      model: { provider: job.model.provider, name: job.model.model },
      ...(job.model.identity ? { modelIdentity: job.model.identity } : {}),
      ...(dropped.length > 0 ? { droppedTools: dropped } : {}),
      ...(error === "timeout" && !claude && openMessageKind(stdout) === "text" ? { timeoutWriting: true } : {}),
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
