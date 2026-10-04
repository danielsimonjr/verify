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
 * Project a resolved local backend into the pi agent registry.
 *
 * pi drives the verifier's tool loop and speaks OpenAI Chat Completions, so the
 * agent hits Ollama's `/v1` or llama-server's `/v1`. pi will not select a provider
 * that has no credential, so the registry carries a non-secret placeholder. The
 * harness HTTP client never sends it, and a default local server ignores it.
 */

import { ensureDir, writeJson } from "../fsutil.js";
import {
  DEFAULT_PI_CONTEXT,
  DEFAULT_PI_MAX_TOKENS,
  PI_PLACEHOLDER_API_KEY,
  type LocalModelConfig,
} from "./config.js";
import { apiRoots } from "./url.js";

export interface PiProviderRecord {
  id: string;
  config: Record<string, unknown>;
}

export function buildPiProvider(
  config: LocalModelConfig,
  resolvedModel: string,
  contextWindow?: number,
): PiProviderRecord {
  const window = contextWindow && contextWindow > 0 ? contextWindow : config.contextSize || DEFAULT_PI_CONTEXT;
  let maxTokens = config.maxTokens ?? DEFAULT_PI_MAX_TOKENS;
  if (maxTokens > window) maxTokens = window;
  const sampling: Record<string, number> = {};
  if (config.temperature !== undefined) sampling.temperature = config.temperature;
  if (config.topP !== undefined) sampling.top_p = config.topP;
  const model: Record<string, unknown> = {
    id: resolvedModel,
    name: `${resolvedModel} (${config.provider})`,
    reasoning: false,
    input: ["text"],
    contextWindow: window,
    maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  if (Object.keys(sampling).length) model.samplingParams = sampling;
  return {
    id: config.provider,
    config: {
      baseUrl: apiRoots(config.baseUrl).openai,
      api: "openai-completions",
      apiKey: PI_PLACEHOLDER_API_KEY,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
      models: [model],
    },
  };
}

/** Write a per-task pi home. The committed harness/pi-home/models.json is left alone. */
export function materializePiHome(dir: string, provider: PiProviderRecord): void {
  ensureDir(dir);
  writeJson(joinModels(dir), { providers: { [provider.id]: provider.config } });
}

function joinModels(dir: string): string {
  return `${dir.replace(/\/+$/, "")}/models.json`;
}
