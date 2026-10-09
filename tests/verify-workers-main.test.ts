import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkerRecord } from "../harness/workers/record.ts";
import { main } from "../harness/workers/main.ts";
import type { WorkerJob } from "../harness/workers/worker.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vworkers-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function makeBatch(dir: string): void {
  mkdirSync(join(dir, "spec"), { recursive: true });
  mkdirSync(join(dir, "workspace"), { recursive: true });
  mkdirSync(join(dir, "rollouts"), { recursive: true });
  writeFileSync(join(dir, "spec", "task.md"), "Check.\n");
}

function batchRoot(names: string[], prompt = true): string {
  for (const n of names) makeBatch(join(root, n));
  if (prompt) writeFileSync(join(root, "worker_prompt.md"), "Do the work.\n");
  return root;
}

function ok(job: WorkerJob, error: WorkerRecord["error"] = null): WorkerRecord {
  return { rollout: job.rollout, exit: 0, seconds: 1, turns: 1, tools: 0, peakContext: 1, outputTokens: 1, form: error ? null : "pure", error };
}

/** A runWorker fake: records each call, the largest number in flight, and the order of starts and ends. */
function fake(result: (job: WorkerJob) => WorkerRecord = (j) => ok(j), delayMs = 5) {
  const calls: WorkerJob[] = [];
  const events: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const runWorker = async (job: WorkerJob): Promise<WorkerRecord> => {
    calls.push(job);
    const name = `${job.batchDir.split(/[\\/]/).pop()}/${job.rollout}`;
    events.push(`start ${name}`);
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, delayMs));
    inFlight--;
    events.push(`end ${name}`);
    return result(job);
  };
  return { runWorker, calls, events, peak: () => peak };
}

function ollamaLoaded(window = 65536) {
  return async (input: string | URL): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (path === "/api/tags") return json({ models: [{ name: "m" }] });
    if (path === "/api/show") return json({ capabilities: ["completion", "tools"], parameters: "num_ctx 32768" });
    if (path === "/api/ps") return json({ models: [{ name: "m", context_length: window }] });
    return new Response("not found", { status: 404 });
  };
}

