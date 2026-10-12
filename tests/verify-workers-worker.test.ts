import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunOptions, RunResult } from "../harness/grade/proc.ts";
import { claudeStreamStats } from "../harness/workers/record.ts";
import type { PiTools } from "../harness/model/pitools.ts";
import {
  ANSWER_MIN_TOKENS,
  ANSWER_OVERHEAD_TOKENS,
  ANSWER_TOKENS_PER_RECORD,
  answerCap,
  runWorker as runWorkerReal,
  workerArgs,
  WORKER_CHARTER,
  type WorkerDeps,
  type WorkerJob,
} from "../harness/workers/worker.ts";

/** No binaries to provide: a test must not start pi's downloader. */
const noTools: PiTools = { provide: async (tools) => ({ tools, dropped: [] }), seed: () => {} };
const runWorker = (job: WorkerJob, deps: WorkerDeps = {}) => runWorkerReal(job, { piTools: noTools, ...deps });

let root: string;
let batchDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vworker-"));
  batchDir = join(root, "b01");
  mkdirSync(join(batchDir, "spec"), { recursive: true });
  mkdirSync(join(batchDir, "workspace"), { recursive: true });
  mkdirSync(join(batchDir, "rollouts"), { recursive: true });
  writeFileSync(join(batchDir, "spec", "task.md"), "Check each row.\n");
  writeFileSync(join(batchDir, "workspace", "items.md"), "### TODO line 7\nx\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const PI_STREAM = readFileSync(join(import.meta.dir, "fixtures", "workers", "pi-stream.jsonl"), "utf8");
const CLAUDE_STREAM = readFileSync(join(import.meta.dir, "fixtures", "workers", "claude-stream.jsonl"), "utf8");
const PI_PROVIDER = { id: "ollama", config: { baseUrl: "http://127.0.0.1:11434/v1", models: [{ id: "m" }] } };

function job(over: Partial<WorkerJob> = {}): WorkerJob {
  return {
    batchDir,
    rollout: "r01",
    prompt: "Do the work.",
    model: { provider: "ollama", model: "m" },
    tools: "read,grep,find,ls",
    deliverable: "report.json",
    timeoutSec: 60,
    piProvider: PI_PROVIDER,
    ...over,
  };
}

interface Seen {
  cmd: string;
  args: string[];
  opts: RunOptions;
  cwdFiles: string[];
  homeFiles: string[];
}

/** A run() fake that returns `stdout` and records what the worker started, and what its cwd held. */
function fakeRun(stdout: string, extra: Partial<RunResult> = {}) {
  const seen: Seen[] = [];
  const run = async (cmd: string, args: string[], opts: RunOptions): Promise<RunResult> => {
    const home = opts.env?.PI_CODING_AGENT_DIR;
    seen.push({
      cmd,
      args,
      opts,
      cwdFiles: readdirSync(opts.cwd!).sort(),
      homeFiles: home && existsSync(home) ? readdirSync(home) : [],
    });
    return { status: 0, signal: null, stdout, stderr: "", timedOut: false, truncated: false, timeoutMs: opts.timeoutMs, ...extra };
  };
  return { run, seen };
}

const rollout = (...parts: string[]) => join(batchDir, "rollouts", "r01", ...parts);
const record = () => JSON.parse(readFileSync(rollout("trajectory", "worker.json"), "utf8"));

describe("workerArgs", () => {
  test("pi args", () => {
    const { cmd, env } = workerArgs(job(), join(root, "home"));
    for (const flag of ["-p", "--no-context-files", "--no-extensions", "--no-prompt-templates", "--no-skills", "--no-session"]) {
      expect(cmd).toContain(flag);
    }
    expect(cmd[cmd.indexOf("--mode") + 1]).toBe("json");
    expect(cmd[cmd.indexOf("--tools") + 1]).toBe("read,grep,find,ls");
    expect(cmd[cmd.indexOf("--provider") + 1]).toBe("ollama");
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("m");
    expect(cmd.at(-1)).toBe("Do the work.");
    expect(env.PI_CODING_AGENT_DIR).toBe(join(root, "home"));
  });

  test("a pi worker gets the worker charter, so pi's default prompt with its docs path never reaches the model", () => {
    const { cmd } = workerArgs(job(), join(root, "home"));
    const charter = cmd[cmd.indexOf("--system-prompt") + 1]!;
    expect(charter).toContain("spec/task.md");
    expect(charter).toContain("relative");
    expect(charter).not.toContain("pi documentation");
    expect(cmd.indexOf("--system-prompt")).toBeLessThan(cmd.indexOf("--tools"));
  });

  test("the charter asks for one tool call in each message", () => {
    // A small model that writes its whole plan as one message of calls (10 or more in 14% of its messages)
    // fills the later calls with paths it has not seen. One call in a message, with the result read before
    // the next, cut that to 1% and the failed calls from 21% to 6% in the same batches.
    expect(WORKER_CHARTER).toContain("Make one tool call in each message");
    const { cmd } = workerArgs(job(), join(root, "home"));
    expect(cmd[cmd.indexOf("--system-prompt") + 1]).toContain("one tool call in each message");
  });

  test("the charter carries the schema of the deliverable, so the format is in every turn and survives a compaction", () => {
    const schema = { type: "object", required: ["rows"], properties: { rows: { type: "array", items: { required: ["line", "verdict"] } } } };
    const { cmd } = workerArgs(job({ schema }), join(root, "home"));
    const charter = cmd[cmd.indexOf("--system-prompt") + 1]!;
    expect(charter.startsWith(WORKER_CHARTER)).toBe(true);
    for (const word of ["JSON Schema", '"required"', '"verdict"', '"line"']) expect(charter).toContain(word);
    const plain = workerArgs(job(), join(root, "home")).cmd;
    expect(plain[plain.indexOf("--system-prompt") + 1]).toBe(WORKER_CHARTER);
  });

  test("with --ids the charter names the array, the id field and the ids of the batch", () => {
    const ids = { array: "rows", field: "line", expected: ["6857", "6858", "6867"] };
    const { cmd } = workerArgs(job({ ids }), join(root, "home"));
    const charter = cmd[cmd.indexOf("--system-prompt") + 1]!;
    expect(charter.startsWith(WORKER_CHARTER)).toBe(true);
    expect(charter).toContain("`rows`");
    expect(charter).toContain("`line`");
    expect(charter).toContain("6857, 6858, 6867");
    const both = workerArgs(job({ ids, schema: { type: "object" } }), join(root, "home")).cmd;
    const text = both[both.indexOf("--system-prompt") + 1]!;
    expect(text.indexOf("JSON Schema")).toBeGreaterThan(-1);
    expect(text.indexOf("6857, 6858, 6867")).toBeGreaterThan(text.indexOf("JSON Schema"));
  });

  test("a nudge turn offers no tools; the first turn does", () => {
    const first = workerArgs(job({ nudgeTimeoutSec: 90 }), join(root, "home")).cmd;
    expect(first[first.indexOf("--tools") + 1]).toBe("read,grep,find,ls");
    expect(first).not.toContain("--no-tools");
    const nudge = workerArgs(job({ nudgeTimeoutSec: 90 }), join(root, "home"), "Write the answer.").cmd;
    expect(nudge).toContain("--no-tools");
    expect(nudge).not.toContain("--tools");
    expect(nudge).toContain("-c");
  });

  test("every turn of a pi worker loads the repeat guard, a nudge turn too", () => {
    // Pi runs with --no-extensions; the guard is the one extension that is named, so a worker loads
    // nothing from the user's pi home. A nudge turn has no tools to guard, and its answer can be a
    // runaway as well.
    const first = workerArgs(job(), join(root, "home")).cmd;
    const at = first.indexOf("-e");
    expect(at).toBeGreaterThan(-1);
    expect(first).toContain("--no-extensions");
    expect(first[at + 1]).toMatch(/pi-extensions[\\/]repeat-guard\.ts$/);
    expect(existsSync(first[at + 1]!)).toBe(true);
    const nudge = workerArgs(job({ nudgeTimeoutSec: 90 }), join(root, "home"), "Write the answer.").cmd;
    expect(nudge[nudge.indexOf("-e") + 1]).toBe(first[at + 1]);
  });

  test("with --ids the guard is told the id field and the number of items, so it can cut a runaway answer", () => {
    const ids = { array: "rows", field: "line", expected: ["6857", "6858", "6867"] };
    const { env } = workerArgs(job({ ids }), join(root, "home"));
    expect(JSON.parse(env.VERIHARNESS_ANSWER_SHAPE!)).toEqual({ idField: "line", records: 3 });
    expect(workerArgs(job(), join(root, "home")).env.VERIHARNESS_ANSWER_SHAPE).toBeUndefined();
  });

  test("claude args", () => {
    const j = job({ model: { provider: "claude-code", model: "claude-haiku-5-5" }, piProvider: undefined, tools: "read,grep,find" });
    const { cmd, env, input } = workerArgs(j, join(root, "home"));
    expect(cmd).toContain("-p");
    expect(cmd[cmd.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(cmd[cmd.indexOf("--setting-sources") + 1]).toBe("");
    expect(cmd).toContain("--strict-mcp-config");
    expect(cmd).toContain("--no-session-persistence");
    expect(cmd[cmd.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("claude-haiku-5-5");
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    expect(input).toBe("Do the work.");
    expect(cmd).not.toContain("--system-prompt");
  });
});

describe("runWorker", () => {
  test("pi home holds models.json while the worker runs", async () => {
    const fake = fakeRun(PI_STREAM);
    await runWorker(job(), { run: fake.run });
    expect(fake.seen[0]!.homeFiles).toContain("models.json");
  });

  test("a tool whose binary could not be provided is not offered, and the record says so", async () => {
    const fake = fakeRun(PI_STREAM);
    const piTools: PiTools = {
      provide: async () => ({ tools: "read,grep,ls", dropped: [{ tool: "find", binary: "fd" }] }),
      seed: () => {},
    };
    const rec = await runWorker(job(), { run: fake.run, piTools });
    const args = fake.seen[0]!.args;
    expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,ls");
    expect(rec.droppedTools).toEqual(["find"]);
    expect(record().droppedTools).toEqual(["find"]);
  });

  test("the pi home is seeded before the worker starts, and a record with every tool has no droppedTools", async () => {
    const fake = fakeRun(PI_STREAM);
    const seeded: string[] = [];
    const piTools: PiTools = {
      provide: async (tools) => ({ tools, dropped: [] }),
      seed: (dir) => {
        seeded.push(dir);
        mkdirSync(join(dir, "bin"), { recursive: true });
        writeFileSync(join(dir, "bin", "fd"), "x");
      },
    };
    const rec = await runWorker(job(), { run: fake.run, piTools });
    expect(seeded).toHaveLength(1);
    expect(fake.seen[0]!.homeFiles).toContain("bin");
    expect(fake.seen[0]!.args[fake.seen[0]!.args.indexOf("--tools") + 1]).toBe("read,grep,find,ls");
    expect("droppedTools" in rec).toBe(false);
  });

  test("a Claude Code worker never asks for pi's binaries", async () => {
    const piTools: PiTools = {
      provide: async () => {
        throw new Error("provided");
      },
      seed: () => {
        throw new Error("seeded");
      },
    };
    const j = job({ model: { provider: "claude-code", model: "claude-haiku-5-5" }, piProvider: undefined, tools: "read,grep,find" });
    const rec = await runWorker(j, { run: fakeRun(CLAUDE_STREAM).run, piTools });
    expect(rec.error).toBeNull();
  });

  test("writes the rollout", async () => {
    const fake = fakeRun(PI_STREAM);
    const rec = await runWorker(job(), { run: fake.run });
    expect(readFileSync(rollout("trajectory", "agent.jsonl"), "utf8")).toBe(PI_STREAM);
    expect(JSON.parse(readFileSync(rollout("deliverables", "report.json"), "utf8"))).toEqual({ rows: [{ line: 7, verdict: "LOGGED" }] });
    expect(record()).toEqual(rec);
    expect(rec).toMatchObject({ rollout: "r01", exit: 0, turns: 3, tools: 1, peakContext: 24766, outputTokens: 404, form: "pure", error: null });
  });

  test("the record names the provider and model of every worker, with or without a digest", async () => {
    const rec = await runWorker(job({ model: { provider: "claude-code", model: "claude-haiku-5-5" } }), { run: fakeRun(PI_STREAM).run });
    expect(rec.model).toEqual({ provider: "claude-code", name: "claude-haiku-5-5" });
    expect(record().model).toEqual({ provider: "claude-code", name: "claude-haiku-5-5" });
    expect("modelIdentity" in rec).toBe(false);
  });

  test("the record names the weights the worker ran, so a re-created tag shows", async () => {
    const identity = { digest: "809799ae09ab0000", quantization: "Q4_K_M" };
    const rec = await runWorker(job({ model: { provider: "ollama", model: "m", identity } }), { run: fakeRun(PI_STREAM).run });
    expect(rec.modelIdentity).toEqual(identity);
    expect(record().modelIdentity).toEqual(identity);
    const bare = await runWorker(job(), { run: fakeRun(PI_STREAM).run });
    expect("modelIdentity" in bare).toBe(false);
  });

  test("totalSeconds adds the seconds of the attempts before to this attempt's own", async () => {
    const retry = await runWorker(job({ attempt: 2, priorSeconds: 50 }), { run: fakeRun(PI_STREAM).run });
    expect(retry.totalSeconds).toBe(50 + retry.seconds);
    const first = await runWorker(job(), { run: fakeRun(PI_STREAM).run });
    expect(first.totalSeconds).toBe(first.seconds);
    const onDisk = JSON.parse(readFileSync(join(batchDir, "rollouts", "r01", "trajectory", "worker.json"), "utf8"));
    expect(onDisk.totalSeconds).toBe(first.totalSeconds);
  });

  test("a retry keeps the archived earlier attempts, and a first run clears every old file", async () => {
    const old = join(batchDir, "rollouts", "r01", "trajectory", "attempt-1");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "agent.jsonl"), "first try");
    writeFileSync(join(batchDir, "rollouts", "r01", "trajectory", "stale.txt"), "from an older run");
    const retry = await runWorker(job({ attempt: 2 }), { run: fakeRun(PI_STREAM).run });
    expect(retry.attempts).toBe(2);
    expect(readFileSync(join(old, "agent.jsonl"), "utf8")).toBe("first try");
    expect(existsSync(rollout("trajectory", "stale.txt"))).toBe(false);
    const first = await runWorker(job(), { run: fakeRun(PI_STREAM).run });
    expect(first.attempts).toBe(1);
    expect(existsSync(old)).toBe(false);
  });

  test("a claude worker reads the claude stream", async () => {
    const fake = fakeRun(CLAUDE_STREAM);
    const j = job({ model: { provider: "claude-code", model: "claude-haiku-5-5" }, piProvider: undefined });
    const rec = await runWorker(j, { run: fake.run });
    expect(rec).toMatchObject({ turns: 3, tools: 1, peakContext: 6463, outputTokens: 265, form: "pure", error: null });
  });

  test("timeout", async () => {
    const fake = fakeRun("", { status: null, timedOut: true });
    const rec = await runWorker(job(), { run: fake.run });
    expect(rec.error).toBe("timeout");
    expect(rec.exit).toBeNull();
  });

  test("a process that cannot start", async () => {
    const fake = fakeRun("", { status: null, error: new Error("spawn ENOENT") });
    expect((await runWorker(job(), { run: fake.run })).error).toBe("start-failed");
  });

  test("no result", async () => {
    const fake = fakeRun('{"type":"agent_start"}\n');
    expect((await runWorker(job(), { run: fake.run })).error).toBe("no-result");
  });

  test("no json", async () => {
    const stream = PI_STREAM.replace('"{\\"rows\\": [{\\"line\\": 7, \\"verdict\\": \\"LOGGED\\"}]}"', '"I could not finish."');
    expect(stream).not.toBe(PI_STREAM);
    const rec = await runWorker(job(), { run: fakeRun(stream).run });
    expect(rec.error).toBe("no-json");
    expect(rec.form).toBeNull();
    expect(readFileSync(rollout("deliverables", "report.json.txt"), "utf8")).toBe("I could not finish.");
    expect(existsSync(rollout("deliverables", "report.json"))).toBe(false);
  });

  /** A pi stream of the given assistant turns, each `[content, stopReason]`. */
  const turns = (...list: [unknown[], string][]): string =>
    list
      .map(([content, stopReason]) =>
        JSON.stringify({ type: "message_end", message: { role: "assistant", content, usage: { input: 10, output: 5 }, stopReason } }),
      )
      .join("\n") + "\n";

  test("a last turn cut at the output limit is length, and its text is kept for the reader", async () => {
    const fake = fakeRun(turns([[{ type: "text", text: '{"rows": [{"line": 1' }], "length"]));
    const rec = await runWorker(job(), { run: fake.run });
    expect(rec.error).toBe("length");
    expect(readFileSync(rollout("deliverables", "report.json.partial.txt"), "utf8")).toBe('{"rows": [{"line": 1');
  });

  test("a session that ends on a tool call is stuck, whatever text came with the call", async () => {
    // A turn cap or an error can end a session on a call. The last turn then asked for a tool and got no
    // answer; its text is a sentence beside the call.
    const fake = fakeRun(
      turns([[{ type: "text", text: "Let me read it again." }, { type: "toolCall", id: "c9", name: "read", arguments: { path: "spec/task.md" } }], "toolUse"]),
    );
    const rec = await runWorker(job({ deliverable: "report.md" }), { run: fake.run });
    expect(rec.error).toBe("stuck");
    expect(existsSync(rollout("deliverables", "report.md"))).toBe(false);
  });

  /** The stream of a session that the guard stopped: a call, its failed result, and the empty turn that the abort ended. */
  const failedResult = (id: string): string =>
    JSON.stringify({ type: "message_end", message: { role: "toolResult", toolCallId: id, toolName: "read", isError: true, content: [{ type: "text", text: "Validation failed" }] } }) + "\n";
  const emptyTurn = (stopReason: string, errorMessage: string): string =>
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 0, output: 0 }, stopReason, errorMessage } }) + "\n";
  const STUCK =
    turns([[{ type: "toolCall", id: "c1", name: "read", arguments: { rows: [] } }], "toolUse"]) +
    failedResult("c1") +
    emptyTurn("error", "This operation was aborted");

  test("a session that the guard stopped after failed tool calls is stuck, not no-result", async () => {
    const rec = await runWorker(job(), { run: fakeRun(STUCK).run });
    expect(rec.error).toBe("stuck");
  });

  test("a request that timed out after a failed tool call is the server's failure, so it stays no-result", async () => {
    const stream =
      turns([[{ type: "toolCall", id: "c1", name: "read", arguments: { rows: [] } }], "toolUse"]) +
      failedResult("c1") +
      emptyTurn("error", "Request timed out.");
    const rec = await runWorker(job(), { run: fakeRun(stream).run });
    expect(rec.error).toBe("no-result");
  });

  test("a stuck session is continued once with a nudge that says why, and with no tools offered", async () => {
    const f = sequence({ stdout: STUCK }, { stdout: PI_STREAM });
    const rec = await runWorker(job({ nudgeTimeoutSec: 90 }), { run: f.run });
    expect(f.calls).toHaveLength(2);
    const second = f.calls[1]!;
    expect(second.args).toContain("-c");
    expect(second.args).toContain("--no-tools");
    const message = second.args.at(-1)!;
    expect(message).toContain("tool calls");
    expect(message).toContain("Write your final answer now");
    // It is not the text for a session that read nothing wrong, and it does not blame the model for a cut.
    expect(message).not.toContain("cut off");
    expect(rec).toMatchObject({ error: null, nudged: true, form: "pure" });
  });

  test("a nudge after the empty turn that the abort ended continues from the turn before it", async () => {
    // The turn holds nothing, and pi does not replay it; it is dropped so that the nudge follows the result.
    const abortedEntry = { type: "message", id: "m4", parentId: "m3", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted" } };
    const f = sessionRun(sessionFile(abortedEntry), STUCK, PI_STREAM);
    const rec = await runWorker(job({ nudgeTimeoutSec: 90 }), { run: f.run });
    expect(rec).toMatchObject({ error: null, nudged: true });
    expect(f.found).toEqual([sessionFile()]);
  });

  test("a nudge keeps an error turn that was not an abort", async () => {
    const timedOut = { type: "message", id: "m4", parentId: "m3", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Request timed out." } };
    const stream =
      turns([[{ type: "toolCall", id: "c1", name: "read", arguments: { path: "spec/task.md" } }], "toolUse"]) +
      failedResult("c1") +
      emptyTurn("error", "Request timed out.");
    const f = sessionRun(sessionFile(timedOut), stream, PI_STREAM);
    await runWorker(job({ nudgeTimeoutSec: 90 }), { run: f.run });
    expect(f.found).toEqual([sessionFile(timedOut)]);
  });

  test("a last turn that the runaway guard aborted is length, as one cut at the output limit is", async () => {
    // The guard of the pi session (pi-extensions/repeat-guard.ts) cuts a message that has more records than
    // the batch has items. pi ends that message with stopReason `aborted`.
    const fake = fakeRun(turns([[{ type: "text", text: '{"rows": [{"line": 1' }], "aborted"]));
    const rec = await runWorker(job(), { run: fake.run });
    expect(rec.error).toBe("length");
    expect(readFileSync(rollout("deliverables", "report.json.partial.txt"), "utf8")).toBe('{"rows": [{"line": 1');
  });

  /** A streamed fragment of the message in progress. */
  const update = (assistantMessageEvent: object): string => JSON.stringify({ type: "message_update", assistantMessageEvent }) + "\n";

  test("a timeout while the model was writing prose is marked, so a retry can run it again", async () => {
    // The session read a file and then began its answer, which did not end before the time did.
    const read =
      turns([[{ type: "toolCall", id: "c1", name: "read", arguments: { path: "spec/task.md" } }], "toolUse"]) +
      JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { content: [] }, isError: false }) +
      "\n";
    const writing = read + update({ type: "text_delta", contentIndex: 0, delta: '{"rows": [{"line": 7' });
    const rec = await runWorker(job(), { run: fakeRun(writing, { status: null, timedOut: true }).run });
    expect(rec).toMatchObject({ error: "timeout", timeoutWriting: true });
    expect(record().timeoutWriting).toBe(true);
  });

  test("a timeout while the model was working is not marked", async () => {
    const working = turns([[{ type: "toolCall", id: "c1", name: "read", arguments: { path: "spec/task.md" } }], "toolUse"]) +
      update({ type: "toolcall_delta", contentIndex: 0, delta: '{"path": "workspace/' });
    const rec = await runWorker(job(), { run: fakeRun(working, { status: null, timedOut: true }).run });
    expect(rec.error).toBe("timeout");
    expect(rec).not.toHaveProperty("timeoutWriting");
  });

  test("a last turn of thinking alone is thinking-only, not no-result", async () => {
    const fake = fakeRun(turns([[{ type: "thinking", thinking: "hmm" }], "stop"]));
    expect((await runWorker(job(), { run: fake.run })).error).toBe("thinking-only");
  });

  test("a worker that compacted its context is compacted, with its deliverable kept; allowCompaction accepts it", async () => {
    const stream = '{"type":"compaction_start","reason":"threshold"}\n' + PI_STREAM;
    const rec = await runWorker(job(), { run: fakeRun(stream).run });
    expect(rec.compactions).toBe(1);
    expect(record().compactions).toBe(1);
    expect(rec.error).toBe("compacted");
    expect(JSON.parse(readFileSync(rollout("deliverables", "report.json"), "utf8"))).toEqual({ rows: [{ line: 7, verdict: "LOGGED" }] });
    const allowed = await runWorker(job({ allowCompaction: true }), { run: fakeRun(stream).run });
    expect(allowed.error).toBeNull();
  });

  /** A run() fake that answers call n with results[n]; the last result repeats. */
  function sequence(...results: { stdout: string; extra?: Partial<RunResult> }[]) {
    const calls: { args: string[]; opts: RunOptions }[] = [];
    const run = async (_cmd: string, args: string[], opts: RunOptions): Promise<RunResult> => {
      const r = results[Math.min(calls.length, results.length - 1)]!;
      calls.push({ args, opts });
      return { status: 0, signal: null, stdout: r.stdout, stderr: "", timedOut: false, truncated: false, timeoutMs: opts.timeoutMs, ...r.extra };
    };
    return { run, calls };
  }
  const THOUGHT = turns([[{ type: "thinking", thinking: "hmm" }], "stop"]);

  test("a session that ends in thought alone is continued once with a nudge, and the answer completes the rollout", async () => {
    const f = sequence({ stdout: THOUGHT }, { stdout: PI_STREAM });
    const rec = await runWorker(job({ nudgeTimeoutSec: 90 }), { run: f.run });
    expect(f.calls).toHaveLength(2);
    expect(rec).toMatchObject({ error: null, nudged: true, form: "pure" });
    const [first, second] = f.calls;
    expect(first!.args).toContain("--session-dir");
    expect(first!.args).not.toContain("--no-session");
    expect(first!.args).not.toContain("-c");
    expect(second!.args).toContain("-c");
    expect(second!.args.at(-1)).toContain("Do not think further");
    expect(first!.opts.timeoutMs).toBe(60_000);
    expect(second!.opts.timeoutMs).toBe(90_000);
    // Both sessions are in the stream, and the counts cover both.
    expect(readFileSync(rollout("trajectory", "agent.jsonl"), "utf8")).toBe(THOUGHT + PI_STREAM);
    expect(rec.turns).toBe(1 + 3);
  });

  test("a timeout is continued with a wrap-up nudge, so the work done is not lost", async () => {
    const partial = turns([[{ type: "text", text: "Rows 1 to 4 are logged." }], "toolUse"]);
    const f = sequence({ stdout: partial, extra: { status: null, timedOut: true } }, { stdout: PI_STREAM });
    const rec = await runWorker(job({ nudgeTimeoutSec: 90 }), { run: f.run });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.args.at(-1)).toContain("Stop investigating");
    expect(rec).toMatchObject({ error: null, nudged: true });
  });

  test("nudges that end without an answer leave the error of the last one and the text it did write", async () => {
    // The first session read a file, so the end it came to is the answer's, not the lack of work.
    const call =
      turns([[{ type: "toolCall", id: "c1", name: "read", arguments: { path: "spec/task.md" } }], "toolUse"]) +
      JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { content: [] }, isError: false }) +
      "\n";
    const f = sequence({ stdout: call + THOUGHT }, { stdout: turns([[{ type: "text", text: "Still no JSON." }], "stop"]) });
    const rec = await runWorker(job({ nudgeTimeoutSec: 90 }), { run: f.run });
    // Thought alone is sent back as a cut, and prose as a format error: two kinds, so two nudges. The
    // third answer is the same prose, which is a kind that was sent, so the session ends.
    expect(f.calls).toHaveLength(3);
    expect(rec).toMatchObject({ error: "no-json", nudged: true, nudges: 2, tools: 1 });
    expect(readFileSync(rollout("deliverables", "report.json.txt"), "utf8")).toBe("Still no JSON.");
  });

  /** The lines of a pi session file: a header, a request, a tool round, then the given last entry. */
  const sessionFile = (...last: object[]): string =>
    [
      { type: "session", version: 3, id: "s1", cwd: "/w" },
      { type: "message", id: "m1", parentId: null, message: { role: "user", content: [{ type: "text", text: "Do the work." }] } },
      { type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "spec/task.md" } }], stopReason: "toolUse" } },
      { type: "message", id: "m3", parentId: "m2", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "task" }] } },
      ...last,
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n";
  const cutEntry = { type: "message", id: "m4", parentId: "m3", message: { role: "assistant", content: [{ type: "text", text: '{"rows": [{"line": 7' }], stopReason: "length" } };

  /** A run() fake that, on its first call, saves `file` as the pi session, and then records the session each later call finds. */
  function sessionRun(file: string, first: string, later: string) {
    const found: string[] = [];
    let n = 0;
    const run = async (_cmd: string, _args: string[], opts: RunOptions): Promise<RunResult> => {
      const path = join(opts.env!.PI_CODING_AGENT_DIR!, "session", "s1.jsonl");
      n++;
      if (n === 1) writeFileSync(path, file);
      else found.push(readFileSync(path, "utf8"));
      return { status: 0, signal: null, stdout: n === 1 ? first : later, stderr: "", timedOut: false, truncated: false, timeoutMs: opts.timeoutMs };
    };
    return { run, found };
  }

  test("a nudge after a message cut at the output limit continues from the turn before it, not from the cut text", async () => {
    // A cut message is a model's runaway more often than not (one row written 129 times). Sent back with
    // the nudge it is context that invites the same text again, and it spends the window.
    const f = sessionRun(sessionFile(cutEntry), turns([[{ type: "text", text: '{"rows": [{"line": 7' }], "length"]), PI_STREAM);
    const rec = await runWorker(job({ nudgeTimeoutSec: 90 }), { run: f.run });
    expect(rec).toMatchObject({ error: null, nudged: true, form: "pure" });
    expect(f.found).toEqual([sessionFile()]);
    // The stream keeps the cut message: it is the record of what happened.
    expect(readFileSync(rollout("trajectory", "agent.jsonl"), "utf8")).toContain('{\\"rows\\": [{\\"line\\": 7');
  });

  test("a nudge after a message that the runaway guard aborted continues from the turn before it", async () => {
    const abortedEntry = { type: "message", id: "m4", parentId: "m3", message: { role: "assistant", content: [{ type: "text", text: '{"rows": [{"line": 7' }], stopReason: "aborted" } };
    const f = sessionRun(sessionFile(abortedEntry), turns([[{ type: "text", text: '{"rows": [{"line": 7' }], "aborted"]), PI_STREAM);
    const rec = await runWorker(job({ nudgeTimeoutSec: 90 }), { run: f.run });
    expect(rec).toMatchObject({ error: null, nudged: true, form: "pure" });
    expect(f.found).toEqual([sessionFile()]);
  });

  test("a nudge keeps the last message of a session when that message was not cut", async () => {
    const stopEntry = { type: "message", id: "m4", parentId: "m3", message: { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" } };
    // The session read a file, so its end is a format failure, not a lack of work.
    const read =
      turns([[{ type: "toolCall", id: "c1", name: "read", arguments: { path: "spec/task.md" } }], "toolUse"]) +
      JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { content: [] }, isError: false }) +
      "\n";
    const f = sessionRun(sessionFile(stopEntry), read + turns([[{ type: "text", text: "Done." }], "stop"]), PI_STREAM);
    await runWorker(job({ nudgeTimeoutSec: 90 }), { run: f.run });
    expect(f.found).toEqual([sessionFile(stopEntry)]);
  });

  test("no nudge for a stop, a turn cap, a usage limit, a start failure, or when the nudge is off", async () => {
    const stopped = new AbortController();
    stopped.abort();
    for (const [extra, over] of [
      [{ status: null, aborted: true }, { signal: stopped.signal }],
      [{ status: null, error: new Error("spawn ENOENT") }, {}],
    ] as const) {
      const f = sequence({ stdout: THOUGHT, extra });
      await runWorker(job({ nudgeTimeoutSec: 90, ...over }), { run: f.run });
      expect(f.calls).toHaveLength(1);
    }
    const off = sequence({ stdout: THOUGHT });
    await runWorker(job(), { run: off.run });
    expect(off.calls).toHaveLength(1);
    expect(off.calls[0]!.args).toContain("--no-session");
    const claude = sequence({ stdout: "" });
    await runWorker(job({ model: { provider: "claude-code", model: "claude-haiku-5-5" }, piProvider: undefined, nudgeTimeoutSec: 90 }), { run: claude.run });
    expect(claude.calls).toHaveLength(1);
  });

  const LINE_SCHEMA = {
    type: "object",
    required: ["rows"],
    properties: { rows: { type: "array", items: { type: "object", required: ["line", "verdict"] } } },
  };
  const answer = (text: string) => turns([[{ type: "text", text }], "stop"]);
  /** An answer after one tool call: a worker that read something. */
  const worked = (text: string) => {
    const [call, final] = [
      turns([[{ type: "toolCall", id: "c1", name: "read", arguments: { path: "spec/task.md" } }], "toolUse"]),
      turns([[{ type: "text", text }], "stop"]),
    ];
    const ran = JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { content: [{ type: "text", text: "ok" }] }, isError: false }) + "\n";
    return call + ran + final;
  };

  test("an answer that fails the schema is sent back once, in the same session, with the errors", async () => {
    const f = sequence({ stdout: worked('{"rows": [{"line": 7}]}') }, { stdout: answer('{"rows": [{"line": 7, "verdict": "LOGGED"}]}') });
    const rec = await runWorker(job({ schema: LINE_SCHEMA, nudgeTimeoutSec: 90 }), { run: f.run });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.args).toContain("-c");
    expect(f.calls[1]!.args).toContain("--no-tools");
    expect(f.calls[1]!.args.at(-1)).toContain("$.rows[0]: missing property 'verdict'");
    expect(rec).toMatchObject({ error: null, nudged: true, form: "pure" });
    expect(existsSync(rollout("deliverables", "report.json.schema-errors.txt"))).toBe(false);
  });

  test("an answer that is not JSON is sent back with the place where it stops being JSON", async () => {
    // A model that is told only "not in the format" writes the same break again (b14 r03 of run 7 wrote
    // an object with no closing brace twice). The place and the rule are what it can act on.
    const broken = '{"rows": [{"line": 7, "verdict": "LOGGED"}]';
    const f = sequence({ stdout: worked(broken) }, { stdout: answer('{"rows": [{"line": 7, "verdict": "LOGGED"}]}') });
    const rec = await runWorker(job({ schema: LINE_SCHEMA, nudgeTimeoutSec: 90 }), { run: f.run });
    expect(f.calls).toHaveLength(2);
    const message = f.calls[1]!.args.at(-1)!;
    expect(message).toContain("character 1");
    expect(message).toContain("not closed");
    expect(message).toContain("[HERE]");
    expect(f.calls[1]!.args).toContain("--no-tools");
    expect(rec).toMatchObject({ error: null, nudged: true, form: "pure" });
  });

  test("a json nudge does not use up the format nudge: prose after it is sent back once more", async () => {
    const f = sequence(
      { stdout: worked('{"rows": [{"line": 7') },
      { stdout: answer("I could not finish.") },
      { stdout: answer('{"rows": [{"line": 7, "verdict": "LOGGED"}]}') },
    );
    const rec = await runWorker(job({ schema: LINE_SCHEMA, nudgeTimeoutSec: 90 }), { run: f.run });
    expect(f.calls).toHaveLength(3);
    expect(rec).toMatchObject({ error: null, nudges: 2 });
  });

  test("an answer that has no JSON at all gets the format nudge, which names no place", async () => {
    const f = sequence({ stdout: worked("I could not finish.") }, { stdout: answer('{"rows": [{"line": 7, "verdict": "LOGGED"}]}') });
    await runWorker(job({ schema: LINE_SCHEMA, nudgeTimeoutSec: 90 }), { run: f.run });
    const message = f.calls[1]!.args.at(-1)!;
    expect(message).toContain("did not hold the answer");
    expect(message).not.toContain("[HERE]");
  });

  /** The `maxTokens` that the worker wrote for the model in the pi home of its first call. */
  async function answerCapOf(over: Partial<WorkerJob>, providerMax: number): Promise<number> {
    let written = -1;
    const run = async (_cmd: string, _args: string[], opts: RunOptions): Promise<RunResult> => {
      const models = JSON.parse(readFileSync(join(opts.env!.PI_CODING_AGENT_DIR!, "models.json"), "utf8"));
      written = models.providers.ollama.models[0].maxTokens;
      return { status: 0, signal: null, stdout: PI_STREAM, stderr: "", timedOut: false, truncated: false, timeoutMs: opts.timeoutMs };
    };
    const piProvider = { id: "ollama", config: { baseUrl: "http://127.0.0.1:11434/v1", models: [{ id: "m", maxTokens: providerMax }] } };
    await runWorker(job({ piProvider, ...over }), { run });
    return written;
  }
  const IDS8 = { array: "rows", field: "line", expected: ["1", "2", "3", "4", "5", "6", "7", "8"] };

  test("a job with ids caps the answer at what its records need, so a runaway ends in a fraction of the window", async () => {
    // 8 records at 1024 tokens each and 1024 for the rest of the message. The default cap of the provider
    // (8192) is the room of the whole turn, which is about 8 times the longest record that a model was
    // measured to write.
    expect(await answerCapOf({ ids: IDS8 }, 65536)).toBe(8 * ANSWER_TOKENS_PER_RECORD + ANSWER_OVERHEAD_TOKENS);
  });

  test("the cap never raises the limit of the provider", async () => {
    expect(await answerCapOf({ ids: IDS8 }, 2000)).toBe(2000);
  });

  test("a limit that the user set is the user's: the cap does not replace it", async () => {
    const model = { provider: "ollama", model: "m", maxTokens: 20000 };
    expect(await answerCapOf({ ids: IDS8, model }, 20000)).toBe(20000);
  });

  test("a job without ids has no cap derived", async () => {
    expect(await answerCapOf({}, 8192)).toBe(8192);
  });

  test("the cap grows with the records of the batch, and a small batch keeps a floor", () => {
    expect(answerCap(16)).toBe(16 * ANSWER_TOKENS_PER_RECORD + ANSWER_OVERHEAD_TOKENS);
    // One record needs a few hundred tokens, but the limit is the one of every turn of the session.
    expect(answerCap(1)).toBe(ANSWER_MIN_TOKENS);
    expect(answerCap(1)).toBeGreaterThan(ANSWER_TOKENS_PER_RECORD + ANSWER_OVERHEAD_TOKENS);
  });

  test("a job that asks the model to think keeps the limit of the provider: thought is output too", async () => {
    const model = { provider: "ollama", model: "m", thinking: "medium" };
    expect(await answerCapOf({ ids: IDS8, model }, 8192)).toBe(8192);
  });

  test("an answer that still fails the schema after the nudge is schema, with the errors of the last answer", async () => {
    const f = sequence({ stdout: worked('{"rows": [{"line": 7}]}') }, { stdout: answer('{"rows": [{"verdict": "LOGGED"}]}') });
    const rec = await runWorker(job({ schema: LINE_SCHEMA, nudgeTimeoutSec: 90 }), { run: f.run });
    expect(f.calls).toHaveLength(2);
    expect(rec).toMatchObject({ error: "schema", nudged: true });
    const errors = readFileSync(rollout("deliverables", "report.json.schema-errors.txt"), "utf8");
    expect(errors).toContain("$.rows[0]: missing property 'line'");
    expect(errors).not.toContain("missing property 'verdict'");
  });

  test("a schema error is not sent back when the nudge is off, or for a claude worker, which has no session", async () => {
    const off = sequence({ stdout: worked('{"rows": [{"line": 7}]}') });
    expect((await runWorker(job({ schema: LINE_SCHEMA }), { run: off.run })).error).toBe("schema");
    expect(off.calls).toHaveLength(1);
    const claude = sequence({ stdout: CLAUDE_STREAM });
    const j = job({ model: { provider: "claude-code", model: "claude-haiku-5-5" }, piProvider: undefined, schema: { type: "object", required: ["nope"] }, nudgeTimeoutSec: 90 });
    expect((await runWorker(j, { run: claude.run })).error).toBe("schema");
    expect(claude.calls).toHaveLength(1);
  });

  test("a pi session that made no tool call is no-tool-calls, whatever it answered: nothing is nudged and no report is written", async () => {
    const text = '{"rows": [{"line": 7, "verdict": "LOGGED"}]}';
    const f = sequence({ stdout: answer(text) });
    const rec = await runWorker(job({ schema: LINE_SCHEMA, nudgeTimeoutSec: 90 }), { run: f.run });
    expect(rec).toMatchObject({ error: "no-tool-calls", tools: 0, nudged: false });
    expect(f.calls).toHaveLength(1);
    expect(existsSync(rollout("deliverables", "report.json"))).toBe(false);
    expect(readFileSync(rollout("deliverables", "report.json.partial.txt"), "utf8")).toBe(text);
  });

  test("no-tool-calls also covers a text that is not JSON, and an answer that fails the schema", async () => {
    for (const text of ["I will read the files now.", '{"name": "read", "parameters": {"path": "spec/task.md"}}']) {
      const rec = await runWorker(job({ schema: LINE_SCHEMA }), { run: fakeRun(answer(text)).run });
      expect(rec.error).toBe("no-tool-calls");
    }
  });

  test("a job that offers no tool is not held to a tool call", async () => {
    const rec = await runWorker(job({ tools: "" }), { run: fakeRun(answer('{"rows": []}')).run });
    expect(rec.error).toBeNull();
  });

  test("a timeout with no tool call stays a timeout, and the claude worker is not held to the rule", async () => {
    const t = await runWorker(job(), { run: fakeRun(answer("hmm"), { status: null, timedOut: true }).run });
    expect(t.error).toBe("timeout");
    const j = job({ model: { provider: "claude-code", model: "claude-haiku-5-5" }, piProvider: undefined });
    expect((await runWorker(j, { run: fakeRun(CLAUDE_STREAM).run })).error).toBeNull();
  });

  test("the nudge for a schema error lists at most eight errors and says how many more", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ line: i }));
    const f = sequence({ stdout: worked(JSON.stringify({ rows })) }, { stdout: answer(JSON.stringify({ rows: rows.map((r) => ({ ...r, verdict: "LOGGED" })) })) });
    await runWorker(job({ schema: LINE_SCHEMA, nudgeTimeoutSec: 90 }), { run: f.run });
    const message = f.calls[1]!.args.at(-1)!;
    expect(message.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(8);
    expect(message).toContain("and 4 more");
  });

  const IDS = { array: "rows", field: "line", expected: ["7", "8", "9"] };
  const row = (line: unknown) => ({ line, verdict: "LOGGED" });
  const report = (...lines: unknown[]) => JSON.stringify({ rows: lines.map(row) });

  test("--ids: a report with the ids of the batch, as numbers or strings, in any order, completes", async () => {
    const f = sequence({ stdout: worked(report(9, "7", 8)) });
    const rec = await runWorker(job({ schema: LINE_SCHEMA, ids: IDS, nudgeTimeoutSec: 90 }), { run: f.run });
    expect(rec).toMatchObject({ error: null, nudged: false });
    expect(f.calls).toHaveLength(1);
  });

  test("--ids: a report with the wrong ids is sent back once with the missing and the unexpected ids", async () => {
    const f = sequence({ stdout: worked(report(0, 1, 2)) }, { stdout: answer(report(7, 8, 9)) });
    const rec = await runWorker(job({ schema: LINE_SCHEMA, ids: IDS, nudgeTimeoutSec: 90 }), { run: f.run });
    expect(f.calls).toHaveLength(2);
    const message = f.calls[1]!.args.at(-1)!;
    expect(message).toContain("missing from rows: 7, 8, 9");
    expect(message).toContain("not in the batch: 0, 1, 2");
    expect(rec).toMatchObject({ error: null, nudged: true });
  });

  test("--ids: ids that are still wrong after the nudge end as ids, with the errors beside the report", async () => {
    const f = sequence({ stdout: worked(report(7, 8)) }, { stdout: answer(report(7, 7, 8, 9, 9)) });
    const rec = await runWorker(job({ schema: LINE_SCHEMA, ids: IDS, nudgeTimeoutSec: 90 }), { run: f.run });
    expect(rec).toMatchObject({ error: "ids", nudged: true });
    const errors = readFileSync(rollout("deliverables", "report.json.ids-errors.txt"), "utf8");
    expect(errors).toContain("repeated: 7, 9");
    expect(errors).not.toContain("missing from rows");
    // The value is kept, as for a schema error.
    expect(JSON.parse(readFileSync(rollout("deliverables", "report.json"), "utf8")).rows).toHaveLength(5);
  });

  test("--ids: a count that differs is reported as ids, and the schema error comes first when the shape is wrong", async () => {
    const few = await runWorker(job({ schema: LINE_SCHEMA, ids: IDS }), { run: fakeRun(worked(report(7))).run });
    expect(few.error).toBe("ids");
    expect(readFileSync(rollout("deliverables", "report.json.ids-errors.txt"), "utf8")).toContain("missing from rows: 8, 9");
    const shape = await runWorker(job({ schema: LINE_SCHEMA, ids: IDS }), { run: fakeRun(worked('{"rows": [{"line": 7}]}')).run });
    expect(shape.error).toBe("schema");
  });

  test("--ids: a report without the array, or with a row that has no id, is ids", async () => {
    for (const text of ['{"items": []}', '{"rows": [{"verdict": "LOGGED"}, {"line": 8, "verdict": "LOGGED"}, {"line": 9, "verdict": "LOGGED"}, {"line": 7, "verdict": "LOGGED"}]}']) {
      const rec = await runWorker(job({ ids: IDS }), { run: fakeRun(worked(text)).run });
      expect(rec.error).toBe("ids");
    }
  });

  test("a session is nudged once for each kind of failure: format, then schema, then ids", async () => {
    const f = sequence(
      { stdout: worked("I will report now.") },
      { stdout: answer('{"rows": [{"line": 7}]}') },
      { stdout: answer(report(0, 1, 2)) },
      { stdout: answer(report(7, 8, 9)) },
    );
    const rec = await runWorker(job({ schema: LINE_SCHEMA, ids: IDS, nudgeTimeoutSec: 90 }), { run: f.run });
    expect(f.calls).toHaveLength(4);
    const said = f.calls.slice(1).map((c) => c.args.at(-1)!);
    expect(said[0]).toContain("did not hold the answer in the format");
    expect(said[1]).toContain("missing property 'verdict'");
    expect(said[2]).toContain("missing from rows: 7, 8, 9");
    for (const call of f.calls.slice(1)) expect(call.args).toContain("-c");
    expect(rec).toMatchObject({ error: null, nudged: true, nudges: 3, tools: 1 });
    expect(existsSync(rollout("deliverables", "report.json.ids-errors.txt"))).toBe(false);
  });

  test("one kind of failure is sent back once: ids that are wrong twice end the session as ids", async () => {
    const f = sequence({ stdout: worked(report(7, 8)) }, { stdout: answer(report(7, 7, 8)) }, { stdout: answer(report(7, 8, 9)) });
    const rec = await runWorker(job({ schema: LINE_SCHEMA, ids: IDS, nudgeTimeoutSec: 90 }), { run: f.run });
    expect(f.calls).toHaveLength(2);
    expect(rec).toMatchObject({ error: "ids", nudged: true, nudges: 1 });
  });

  test("a timeout nudge and a format nudge are two kinds: a session that needs both gets both", async () => {
    const f = sequence(
      { stdout: worked("Rows 1 to 4 are logged."), extra: { status: null, timedOut: true } },
      { stdout: answer("Still working.") },
      { stdout: answer(report(7, 8, 9)) },
    );
    const rec = await runWorker(job({ schema: LINE_SCHEMA, ids: IDS, nudgeTimeoutSec: 90 }), { run: f.run });
    expect(f.calls).toHaveLength(3);
    expect(f.calls[1]!.args.at(-1)).toContain("Time is nearly up");
    expect(f.calls[2]!.args.at(-1)).toContain("did not hold the answer in the format");
    expect(rec).toMatchObject({ error: null, nudges: 2 });
  });

  test("the record counts the nudges: none for a session that needed none", async () => {
    const rec = await runWorker(job({ nudgeTimeoutSec: 90 }), { run: fakeRun(PI_STREAM).run });
    expect(rec).toMatchObject({ nudged: false, nudges: 0 });
    expect(record().nudges).toBe(0);
  });

  const ROWS_SCHEMA = {
    type: "object",
    required: ["rows"],
    properties: { rows: { type: "array", items: { type: "object", required: ["row", "verdict"] } } },
  };

  test("a deliverable that fails the schema is schema, with the errors beside it", async () => {
    const rec = await runWorker(job({ schema: ROWS_SCHEMA }), { run: fakeRun(PI_STREAM).run });
    expect(rec.error).toBe("schema");
    expect(readFileSync(rollout("deliverables", "report.json.schema-errors.txt"), "utf8")).toContain("$.rows[0]: missing property 'row'");
    // The value is kept: a reader can still use what the worker said.
    expect(JSON.parse(readFileSync(rollout("deliverables", "report.json"), "utf8"))).toEqual({ rows: [{ line: 7, verdict: "LOGGED" }] });
  });

  test("a deliverable that fits the schema completes", async () => {
    const schema = { type: "object", required: ["rows"] };
    expect((await runWorker(job({ schema }), { run: fakeRun(PI_STREAM).run })).error).toBeNull();
  });

  test("a timeout keeps the last text the worker wrote", async () => {
    const fake = fakeRun(turns([[{ type: "text", text: "Rows 1 to 4 are logged." }], "toolUse"]), { status: null, timedOut: true });
    const rec = await runWorker(job(), { run: fake.run });
    expect(rec.error).toBe("timeout");
    expect(readFileSync(rollout("deliverables", "report.json.partial.txt"), "utf8")).toBe("Rows 1 to 4 are logged.");
  });

  test("usage limit", async () => {
    const limited = CLAUDE_STREAM.replace('"is_error": false', '"is_error": true').replace('"result": "{\\"rows\\": []}"', '"result": "You\'ve hit your weekly usage limit"');
    expect(limited).not.toBe(CLAUDE_STREAM);
    const j = job({ model: { provider: "claude-code", model: "claude-haiku-5-5" }, piProvider: undefined });
    const rec = await runWorker(j, { run: fakeRun(limited, { status: 1 }).run });
    expect(rec.error).toBe("usage-limit");
  });

  test("a claude error result is no result, even when text came before it", async () => {
    const failed = CLAUDE_STREAM.replace('"is_error": false', '"is_error": true').replace('"result": "{\\"rows\\": []}"', '"result": "API Error: 500"');
    expect(failed).not.toBe(CLAUDE_STREAM);
    const j = job({ model: { provider: "claude-code", model: "claude-haiku-5-5" }, piProvider: undefined, deliverable: "report.md" });
    const rec = await runWorker(j, { run: fakeRun(failed, { status: 1 }).run });
    expect(rec.error).toBe("no-result");
    expect(existsSync(rollout("deliverables", "report.md"))).toBe(false);
  });

  test("a claude exit that is not 0 is no result, even with a good result event", async () => {
    const j = job({ model: { provider: "claude-code", model: "claude-haiku-5-5" }, piProvider: undefined });
    expect((await runWorker(j, { run: fakeRun(CLAUDE_STREAM, { status: 1 }).run })).error).toBe("no-result");
  });

  test("output over the cap", async () => {
    const rec = await runWorker(job(), { run: fakeRun(PI_STREAM, { status: null, truncated: true }).run });
    expect(rec.error).toBe("truncated");
  });

  test("a stopped worker", async () => {
    const rec = await runWorker(job(), { run: fakeRun(PI_STREAM, { status: null, aborted: true }).run });
    expect(rec.error).toBe("stopped");
  });

  /** A run() fake that streams `stdout` through onStdout line by line and stops when the signal aborts. */
  function streamingRun(stdout: string) {
    let streamed = 0;
    const run = async (_cmd: string, _args: string[], opts: RunOptions): Promise<RunResult> => {
      for (const line of stdout.split(/(?<=\n)/)) {
        if (opts.signal?.aborted) break;
        opts.onStdout?.(Buffer.from(line, "utf8"));
        streamed += line.length;
      }
      const aborted = opts.signal?.aborted === true;
      return { status: aborted ? null : 0, signal: null, stdout: stdout.slice(0, streamed), stderr: "", timedOut: false, truncated: false, ...(aborted ? { aborted } : {}), timeoutMs: opts.timeoutMs };
    };
    return { run };
  }

  test("agent.jsonl grows while the worker runs", async () => {
    const seenDuring: string[] = [];
    const run = async (_cmd: string, _args: string[], opts: RunOptions): Promise<RunResult> => {
      const lines = PI_STREAM.split(/(?<=\n)/);
      opts.onStdout?.(Buffer.from(lines[0]!, "utf8"));
      seenDuring.push(readFileSync(rollout("trajectory", "agent.jsonl"), "utf8"));
      for (const line of lines.slice(1)) opts.onStdout?.(Buffer.from(line, "utf8"));
      return { status: 0, signal: null, stdout: PI_STREAM, stderr: "", timedOut: false, truncated: false, timeoutMs: opts.timeoutMs };
    };
    const rec = await runWorker(job(), { run });
    expect(seenDuring[0]).toBe(PI_STREAM.split(/(?<=\n)/)[0]);
    expect(readFileSync(rollout("trajectory", "agent.jsonl"), "utf8")).toBe(PI_STREAM);
    expect(rec.error).toBeNull();
  });

  test("a worker past maxTurns assistant turns stops with max-turns", async () => {
    const rec = await runWorker(job({ maxTurns: 1 }), { run: streamingRun(PI_STREAM).run });
    expect(rec.error).toBe("max-turns");
    expect(rec.turns).toBe(2);
    expect(record()).toEqual(rec);
  });

  test("a worker within maxTurns completes", async () => {
    const rec = await runWorker(job({ maxTurns: 3 }), { run: streamingRun(PI_STREAM).run });
    expect(rec).toMatchObject({ error: null, turns: 3, form: "pure" });
  });

  test("a claude worker past maxTurns stops with max-turns", async () => {
    const j = job({ model: { provider: "claude-code", model: "claude-haiku-5-5" }, piProvider: undefined, maxTurns: 1 });
    const rec = await runWorker(j, { run: streamingRun(CLAUDE_STREAM).run });
    expect(claudeStreamStats(CLAUDE_STREAM).turns).toBeGreaterThan(1);
    expect(rec.error).toBe("max-turns");
  });

  test("with maxTurns, the job signal still stops the run", async () => {
    const fake = fakeRun(PI_STREAM);
    const ac = new AbortController();
    await runWorker(job({ signal: ac.signal, maxTurns: 5 }), { run: fake.run });
    const seen = fake.seen[0]!.opts.signal!;
    expect(seen.aborted).toBe(false);
    ac.abort();
    expect(seen.aborted).toBe(true);
  });

  test("the signal of the job reaches the process runner", async () => {
    const fake = fakeRun(PI_STREAM);
    const ac = new AbortController();
    await runWorker(job({ signal: ac.signal }), { run: fake.run });
    expect(fake.seen[0]!.opts.signal).toBe(ac.signal);
  });

  test("a temp folder that cannot be deleted does not lose the record", async () => {
    const real = process.stderr.write.bind(process.stderr);
    let stderr = "";
    process.stderr.write = ((c: string | Uint8Array) => ((stderr += String(c)), true)) as typeof process.stderr.write;
    try {
      const rmrf = (p: string) => {
        if (p.includes("vh-worker-")) throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
        rmSync(p, { recursive: true, force: true });
      };
      const fake = fakeRun(PI_STREAM);
      const rec = await runWorker(job(), { run: fake.run, rmrf });
      rmSync(join(fake.seen[0]!.opts.cwd!, ".."), { recursive: true, force: true });
      expect(rec.error).toBeNull();
      expect(record()).toEqual(rec);
      expect(stderr).toContain("EBUSY");
    } finally {
      process.stderr.write = real;
    }
  });

  test("temp folder removed", async () => {
    const ok = fakeRun(PI_STREAM);
    await runWorker(job(), { run: ok.run });
    expect(existsSync(ok.seen[0]!.opts.cwd!)).toBe(false);
    let cwd = "";
    const boom = async (_c: string, _a: string[], opts: RunOptions): Promise<RunResult> => {
      cwd = opts.cwd!;
      throw new Error("boom");
    };
    await expect(runWorker(job(), { run: boom })).rejects.toThrow("boom");
    expect(cwd).not.toBe("");
    expect(existsSync(cwd)).toBe(false);
  });

  test("isolation", async () => {
    const fake = fakeRun(PI_STREAM);
    await runWorker(job(), { run: fake.run });
    const seen = fake.seen[0]!;
    expect(seen.opts.cwd).not.toBe(batchDir);
    expect(seen.cwdFiles).toEqual(["spec", "workspace"]);
  });

  test("a rerun replaces the old rollout", async () => {
    mkdirSync(rollout("deliverables"), { recursive: true });
    writeFileSync(rollout("deliverables", "report.json.txt"), "old");
    await runWorker(job(), { run: fakeRun(PI_STREAM).run });
    expect(existsSync(rollout("deliverables", "report.json.txt"))).toBe(false);
  });
});
