import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunOptions, RunResult } from "../harness/grade/proc.ts";
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

  test("usage limit", async () => {
    const limited = CLAUDE_STREAM.replace('"is_error": false', '"is_error": true').replace('"result": "{\\"rows\\": []}"', '"result": "You\'ve hit your weekly usage limit"');
    expect(limited).not.toBe(CLAUDE_STREAM);
    const j = job({ model: { provider: "claude-code", model: "claude-haiku-5-5" }, piProvider: undefined });
    const rec = await runWorker(j, { run: fakeRun(limited, { status: 1 }).run });
    expect(rec.error).toBe("usage-limit");
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
