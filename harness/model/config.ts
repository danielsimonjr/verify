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

import type { FetchLike } from "./http.js";
import { LlamaCppBackend } from "./llamacpp.js";
import { MIN_CONTEXT_WINDOW } from "./messages.js";
import { OllamaBackend } from "./ollama.js";
import type { LocalProviderId, ModelBackend } from "./types.js";
import { normalizeBaseUrl } from "./url.js";

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_LLAMACPP_BASE_URL = "http://127.0.0.1:8080";
export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_RETRIES = 2;
/** Placeholder pi stores so a keyless local server still appears selectable. Never sent by this client. */
export const PI_PLACEHOLDER_API_KEY = "local";
export const DEFAULT_PI_MAX_TOKENS = 8192;

/**
 * How a batch worker is sampled when the caller sets nothing. Only a pi worker takes this: the verifier
 * and the driver set their own values.
 *
 * The temperature pulls two ways, and the value is where they meet (llama3.1:8b through Ollama):
 * - The first turn must be a tool call, not prose with the call written as text. Structured first
 *   turns: 85% at the server default (0.8; 123 of 145), 95% at 0.7, 96% at 0.6 (77 of 80), 100% at
 *   0.4 and at 0.2. A turn that failed costs one short retry.
 * - A session in a loop must be able to leave it. From a position that had repeated one call, the next
 *   call repeated it again in 2 of 10 samples at 0.8, 3 at 0.7, 5 at 0.6, 8 at 0.4 and 9 at 0.2. The
 *   repeat guard (`pi-extensions/repeat-guard.ts`) ends a loop that remains, but a model that was
 *   never in one needs no guard.
 *
 * 0.6 is the highest value that keeps the first turn structured. No repetition penalty is set: from a
 * loop position, with a penalty of 0.3 to 1.0, 7 to 10 of 10 samples still repeated the call (the
 * penalty window is far shorter than the loop), and a penalty works against the keys that a JSON
 * report repeats on every row. `--frequency-penalty` is there for a model that needs it.
 */
export const WORKER_SAMPLING = { temperature: 0.6 } as const;

/**
 * A fully resolved local-model setting: the provider is canonical, the model and base URL are set, and
 * the timeout and retry count have values.
 */
export interface LocalModelConfig {
  provider: LocalProviderId;
  model: string;
  baseUrl: string;
  temperature?: number;
  topP?: number;
  /** OpenAI `frequency_penalty`: a token is less likely each time it was already written. */
  frequencyPenalty?: number;
  maxTokens?: number;
  contextSize?: number;
  timeoutMs: number;
  retries: number;
}

/**
 * The raw, partly filled setting that `resolveLocalConfig` accepts. Every field is optional: an unset
 * field falls back to its `VERIHARNESS_*` environment variable in `env`, then to a default.
 */
export interface LocalModelInput {
  provider?: string;
  model?: string;
  baseUrl?: string;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  /** Used for a value that neither the input nor the environment sets. */
  defaults?: { temperature?: number; frequencyPenalty?: number };
  maxTokens?: number;
  /** `auto` is the same as omitted: the server decides. */
  contextSize?: ContextSize;
  timeoutMs?: number;
  retries?: number;
  env?: NodeJS.ProcessEnv;
}

/** A context window in tokens, or `auto` for the window the server or the table reports. */
export type ContextSize = number | "auto";

/**
 * Parse a `--context-size` value. `auto` in any case returns `"auto"`. A number must be a whole number
 * above MIN_CONTEXT_WINDOW (4096): a window at or below it holds no verifier task.
 */
export function parseContextSize(raw: string | undefined, name: string): ContextSize | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw.trim().toLowerCase() === "auto") return "auto";
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= MIN_CONTEXT_WINDOW) {
    throw new Error(`${name} must be 'auto' or a whole number above ${MIN_CONTEXT_WINDOW}, not '${raw}'`);
  }
  return n;
}

/** Test seams for `createBackend`: a replacement `fetch`, and the base delay in milliseconds between retries. */
export interface BackendDeps {
  fetch?: FetchLike;
  retryDelayMs?: number;
}

/**
 * Map a provider name to `ollama` or `llamacpp`, ignoring case and outer spaces. Accepts `llama.cpp`,
 * `llama-cpp` and `llama_cpp` for `llamacpp`. Returns `undefined` for any other name.
 */
export function canonicalLocalProvider(name: string | undefined): LocalProviderId | undefined {
  const n = name?.trim().toLowerCase();
  if (n === "ollama") return "ollama";
  if (n === "llamacpp" || n === "llama.cpp" || n === "llama-cpp" || n === "llama_cpp") return "llamacpp";
  return undefined;
}

/** Return true when `name` is a local provider name that `canonicalLocalProvider` accepts. */
export function isLocalProvider(name: string | undefined): name is LocalProviderId {
  return canonicalLocalProvider(name) !== undefined;
}

/**
 * Turn a `LocalModelInput` into a `LocalModelConfig`. Each value comes from the input, then from its
 * `VERIHARNESS_*` environment variable, then from a default. Throws when the provider is not local,
 * the model is empty, or a number is invalid.
 */