async function workers(argv: string[], f: ReturnType<typeof fake>) {
  const outReal = process.stdout.write.bind(process.stdout);
  const errReal = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((c: string | Uint8Array) => ((stdout += String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => ((stderr += String(c)), true)) as typeof process.stderr.write;
  try {
    const code = await main(argv, { runWorker: f.runWorker, fetch: ollamaLoaded(), retryDelayMs: 0 });
    const lines = stdout.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
    return { code, lines, stderr };
  } finally {
    process.stdout.write = outReal;
    process.stderr.write = errReal;
  }
}

const OLLAMA = ["--provider", "ollama", "--model", "m", "--base-url", "http://127.0.0.1:11434"];
const HAIKU = ["--provider", "claude-code", "--model", "claude-haiku-5-5", "--env", "none"];

describe("veriharness workers", () => {
  test("all batches", async () => {
    const f = fake();
    const r = await workers([batchRoot(["b01", "b02"]), ...OLLAMA, "--count", "2"], f);
    expect(r.code).toBe(0);
    expect(f.calls).toHaveLength(4);
    expect(r.lines).toHaveLength(5);
    expect(r.lines[0]).toMatchObject({ batch: "b01", error: null });
    expect(r.lines.at(-1)).toEqual({ summary: { complete: 4, errors: 0, skipped: 0 } });
    expect(f.calls[0]!.prompt).toBe("Do the work.\n");
    expect(f.calls[0]!.piProvider?.id).toBeDefined();
  });

  test("one task workspace", async () => {
    const dir = join(root, "task");
    makeBatch(dir);
    writeFileSync(join(dir, "worker_prompt.md"), "Go.\n");
    const f = fake();
    const r = await workers([dir, ...OLLAMA, "--count", "1"], f);
    expect(r.code).toBe(0);
    expect(f.calls.map((c) => c.batchDir)).toEqual([dir]);
  });

  test("--only", async () => {
    const dir = batchRoot(["b01", "b02"]);
    const f = fake();
    expect((await workers([dir, ...OLLAMA, "--count", "2", "--only", "b02"], f)).code).toBe(0);
    expect(f.calls).toHaveLength(2);
    const g = fake();
    expect((await workers([dir, ...OLLAMA, "--only", "b09"], g)).code).toBe(2);
    expect(g.calls).toHaveLength(0);
  });

  test("resume", async () => {
    const dir = batchRoot(["b01"]);
    const traj = (r: string) => join(dir, "b01", "rollouts", r, "trajectory");
    mkdirSync(traj("r01"), { recursive: true });
    writeFileSync(join(traj("r01"), "worker.json"), JSON.stringify({ rollout: "r01", error: null }));
    mkdirSync(traj("r02"), { recursive: true });
    writeFileSync(join(traj("r02"), "worker.json"), JSON.stringify({ rollout: "r02", error: "timeout" }));
    mkdirSync(join(dir, "b01", "rollouts", "r03", "deliverables"), { recursive: true });
    writeFileSync(join(dir, "b01", "rollouts", "r03", "deliverables", "report.json"), "{}");
    const f = fake();
    const r = await workers([dir, ...OLLAMA, "--count", "3"], f);
    expect(r.code).toBe(0);
    expect(f.calls.map((c) => c.rollout).sort()).toEqual(["r02", "r03"]);
    expect(r.lines.at(-1)).toEqual({ summary: { complete: 2, errors: 0, skipped: 1 } });
  });

  test("local concurrency", async () => {
    const f = fake();
    await workers([batchRoot(["b01", "b02"]), ...OLLAMA, "--count", "3"], f);
    expect(f.peak()).toBe(3);
    const lastEndB01 = f.events.lastIndexOf(f.events.filter((e) => e.startsWith("end b01")).at(-1)!);
    const firstStartB02 = f.events.findIndex((e) => e.startsWith("start b02"));
    expect(firstStartB02).toBeGreaterThan(lastEndB01);
  });

  test("claude concurrency", async () => {
    const f = fake();
    const r = await workers([batchRoot(["b01", "b02", "b03"]), ...HAIKU, "--count", "3"], f);
    expect(r.code).toBe(0);
    expect(f.calls).toHaveLength(9);
    expect(f.peak()).toBe(4);
  });

  test("--max-parallel 1", async () => {
    const f = fake();
    await workers([batchRoot(["b01", "b02"]), ...HAIKU, "--count", "2", "--max-parallel", "1"], f);
    expect(f.peak()).toBe(1);
  });

  test("exit 1", async () => {
    const f = fake((j) => ok(j, j.rollout === "r02" ? "no-json" : null));
    const r = await workers([batchRoot(["b01"]), ...OLLAMA, "--count", "2"], f);
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toEqual({ summary: { complete: 1, errors: 1, skipped: 0 } });
  });

  test("usage limit", async () => {
    const f = fake((j) => ok(j, "usage-limit"));
    const r = await workers([batchRoot(["b01", "b02", "b03"]), ...HAIKU, "--count", "3", "--max-parallel", "1"], f);
    expect(r.code).toBe(75);
    expect(f.calls).toHaveLength(1);
  });

  test("a usage limit stops the workers that are still running", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const runWorker = async (job: WorkerJob): Promise<WorkerRecord> => {
      signals.push(job.signal);
      if (job.rollout === "r01") return ok(job, "usage-limit");
      // A running worker ends early only when its signal fires.
      await new Promise<void>((done) => {
        const t = setTimeout(done, 5000);
        job.signal?.addEventListener("abort", () => (clearTimeout(t), done()));
      });
      return ok(job, job.signal?.aborted ? "stopped" : null);
    };
    const started = Date.now();
    const f = { ...fake(), runWorker };
    const r = await workers([batchRoot(["b01"]), ...HAIKU, "--count", "3", "--max-parallel", "3"], f);
    expect(r.code).toBe(75);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(signals.every((s) => s?.aborted)).toBe(true);
    expect(r.lines.filter((l) => l.error === "stopped")).toHaveLength(2);
  });

  test("--context-size and --base-url need a local provider", async () => {
    const f = fake();
    const r = await workers([batchRoot(["b01"]), "--provider", "openrouter", "--model", "m", "--context-size", "65536"], f);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--context-size");
    expect(f.calls).toHaveLength(0);
  });

  test("a tool with no Claude Code match is an input error before any worker", async () => {
    for (const tools of ["constructor", "read,teleport"]) {
      const f = fake();
      const r = await workers([batchRoot(["b01"]), ...HAIKU, "--tools", tools], f);
      expect(r.code).toBe(2);
      expect(f.calls).toHaveLength(0);
    }
  });

  test("claude needs env none", async () => {
    const f = fake();
    const r = await workers([batchRoot(["b01"]), "--provider", "claude-code", "--model", "claude-haiku-5-5"], f);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--env none");
    expect(f.calls).toHaveLength(0);
  });

  test("prompt default", async () => {
    const f = fake();
    const r = await workers([batchRoot(["b01"], false), ...OLLAMA], f);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("worker_prompt.md");
    expect(f.calls).toHaveLength(0);
  });

  test("a folder with no batch is an input error", async () => {
    const f = fake();
    expect((await workers([root, ...OLLAMA], f)).code).toBe(2);
  });

  test("the window is resolved once and reported", async () => {
    const f = fake();
    const r = await workers([batchRoot(["b01"]), ...OLLAMA, "--count", "1"], f);
    expect(r.stderr).toContain("window=65536 source=loaded");
  });
});

test("the cli routes workers", async () => {
  const { main: cliMain } = await import("../harness/cli.ts");
  const outReal = process.stdout.write.bind(process.stdout);
  let stdout = "";
  process.stdout.write = ((c: string | Uint8Array) => ((stdout += String(c)), true)) as typeof process.stdout.write;
  try {
    expect(await cliMain(["workers", "--help"])).toBe(0);
  } finally {
    process.stdout.write = outReal;
  }
  expect(stdout).toContain("veriharness workers DIR");
});
