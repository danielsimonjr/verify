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

/** `veriharness model-check` — probe a local server without starting a task. */

import { parseArgs } from "node:util";
import { isMain } from "../runtime.js";
import { resolveLocalConfig } from "./config.js";
import { prepareLocalProvider } from "./prepare.js";
import { ModelError } from "./types.js";

const USAGE =
  "usage: veriharness model-check --provider ollama|llamacpp --model NAME " +
  "[--base-url URL] [--context-size N] [--temperature N] [--max-tokens N] [--top-p N] [--request-timeout S]\n";

function optionalNumber(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`invalid ${name} '${raw}'`);
  return n;
}

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
      },
    });
    if (values.help) {
      process.stdout.write(USAGE);
      return 0;
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