export function resolveLocalConfig(input: LocalModelInput): LocalModelConfig {
  const provider = canonicalLocalProvider(input.provider);
  if (!provider) {
    throw new Error(
      `provider '${input.provider ?? ""}' is not a local backend (expected ollama or llamacpp)`,
    );
  }
  const model = input.model?.trim();
  if (!model) {
    throw new Error(`--model is required for --provider ${provider}`);
  }
  const env = input.env ?? process.env;
  return {
    provider,
    model,
    baseUrl: normalizeBaseUrl(input.baseUrl ?? baseUrlFromEnv(provider, env)),
    temperature:
      input.temperature ?? optionalNumber(env.VERIHARNESS_TEMPERATURE, "VERIHARNESS_TEMPERATURE") ?? input.defaults?.temperature,
    topP: input.topP ?? optionalNumber(env.VERIHARNESS_TOP_P, "VERIHARNESS_TOP_P"),
    frequencyPenalty:
      input.frequencyPenalty ??
      optionalNumber(env.VERIHARNESS_FREQUENCY_PENALTY, "VERIHARNESS_FREQUENCY_PENALTY") ??
      input.defaults?.frequencyPenalty,
    maxTokens: positiveInteger(
      input.maxTokens ?? optionalNumber(env.VERIHARNESS_MAX_TOKENS, "VERIHARNESS_MAX_TOKENS"),
      "max tokens",
    ),
    contextSize: positiveInteger(
      input.contextSize === "auto"
        ? undefined
        : (input.contextSize ?? optionalNumber(env.VERIHARNESS_CONTEXT_SIZE, "VERIHARNESS_CONTEXT_SIZE")),
      "context size",
    ),
    timeoutMs: input.timeoutMs === undefined ? timeoutFromEnv(env) : positiveTimeout(input.timeoutMs),
    retries: input.retries === undefined ? retriesFromEnv(env) : nonNegativeInteger(input.retries, "retries"),
  };
}

/**
 * Build the `OllamaBackend` or the `LlamaCppBackend` for `config.provider`, with the config's timeout and
 * retry count. Ollama gets the base URL without a trailing `/v1`.
 */
export function createBackend(config: LocalModelConfig, deps: BackendDeps = {}): ModelBackend {
  const http = {
    fetch: deps.fetch,
    timeoutMs: config.timeoutMs,
    retries: config.retries,
    retryDelayMs: deps.retryDelayMs,
  };
  if (config.provider === "ollama") {
    return new OllamaBackend(config.model, apiRoot(config.baseUrl), http);
  }
  return new LlamaCppBackend(config.model, config.baseUrl, http);
}

function apiRoot(baseUrl: string): string {
  return baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
}

function baseUrlFromEnv(provider: LocalProviderId, env: NodeJS.ProcessEnv): string {
  if (provider === "ollama") {
    return (
      env.VERIHARNESS_OLLAMA_BASE_URL ||
      env.OLLAMA_HOST ||
      DEFAULT_OLLAMA_BASE_URL
    );
  }
  return env.VERIHARNESS_LLAMACPP_BASE_URL || env.LLAMA_BASE_URL || DEFAULT_LLAMACPP_BASE_URL;
}

function optionalNumber(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`invalid ${name} '${raw}'`);
  return n;
}

function positiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

/** A zero, negative or fractional timeout is an input error: zero aborts every request at once, not "no limit". */
function positiveTimeout(ms: number): number {
  if (!Number.isInteger(ms) || ms <= 0) throw new Error("request timeout must be positive and a whole number of milliseconds");
  return ms;
}

/**
 * A count of seconds, which may be fractional, as whole milliseconds. The product is rounded so that
 * 1.001 s is 1001 ms, not 1000.9999999999999; a value below one millisecond is an input error.
 */
export function secondsToMs(seconds: number, name: string): number {
  if (!(seconds > 0)) throw new Error(`${name} must be positive`);
  // Before rounding: 0.0005 s would round up to 1 ms and pass.
  if (seconds < 0.001) throw new Error(`${name} must be at least 0.001 seconds`);
  const ms = Math.round(seconds * 1000);
  if (!Number.isFinite(ms)) throw new Error(`${name} must be a finite number of seconds`);
  return ms;
}

function timeoutFromEnv(env: NodeJS.ProcessEnv): number {
  const seconds = optionalNumber(env.VERIHARNESS_MODEL_TIMEOUT, "VERIHARNESS_MODEL_TIMEOUT");
  if (seconds === undefined) return DEFAULT_TIMEOUT_MS;
  if (seconds <= 0) throw new Error("VERIHARNESS_MODEL_TIMEOUT must be positive");
  return secondsToMs(seconds, "VERIHARNESS_MODEL_TIMEOUT");
}

function retriesFromEnv(env: NodeJS.ProcessEnv): number {
  const n = optionalNumber(env.VERIHARNESS_MODEL_RETRIES, "VERIHARNESS_MODEL_RETRIES");
  if (n === undefined) return DEFAULT_RETRIES;
  if (!Number.isInteger(n) || n < 0) throw new Error("VERIHARNESS_MODEL_RETRIES must be a non-negative integer");
  return n;
}
