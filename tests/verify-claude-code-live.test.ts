import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { main as driverMain } from "../harness/driver.ts";
import { main as modelCheckMain } from "../harness/model/check.ts";

/**
 * The live check of the Claude Code provider. It starts the real `claude` program with the login Claude Code
 * already holds, so it spends part of that account's usage, and it does not run in CI.
 *
 *   VERIHARNESS_LIVE_CLAUDE=1 bun test tests/verify-claude-code-live.test.ts
 *
 * It reads and writes Claude Code's real configuration directory (`CLAUDE_CONFIG_DIR`, else `~/.claude`), because
 * that is where the login is. It sets and prints no credential. The verifier's Bash tool runs on this host.
 */

const live = process.env.VERIHARNESS_LIVE_CLAUDE === "1";
const MODEL = process.env.VERIHARNESS_LIVE_CLAUDE_MODEL ?? "claude-haiku-4-5-20251001";
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "verify-claude-code", "live-task");

/** Everything `fn` writes to stdout, and its result. */
async function capturingStdout<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string }> {
  const real = process.stdout.write.bind(process.stdout);
  let stdout = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    return { result: await fn(), stdout };
  } finally {
    process.stdout.write = real;
  }
}

describe.skipIf(!live)("Claude Code live", () => {
  test("model-check reports the CLI version, the model and the key source", async () => {
    const { result, stdout } = await capturingStdout(() => modelCheckMain(["--provider", "claude-code", "--model", MODEL]));
    console.log(`model-check exit ${result}\n${stdout}`);
    expect(result).toBe(0);
    const report = JSON.parse(stdout) as Record<string, unknown>;
    expect(report.provider).toBe("claude-code");
    expect(report.requestedModel).toBe(MODEL);
    expect(String(report.cliVersion)).toMatch(/\d+\.\d+/);
    // The model that was asked for, not a fixed one: VERIHARNESS_LIVE_CLAUDE_MODEL can name any model.
    const family = /haiku|sonnet|opus/i.exec(MODEL)?.[0].toLowerCase();
    if (family !== undefined) expect(String(report.model).toLowerCase()).toContain(family);
    else expect(String(report.model).length).toBeGreaterThan(0);
    expect(typeof report.keySource).toBe("string");
    expect(String(report.reply).length).toBeGreaterThan(0);
  }, 180_000);

  test("one driver task on a tiny fixture, with --env none", async () => {
    const ws = mkdtempSync(join(tmpdir(), "vcc-live-"));
    try {
      cpSync(FIXTURE, ws, { recursive: true });
      const code = await driverMain([
        ws,
        "--provider",
        "claude-code",
        "--model",
        MODEL,
        "--env",
        "none",
        "--no-skills",
        "--turn-timeout",
        "420",
        "--task-timeout",
        "1500",
      ]);
      const log = readFileSync(join(ws, "driver.log"), "utf8");
      console.log(`driver exit ${code}\n${log}`);
      const finishPath = join(ws, "finish.json");
      if (existsSync(finishPath)) console.log(`finish.json\n${readFileSync(finishPath, "utf8")}`);
      expect(code).toBe(0);
      expect(existsSync(join(ws, "elim", "ledger_elim.json"))).toBe(true);
      expect(existsSync(join(ws, "fals", "ledger_fals.json"))).toBe(true);
      const finish = JSON.parse(readFileSync(finishPath, "utf8")) as { base?: string; repair?: { valid?: boolean } };
      expect(["r1", "r2"]).toContain(String(finish.base));
      expect(finish.repair?.valid).toBe(true);
      // The saved copies left Claude Code's directory for the task's own.
      for (const name of ["elim", "fals", "adjudicate"]) {
        const kept = join(ws, "session", name, "claude-persisted");
        expect(existsSync(kept)).toBe(true);
        expect(readdirSync(kept).filter((f) => f.endsWith(".jsonl")).length).toBeGreaterThan(0);
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 1_800_000);
});
