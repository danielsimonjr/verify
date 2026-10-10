import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunOptions, RunResult } from "../harness/grade/proc.ts";
import { claudeStreamStats } from "../harness/workers/record.ts";
import { runWorker, workerArgs, type WorkerJob } from "../harness/workers/worker.ts";

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
  });
});

describe("runWorker", () => {
  test("pi home holds models.json while the worker runs", async () => {
    const fake = fakeRun(PI_STREAM);
    await runWorker(job(), { run: fake.run });
    expect(fake.seen[0]!.homeFiles).toContain("models.json");
  });

  test("writes the rollout", async () => {
    const fake = fakeRun(PI_STREAM);
    const rec = await runWorker(job(), { run: fake.run });
    expect(readFileSync(rollout("trajectory", "agent.jsonl"), "utf8")).toBe(PI_STREAM);
    expect(JSON.parse(readFileSync(rollout("deliverables", "report.json"), "utf8"))).toEqual({ rows: [{ line: 7, verdict: "LOGGED" }] });
    expect(record()).toEqual(rec);
    expect(rec).toMatchObject({ rollout: "r01", exit: 0, turns: 3, tools: 1, peakContext: 24766, outputTokens: 404, form: "pure", error: null });
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

  test("a nudge that ends without an answer leaves the error of the nudge and the text it did write", async () => {
    const f = sequence({ stdout: THOUGHT }, { stdout: turns([[{ type: "text", text: "Still no JSON." }], "stop"]) });
    const rec = await runWorker(job({ nudgeTimeoutSec: 90 }), { run: f.run });
    expect(f.calls).toHaveLength(2);
    expect(rec).toMatchObject({ error: "no-json", nudged: true });
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
