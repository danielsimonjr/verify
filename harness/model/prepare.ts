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
 * Preflight a local backend before pi starts.
 *
 * The verifier cannot do its job without tool calling. When the server says the
 * model lacks tools, this fails immediately. When the server does not say, one
 * short required tool call is the check; a text reply is a failure, not a run.
 * A positive result is cached so a batch does not repeat it. Negative results
 * are not cached, so restarting the server with tool support works on the next try.
 *
 * JSON mode is not required for a normal verifier run (records are files the
 * agent writes). Requesting it on the client still fails closed.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackend, type BackendDeps, type LocalModelConfig } from "./config.js";
import {
  PI_CONTEXT_RESERVE,
  contextTooSmallError,
  contextUnknownError,
  contextUnusableError,
  toolsUnsupportedError,
} from "./messages.js";
import { buildPiProvider, type PiProviderRecord } from "./pi.js";
import { LlamaCppBackend } from "./llamacpp.js";
import { OllamaBackend } from "./ollama.js";
import { ModelError, type ModelBackend, type ProbeResult } from "./types.js";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_PATH = join(tmpdir(), "veriharness-local-model-caps.json");

const PING_TOOL = {
  name: "ping",
  description: "Signal that tool calling works. Call this and do not answer in prose.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export interface PrepareDeps extends BackendDeps {
  cache?: boolean;
  assumeTools?: boolean;
  now?: () => number;
}

export interface PreparedLocal {
  config: LocalModelConfig;
  backend: ModelBackend;
  model: string;
  probe: ProbeResult;
  piProvider: PiProviderRecord;
  warnings: string[];
}

export async function prepareLocalProvider(config: LocalModelConfig, deps: PrepareDeps = {}): Promise<PreparedLocal> {
  const backend = createBackend(config, deps);
  const probe = await backend.probe();
  const warnings: string[] = [];
  enforceContext(config, probe, warnings);
  const tools = await confirmTools(config, backend, probe, deps, warnings);
  const capabilities = { ...probe.capabilities, tools };
  if (backend instanceof OllamaBackend || backend instanceof LlamaCppBackend) {
    backend.remember(capabilities);
  }
  const contextWindow = config.contextSize ?? probe.capabilities.contextSize;
  return {
    config,
    backend,
    model: probe.model,
    probe: { ...probe, capabilities },
    piProvider: buildPiProvider(config, probe.model, contextWindow),
    warnings,
  };
}

function enforceContext(config: LocalModelConfig, probe: ProbeResult, warnings: string[]): void {
  const have = probe.capabilities.contextSize;
  const want = config.contextSize;
  if (have === undefined) {
    throw contextUnknownError(config.provider, probe.model, want);
  }
  if (want !== undefined && want > have) {
    throw contextTooSmallError(config.provider, probe.model, have, want);
  }
  const window = want ?? have;
  if (window <= PI_CONTEXT_RESERVE) {
    throw contextUnusableError(config.provider, probe.model, window);
  }
  if (window < 8192) {
    warnings.push(
      `${config.provider} model '${probe.model}' is registered with a ${window}-token context. ` +
        `pi withholds ${PI_CONTEXT_RESERVE} tokens plus the prompt from that window, so replies can be ` +
        `cut to a few tokens and verifier tasks are long; raise it above 8192 ` +
        `(Ollama: OLLAMA_CONTEXT_LENGTH or a Modelfile num_ctx; llama-server: -c).`,
    );
  }
}

async function confirmTools(
  config: LocalModelConfig,
  backend: ModelBackend,
  probe: ProbeResult,
  deps: PrepareDeps,
  warnings: string[],
): Promise<boolean | "unknown"> {
  if (probe.capabilities.tools === false) {
    throw toolsUnsupportedError(config.provider, probe.model);
  }
  if (probe.capabilities.tools === true) return true;
  const assume = deps.assumeTools ?? process.env.VERIHARNESS_ASSUME_TOOLS === "1";
  if (assume) {
    warnings.push(
      `tool calling was not verified for '${probe.model}' because VERIHARNESS_ASSUME_TOOLS=1. ` +
        `If the model cannot call tools, the run will not produce a ledger.`,
    );
    return "unknown";
  }
  const useCache = deps.cache ?? process.env.VERIHARNESS_MODEL_CACHE !== "0";
  const key = `${config.provider}\0${config.baseUrl}\0${probe.model}`;
  const now = (deps.now ?? Date.now)();
  if (useCache && readCache(key, now) === true) return true;
  try {
    await backend.complete({
      messages: [{ role: "user", content: "Call the ping tool now." }],
      tools: [PING_TOOL],
      toolChoice: "required",
      maxTokens: 64,
      temperature: 0,
    });
  } catch (err) {
    if (err instanceof ModelError && (err.code === "unsupported" || err.code === "bad_response")) {
      throw toolsUnsupportedError(config.provider, probe.model, err.message);
    }
    throw err;
  }
  if (useCache) writeCache(key, now);
  return true;
}

function readCache(key: string, now: number): boolean | undefined {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Record<string, { at?: number }>;
    const hit = parsed[key];
    if (!hit || typeof hit.at !== "number") return undefined;
    if (now - hit.at > CACHE_TTL_MS) return undefined;
    return true;
  } catch {
    return undefined;
  }
}

function writeCache(key: string, now: number): void {
  let parsed: Record<string, { at: number }> = {};
  try {
    parsed = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Record<string, { at: number }>;
  } catch {
    parsed = {};
  }
  parsed[key] = { at: now };
  const tmp = `${CACHE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(parsed));
  renameSync(tmp, CACHE_PATH);
}
