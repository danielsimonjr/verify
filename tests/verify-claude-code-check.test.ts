import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeCheckError, claudeCommand, modelCheck, startCheck } from "../harness/claude/index.ts";
import { main as modelCheckMain } from "../harness/model/check.ts";
import { STUB, type Call, type Rule } from "./fixtures/verify-claude-code/rig.ts";

const MODEL = "claude-haiku-4-5-20251001";

let root: string;
let stubDir: string;
let configDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vcc-check-"));
  stubDir = join(root, "stub");
  configDir = join(root, "config");
  mkdirSync(stubDir);
  mkdirSync(configDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The environment of a check: the stub's variables and a temporary configuration directory, nothing of the real one. */
function envWith(rules: Rule[] = [], extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const script = join(root, "script.json");
  writeFileSync(script, JSON.stringify({ rules }));
  return { ...process.env, STUB_DIR: stubDir, STUB_SCRIPT: script, CLAUDE_CONFIG_DIR: configDir, ...extra };
}

const calls = (): Call[] => {
  const dir = join(stubDir, "calls");
  return existsSync(dir) ? readdirSync(dir).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Call) : [];
};

const run = (env: NodeJS.ProcessEnv, timeoutMs?: number) =>
  modelCheck({ command: [process.execPath, STUB], model: MODEL, env, timeoutMs });

