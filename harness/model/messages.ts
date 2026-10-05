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

import { errorText, TransportError } from "./http.js";
import { ModelError, type ChatRequest, type LocalProviderId } from "./types.js";

export function unreachableError(provider: LocalProviderId, baseUrl: string, detail: string): ModelError {
  const hint =
    provider === "ollama"
      ? `Ollama is not reachable at ${baseUrl}. Start it with \`ollama serve\` ` +
        `(the default address is http://127.0.0.1:11434), then pull a model with \`ollama pull <name>\`.`
      : `llama-server is not reachable at ${baseUrl}. Start it with ` +
        `\`llama-server -m <model.gguf> --host 127.0.0.1 --port 8080 --jinja -c 32768\`. ` +
        `\`--jinja\` is required for tool calling. Do not pass \`--api-key\`: this harness does not send one.`;
  return new ModelError(provider, "unreachable", `${hint} (${detail})`);
}

export function timeoutError(provider: LocalProviderId, detail: string): ModelError {
  return new ModelError(
    provider,
    "timeout",
    `${detail} Raise --request-timeout (seconds) or VERIHARNESS_MODEL_TIMEOUT if the model is still loading.`,
  );
}

export function modelMissingError(provider: LocalProviderId, model: string, baseUrl: string, extra?: string): ModelError {
  const hint =
    provider === "ollama"
      ? `Ollama at ${baseUrl} does not have model '${model}'. Pull it with \`ollama pull ${model}\`.`
      : `llama-server at ${baseUrl} is not serving model '${model}'. ` +
        (extra ? `${extra} ` : "") +
        `Start it with \`-m <file.gguf>\` (single model) or load the model in router mode, ` +
        `and pass --model with the id \`GET /v1/models\` reports.`;
  return new ModelError(provider, "model_missing", hint);
}

export function toolsUnsupportedError(provider: LocalProviderId, model: string, detail?: string): ModelError {
  const why = detail ? ` Server said: ${detail}` : "";
  const hint =
    provider === "ollama"
      ? `Model '${model}' does not support tool calling, which the verifier requires (read, bash, write). ` +
        `Choose a model Ollama lists with the tools capability (\`ollama show ${model}\`).`
      : `Model '${model}' does not support tool calling. Restart llama-server with \`--jinja\` ` +
        `and a chat template that implements tools. The verifier cannot fall back to plain text: ` +
        `it would not write a ledger.`;
  return new ModelError(provider, "unsupported", `${hint}${why}`);
}

export function jsonUnsupportedError(provider: LocalProviderId, model: string, detail?: string): ModelError {
  const why = detail ? ` Server said: ${detail}` : "";
  return new ModelError(
    provider,
    "unsupported",
    `model '${model}' does not support JSON mode, and the request asked for it. ` +
      `The harness does not drop JSON mode and parse free text.${why}`,
  );
}

export function contextUnknownError(provider: LocalProviderId, model: string, want?: number): ModelError {
  if (provider === "ollama") {
    const asked = want === undefined ? "" : ` --context-size ${want} cannot be guaranteed.`;
    return new ModelError(
      "ollama",
      "unsupported",
      `Ollama model '${model}' does not advertise num_ctx.${asked} ` +
        `A loaded model reports its effective window as context_length on GET /api/ps; otherwise the harness reads the num_ctx parameter from ollama show. ` +
        `The architecture context_length in model_info is not that window, and the harness will not invent one. ` +
        `Set it in a variant: put \`FROM ${model}\` and \`PARAMETER num_ctx 32768\` on two lines of a file named Modelfile, run \`ollama create ${model}-32k -f Modelfile\` ` +
        `(it reads no Modelfile from standard input) and pass --model ${model}-32k; ollama show reports it at once. Or ` +
        `restart the server with \`OLLAMA_CONTEXT_LENGTH=32768 ollama serve\` and then load the model ` +
        `(\`ollama run ${model} ""\`) so GET /api/ps reports the window it uses. Then retry.`,
    );
  }
  const asked = want === undefined ? "" : ` --context-size ${want} cannot be checked against the server.`;
  return new ModelError(
    "llamacpp",
    "unsupported",
    `llama-server did not report n_ctx for model '${model}'.${asked} ` +
      `Preflight reads GET /props?model=<id>, and GET /props only when that query returns 404. ` +
      `Restart llama-server with \`-c 32768\` so n_ctx is present. The harness will not assume a context window.`,
  );
}

