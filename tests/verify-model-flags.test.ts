import { describe, expect, test } from "bun:test";

import { parseDriverArgv } from "../harness/driver.ts";
import { canonicalLocalProvider } from "../harness/model/index.ts";
import { flagValue, normalizeArgv, withModelOverride } from "../harness/model/flags.ts";
import { flagsForLane } from "../harness/runner.ts";

/**
 * `--driver-arg --provider=ollama` on a hosted lane [4178394569]. The runner decides whether to
 * start the hosted proxy from `flagValue`, and the driver then parses the same flags with
 * `util.parseArgs`. The two must agree, for the `--key=value` form and for repeated flags.
 */

/** What the runner asks before it starts `litellm_up.sh` (harness/runner.ts, the vertex-litellm check). */
function startsHostedProxy(lane: string, driverArgs: string[]): boolean {
  return flagValue(flagsForLane(lane, driverArgs), "--provider") === "vertex-litellm";
}

function driverView(flags: string[]) {
  const parsed = parseDriverArgv(["ws", ...flags]);
  if ("error" in parsed) throw new Error(`driver rejected ${JSON.stringify(flags)}: ${parsed.error}`);
  return parsed.args;
}

describe("runner flag merge matches the driver's parser", () => {
  test("an equals-form local provider on the opus lane replaces the Claude Code lane and starts no proxy", () => {
    const driverArgs = ["--contract", "artifact", ...withModelOverride([], ["--provider=ollama", "--model=qwen"])];
    const merged = flagsForLane("opus", driverArgs);
    expect(merged).toEqual(["--contract", "artifact", "--provider", "ollama", "--model", "qwen"]);
    expect(merged.join(" ")).not.toContain("vertex-litellm");
    expect(merged).not.toContain("--thinking");
    expect(startsHostedProxy("opus", driverArgs)).toBe(false);
    expect(startsHostedProxy("opus", ["--contract", "artifact"])).toBe(false);
  });

  test("a Claude Code lane has no thinking level, and an explicit one survives a local switch", () => {
    expect(flagsForLane("opus", ["--contract", "artifact"])).not.toContain("--thinking");
    const merged = flagsForLane("opus", ["--provider=ollama", "--model=q", "--thinking=low"]);
    expect(flagValue(merged, "--thinking")).toBe("low");
    expect(merged.filter((arg) => arg === "--thinking")).toHaveLength(1);
  });

  test("normalizeArgv splits --key=value once and leaves a split argv alone", () => {
    const once = normalizeArgv(["--provider=ollama", "--model", "a=b", "--base-url=http://h:1/x?y=z"]);
    expect(once).toEqual(["--provider", "ollama", "--model", "a=b", "--base-url", "http://h:1/x?y=z"]);
    expect(normalizeArgv(once)).toEqual(once);
  });

  const vectors: string[][] = [
    ["--provider=ollama", "--model=qwen"],
    ["--provider", "vertex-litellm", "--provider=ollama", "--model", "qwen"],
    ["--provider=ollama", "--provider", "google-vertex", "--model", "m"],
    ["--provider=llama.cpp", "--model=m.gguf", "--thinking=low"],
    ["--model=a", "--model", "b", "--provider", "ollama"],
    ["--provider", "ollama", "--provider=llamacpp", "--model", "m"],
  ];

  for (const vector of vectors) {
    test(`flagValue and the driver read the same final values: ${vector.join(" ")}`, () => {
      const lane = ["--contract", "artifact", ...vector];
      for (const flags of [lane, flagsForLane("opus", lane), flagsForLane("fable", lane)]) {
        const args = driverView(flags);
        const rawProvider = flagValue(flags, "--provider");
        expect(args.provider).toBe(canonicalLocalProvider(rawProvider) ?? rawProvider);
        expect(args.model).toBe(flagValue(flags, "--model"));
        expect(args.thinking).toBe(flagValue(flags, "--thinking"));
      }
    });
  }

  test("the last occurrence wins, whichever form it is written in", () => {
    expect(flagValue(["--provider=a", "--provider", "b"], "--provider")).toBe("b");
    expect(flagValue(["--provider", "a", "--provider=b"], "--provider")).toBe("b");
    expect(flagValue(["--provider", "a", "--model", "m"], "--provider")).toBe("a");
    expect(flagValue(["--provider"], "--provider")).toBeUndefined();
  });
});