describe("model-check through the stub claude", () => {
  test("it reports the CLI version, the model Claude Code says it used, and the key source", async () => {
    const report = await run(envWith([{ action: { result: { text: "OK" } } }], { STUB_KEY_SOURCE: "ANTHROPIC_API_KEY", STUB_VERSION: "2.1.289" }));
    expect(report).toEqual({
      provider: "claude-code",
      requestedModel: MODEL,
      model: MODEL,
      cliVersion: "2.1.289 (Claude Code stub)",
      keySource: "ANTHROPIC_API_KEY",
      tools: [],
      warnings: [],
      builtinPlugins: [],
      reply: "OK",
    });
  });

  test("the turn is isolated, has no tools, saves nothing, and runs in a directory that is removed after", async () => {
    await run(envWith());
    const [call] = calls();
    expect(call!.stdin).toBe("Reply with OK");
    const argv = call!.argv;
    const after = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(after("--tools")).toBe("");
    expect(after("--setting-sources")).toBe("");
    expect(JSON.parse(after("--settings")!)).toEqual({
      disableAllHooks: true,
      autoMemoryEnabled: false,
      autoContinueAtUsageLimit: false,
    });
    expect(call!.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(after("--model")).toBe(MODEL);
    expect(after("--permission-mode")).toBe("bypassPermissions");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--no-session-persistence");
    expect(argv).not.toContain("--session-id");
    expect(existsSync(call!.cwd)).toBe(false);
    // Nothing reached Claude Code's configuration directory.
    expect(readdirSync(configDir)).toEqual([]);
  });

  test("session markers of an outer Claude Code session do not reach it, and the login does", async () => {
    await run(envWith([], { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "outer", ANTHROPIC_API_KEY: "sk-fake-for-test" }));
    const { env } = calls()[0]!;
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-fake-for-test");
  });

  test("an MCP server or a foreign plugin is a warning; the built-in plugins are listed without one", async () => {
    const report = await run(
      envWith([{ action: { mcpServers: ["leaky"], plugins: ["extra", "cc-plugin-agents-md", "cc-plugin-telemetry"] } }]),
    );
    expect(report.warnings).toEqual(["the session started MCP servers: leaky", "the session loaded plugins: extra"]);
    expect(report.builtinPlugins).toEqual(["cc-plugin-agents-md", "cc-plugin-telemetry"]);
  });

  test("only built-in plugins: no warning", async () => {
    const report = await run(envWith([{ action: { plugins: ["cc-plugin-agents-md"] } }]));
    expect(report.warnings).toEqual([]);
    expect(report.builtinPlugins).toEqual(["cc-plugin-agents-md"]);
  });

  test("a failed turn is an error that carries the CLI's own message", async () => {
    const env = envWith([{ action: { result: { is_error: true, text: "Invalid API key" }, exit: 1 } }]);
    const error = await run(env).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaudeCheckError);
    expect((error as Error).message).toContain("Invalid API key");
    expect((error as Error).message).not.toContain("usage limit");
  });

  test("a usage limit is named as one", async () => {
    const env = envWith([{ action: { result: { is_error: true, text: "You've hit your weekly usage limit" }, exit: 1 } }]);
    const error = await run(env).catch((e: unknown) => e);
    expect((error as Error).message).toContain("(usage limit)");
  });

  test("a turn that never answers is stopped at the timeout, tree and all", async () => {
    const started = Date.now();
    const error = await run(envWith([{ action: { hang: true } }]), 1500).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaudeCheckError);
    expect((error as Error).message).toContain("did not answer within 1.5s");
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  test("a program that is not there is an error that says what to set", async () => {
    const error = await modelCheck({ command: ["no-such-claude-program-for-test"], model: MODEL, env: process.env }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaudeCheckError);
    expect((error as Error).message).toContain("VERIHARNESS_CLAUDE_BIN");
  });
});

describe("the program to run", () => {
  test("--claude-bin, then VERIHARNESS_CLAUDE_BIN, then claude from PATH", () => {
    expect(claudeCommand("/a/claude", { VERIHARNESS_CLAUDE_BIN: "/b/claude" })).toEqual(["/a/claude"]);
    expect(claudeCommand(undefined, { VERIHARNESS_CLAUDE_BIN: "/b/claude" })).toEqual(["/b/claude"]);
    expect(claudeCommand("", { VERIHARNESS_CLAUDE_BIN: "" })).toEqual(["claude"]);
    expect(claudeCommand(undefined, {})).toEqual(["claude"]);
  });

  test("startCheck answers with the version the program prints", () => {
    expect(startCheck([process.execPath, STUB], { STUB_VERSION: "3.0.1" })).toEqual({ ok: true, version: "3.0.1 (Claude Code stub)" });
  });

  test("startCheck says why a program cannot run", () => {
    const result = startCheck(["no-such-claude-program-for-test"], process.env);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("cannot run Claude Code");
  });
});

describe("veriharness model-check --provider claude-code, the command line", () => {
  /** Run the command; what it wrote to stdout and stderr, and its exit code. */
  async function cli(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const outReal = process.stdout.write.bind(process.stdout);
    const errReal = process.stderr.write.bind(process.stderr);
    let stdout = "";
    let stderr = "";
    process.stdout.write = ((c: string | Uint8Array) => ((stdout += String(c)), true)) as typeof process.stdout.write;
    process.stderr.write = ((c: string | Uint8Array) => ((stderr += String(c)), true)) as typeof process.stderr.write;
    try {
      return { code: await modelCheckMain(argv), stdout, stderr };
    } finally {
      process.stdout.write = outReal;
      process.stderr.write = errReal;
    }
  }

  test("a model is required", async () => {
    const r = await cli("--provider", "claude-code");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--model is required for --provider claude-code");
  });

  test("options that configure a local model are refused by name", async () => {
    for (const [flag, value] of [["--temperature", "0.2"], ["--context-size", "8192"], ["--base-url", "http://x"], ["--top-p", "0.9"], ["--max-tokens", "9"]]) {
      const r = await cli("--provider", "claude-code", "--model", MODEL, flag!, value!);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(`${flag} not supported with --provider claude-code`);
    }
  });

  test("a program that cannot start exits 1, with the reason on stderr and nothing on stdout", async () => {
    const r = await cli("--provider", "claude-code", "--model", MODEL, "--claude-bin", "no-such-claude-program-for-test");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot run Claude Code");
    expect(r.stdout).toBe("");
  });

  test("the usage text names the provider", async () => {
    const r = await cli("--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--provider claude-code --model ID [--claude-bin PATH]");
  });
});
