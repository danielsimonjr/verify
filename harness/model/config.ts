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

export interface LocalModelConfig {
  provider: LocalProviderId;
  model: string;
  baseUrl: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  contextSize?: number;
  timeoutMs: number;
  retries: number;
}

export interface LocalModelInput {
  provider?: string;
  model?: string;
  baseUrl?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  contextSize?: number;
  timeoutMs?: number;
  retries?: number;
  env?: NodeJS.ProcessEnv;
}

export interface BackendDeps {
  fetch?: FetchLike;
  retryDelayMs?: number;
}

export function canonicalLocalProvider(name: string | undefined): LocalProviderId | undefined {
  const n = name?.trim().toLowerCase();
  if (n === "ollama") return "ollama";
  if (n === "llamacpp" || n === "llama.cpp" || n === "llama-cpp" || n === "llama_cpp") return "llamacpp";
  return undefined;
}

export function isLocalProvider(name: string | undefined): name is LocalProviderId {
  return canonicalLocalProvider(name) !== undefined;
}

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
    temperature: input.temperature ?? optionalNumber(env.VERIHARNESS_TEMPERATURE, "VERIHARNESS_TEMPERATURE"),
    topP: input.topP ?? optionalNumber(env.VERIHARNESS_TOP_P, "VERIHARNESS_TOP_P"),
    maxTokens: positiveInteger(
      input.maxTokens ?? optionalNumber(env.VERIHARNESS_MAX_TOKENS, "VERIHARNESS_MAX_TOKENS"),
      "max tokens",
    ),
    contextSize: positiveInteger(
      input.contextSize ?? optionalNumber(env.VERIHARNESS_CONTEXT_SIZE, "VERIHARNESS_CONTEXT_SIZE"),
      "context size",
    ),
    timeoutMs: input.timeoutMs === undefined ? timeoutFromEnv(env) : positiveTimeout(input.timeoutMs),
    retries: input.retries === undefined ? retriesFromEnv(env) : nonNegativeInteger(input.retries, "retries"),
  };
}

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
  if (!Number.isFinite(ms)) throw new Error(`${name} must be at least 0.001 seconds`);
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
