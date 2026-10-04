import { describe, expect, test } from "bun:test";

import { main as cliMain } from "../harness/cli.ts";
import { resolveLocalConfig } from "../harness/model/index.ts";

/**
 * The shared configuration boundary: negative, zero, fractional or non-finite numbers must be an
 * input error for CLI, environment and programmatic callers alike [4178394554].
 */

async function runCli(argv: string[]): Promise<{ code: number; stderr: string }> {
  let stderr = "";
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await cliMain(argv), stderr };
  } finally {
    process.stderr.write = orig;
  }
}

describe("config boundary rejects unusable numbers [4178394554]", () => {
  const base = { provider: "ollama", model: "q", env: {} };

  test("context size: negative, zero, fractional and non-finite values, from input and from env", () => {
    for (const bad of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveLocalConfig({ ...base, contextSize: bad })).toThrow(/context size must be a positive integer/);
    }
    for (const bad of ["-1", "0", "2.5"]) {
      expect(() => resolveLocalConfig({ ...base, env: { VERIHARNESS_CONTEXT_SIZE: bad } })).toThrow(/positive integer/);
    }
    expect(() => resolveLocalConfig({ ...base, env: { VERIHARNESS_CONTEXT_SIZE: "abc" } })).toThrow(/invalid/);
    expect(resolveLocalConfig({ ...base, contextSize: 8192 }).contextSize).toBe(8192);
    expect(resolveLocalConfig({ ...base, env: { VERIHARNESS_CONTEXT_SIZE: "8192" } }).contextSize).toBe(8192);
  });

  test("max tokens would otherwise reach pi as maxTokens <= 0, which pi refuses to load", () => {
    for (const bad of [-1, 0, 1.5, Number.NaN]) {
      expect(() => resolveLocalConfig({ ...base, maxTokens: bad })).toThrow(/max tokens must be a positive integer/);
    }
    expect(() => resolveLocalConfig({ ...base, env: { VERIHARNESS_MAX_TOKENS: "-1" } })).toThrow(/positive integer/);
    expect(resolveLocalConfig({ ...base, maxTokens: 1 }).maxTokens).toBe(1);
    expect(resolveLocalConfig(base).maxTokens).toBeUndefined();
  });

  test("request timeout and retries get the same check on input that the env path already had", () => {
    for (const bad of [0, -5, Number.NaN]) {
      expect(() => resolveLocalConfig({ ...base, timeoutMs: bad })).toThrow(/request timeout must be positive/);
    }
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => resolveLocalConfig({ ...base, retries: bad })).toThrow(/retries must be a non-negative integer/);
    }
    expect(resolveLocalConfig({ ...base, timeoutMs: 1, retries: 0 })).toMatchObject({ timeoutMs: 1, retries: 0 });
    expect(() => resolveLocalConfig({ ...base, env: { VERIHARNESS_MODEL_TIMEOUT: "0" } })).toThrow(/must be positive/);
  });

  test("the CLI turns each of them into an input error before any request", async () => {
    // Port 9 is the discard port: even a regression that probed it could not reach a model server.
    const common = ["model-check", "--provider", "ollama", "--model", "q", "--base-url", "http://127.0.0.1:9"];
    for (const [flag, message] of [
      ["--context-size=-1", /context size must be a positive integer/],
      ["--context-size=1.5", /context size must be a positive integer/],
      ["--max-tokens=-1", /max tokens must be a positive integer/],
      ["--request-timeout=0", /request timeout must be positive/],
    ] as const) {
      const out = await runCli([...common, flag]);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(message);
      expect(out.stderr).not.toMatch(/Unable to connect|cannot connect|not reachable/);
    }
  });
});
