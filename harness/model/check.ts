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
 * `veriharness model-check` — probe a local server, or Claude Code, without starting a task.
 *
 * `--provider ollama|llamacpp` asks the server what it serves and whether the model can run a verifier.
 * `--provider claude-code` runs one isolated turn through the Claude Code CLI and reports the CLI version,
 * the model and the credential source it used.
 */

import { parseArgs } from "node:util";
import {
  ClaudeCheckError,
  UNSUPPORTED_WITH_CLAUDE_CODE,
  claudeCommand,
  isClaudeCodeProvider,
  modelCheck,
} from "../claude/index.js";
import { isMain } from "../runtime.js";
import { resolveLocalConfig } from "./config.js";
import { prepareLocalProvider } from "./prepare.js";
import { ModelError } from "./types.js";

const USAGE =
  "usage: veriharness model-check --provider ollama|llamacpp --model NAME " +
  "[--base-url URL] [--context-size N] [--temperature N] [--max-tokens N] [--top-p N] [--request-timeout S]\n" +
  "       veriharness model-check --provider claude-code --model ID [--claude-bin PATH] [--request-timeout S]\n";

function optionalNumber(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`invalid ${name} '${raw}'`);
  return n;
}

/** `model-check --provider claude-code`: one isolated turn, then what the CLI reports about itself. */
async function claudeCheck(values: Record<string, unknown>): Promise<number> {
  const model = typeof values.model === "string" ? values.model.trim() : "";
  if (model === "") {
    process.stderr.write("error: --model is required for --provider claude-code (a full model id)\n");
    process.stderr.write(USAGE);
    return 2;
  }
  const unsupported = UNSUPPORTED_WITH_CLAUDE_CODE.filter((n) => n !== "request-timeout" && values[n] !== undefined);
  if (unsupported.length) {
    process.stderr.write(`error: ${unsupported.map((n) => "--" + n).join(", ")} not supported with --provider claude-code\n`);
    return 2;
  }
  const timeoutSec = optionalNumber("request-timeout", values["request-timeout"] as string | undefined);
  try {
    const report = await modelCheck({
      command: claudeCommand(values["claude-bin"] as string | undefined),
      model,
      env: process.env,
      timeoutMs: timeoutSec === undefined ? undefined : timeoutSec * 1000,
    });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return err instanceof ClaudeCheckError ? 1 : 2;
  }
}

/** Run `model-check`; returns the exit code (0 ok, 1 the check failed, 2 wrong arguments). */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h", default: false },
        provider: { type: "string" },
        model: { type: "string" },
        "base-url": { type: "string" },
        "context-size": { type: "string" },
        temperature: { type: "string" },
        "max-tokens": { type: "string" },
        "top-p": { type: "string" },
        "request-timeout": { type: "string" },
        "claude-bin": { type: "string" },
      },
    });
    if (values.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    if (isClaudeCodeProvider(values.provider as string | undefined)) {
      // `await`: a rejection must reach the catch below, which exits 2 for a bad argument.
      return await claudeCheck(values as Record<string, unknown>);
    }
    const timeoutSec = optionalNumber("request-timeout", values["request-timeout"] as string | undefined);
    const config = resolveLocalConfig({
      provider: values.provider as string | undefined,
      model: values.model as string | undefined,
      baseUrl: values["base-url"] as string | undefined,
      contextSize: optionalNumber("context-size", values["context-size"] as string | undefined),
      temperature: optionalNumber("temperature", values.temperature as string | undefined),
      maxTokens: optionalNumber("max-tokens", values["max-tokens"] as string | undefined),
      topP: optionalNumber("top-p", values["top-p"] as string | undefined),
      timeoutMs: timeoutSec === undefined ? undefined : timeoutSec * 1000,
    });
    const prepared = await prepareLocalProvider(config);
    process.stdout.write(
      JSON.stringify(
        {
          provider: config.provider,
          model: prepared.model,
          baseUrl: config.baseUrl,
          capabilities: prepared.probe.capabilities,
          models: prepared.probe.models,
          warnings: prepared.warnings,
          piProvider: prepared.piProvider.id,
          piBaseUrl: (prepared.piProvider.config.baseUrl as string) ?? "",
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  } catch (err) {
    const message = err instanceof ModelError || err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${message}\n`);
    if (err instanceof Error && err.message.startsWith("provider")) {
      process.stderr.write(USAGE);
    }
    return err instanceof ModelError ? 1 : 2;
  }
}

if (isMain(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