/** pi 0.84.4 withholds this many tokens, so a window at or below the reserve cannot generate. */
export const PI_CONTEXT_RESERVE = 4096;

export function contextUnusableError(provider: LocalProviderId, model: string, window: number): ModelError {
  const how =
    provider === "ollama"
      ? "Raise it with `OLLAMA_CONTEXT_LENGTH=32768 ollama serve` and then load the model (`ollama run <model> \"\"`), or with a Modelfile PARAMETER num_ctx (`ollama create <name> -f Modelfile`)."
      : "Restart llama-server with `-c 32768`.";
  return new ModelError(
    provider,
    "unsupported",
    `${provider} model '${model}' would be registered with a ${window}-token context window. ` +
      `pi 0.84.4 reserves 4096 tokens, so a window of 4096 or less leaves no room for a reply. ${how}`,
  );
}

export function contextTooSmallError(
  provider: LocalProviderId,
  model: string,
  have: number,
  want: number,
): ModelError {
  const hint =
    provider === "ollama"
      ? `Ollama model '${model}' is configured with num_ctx ${have}, below the requested ${want}. ` +
        `The agent talks to Ollama's OpenAI-compatible endpoint, which uses the model's configured context. ` +
        `Set it with \`OLLAMA_CONTEXT_LENGTH=${want} ollama serve\` and then load the model (\`ollama run ${model} ""\`), or with ` +
        `a variant made from a Modelfile with \`PARAMETER num_ctx ${want}\` (\`ollama create <name> -f Modelfile\`, then --model <name>).`
      : `llama-server is running with context ${have}, below the requested ${want}. ` +
        `Restart it with \`-c ${want}\` (context is a server flag, not a per-request field).`;
  return new ModelError(provider, "unsupported", hint);
}

const TOOL_UNSUPPORTED = /tool/;
const TOOL_REASON = /not support|does not support|unsupported|unavailable|jinja/;
const JSON_UNSUPPORTED = /response_format|json mode|json_object|does not support json|unsupported json/;

export function httpFailure(
  provider: LocalProviderId,
  model: string,
  baseUrl: string,
  status: number,
  text: string,
  json: unknown,
): ModelError {
  const detail = errorText(json, text).slice(0, 500);
  const lower = detail.toLowerCase();
  if (status === 404 || (lower.includes("model") && lower.includes("not found"))) {
    return modelMissingError(provider, model, baseUrl, detail ? `Server said: ${detail}` : undefined);
  }
  if (TOOL_UNSUPPORTED.test(lower) && TOOL_REASON.test(lower)) {
    return toolsUnsupportedError(provider, model, detail);
  }
  if (JSON_UNSUPPORTED.test(lower)) {
    return jsonUnsupportedError(provider, model, detail);
  }
  return new ModelError(provider, "http", `${provider} request failed (HTTP ${status}) at ${baseUrl}: ${detail || text.slice(0, 300)}`);
}

export function transportFailure(provider: LocalProviderId, baseUrl: string, err: TransportError): ModelError {
  if (err.kind === "timeout") return timeoutError(provider, err.message);
  if (err.kind === "unreachable") return unreachableError(provider, baseUrl, err.message);
  return new ModelError(provider, "http", `${provider} connection failed at ${baseUrl}: ${err.message}`);
}

export function guardKnownFeatures(
  provider: LocalProviderId,
  model: string,
  req: ChatRequest,
  tools: boolean | "unknown" | undefined,
  json: boolean | "unknown" | undefined,
): void {
  if (req.tools?.length && tools === false) {
    throw toolsUnsupportedError(provider, model);
  }
  if (req.json && json === false) {
    throw jsonUnsupportedError(provider, model);
  }
}
