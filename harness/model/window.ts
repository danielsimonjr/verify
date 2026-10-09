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
 * The context window a model runs with, and where that number came from. A local server decides its
 * own window (a loaded Ollama model, then `num_ctx`; llama.cpp's `n_ctx`). Claude Code reports none
 * before a run, so its window comes from CLAUDE_CODE_WINDOWS. An explicit number wins once the server
 * confirms it can hold it.
 */

import { isClaudeCodeProvider } from "../claude/provider.js";
import { CLAUDE_CODE_WINDOWS } from "../config.js";
import { createBackend, resolveLocalConfig, type BackendDeps, type ContextSize } from "./config.js";
import { enforceContext } from "./prepare.js";

export type WindowSource = "explicit" | "loaded" | "num_ctx" | "n_ctx" | "table";

export interface ResolvedWindow {
  window: number;
  source: WindowSource;
}

export interface WindowModel {
  provider: string;
  model: string;
  baseUrl?: string;
  contextSize?: ContextSize;
}

export async function resolveWindow(m: WindowModel, deps: BackendDeps = {}): Promise<ResolvedWindow> {
  if (isClaudeCodeProvider(m.provider)) return claudeCodeWindow(m);
  const config = resolveLocalConfig({
    provider: m.provider,
    model: m.model,
    baseUrl: m.baseUrl,
    contextSize: m.contextSize,
  });
  const probe = await createBackend(config, deps).probe();
  enforceContext(config, probe, []);
  if (config.contextSize !== undefined) return { window: config.contextSize, source: "explicit" };
  // enforceContext throws when the probe reports no window, so both fields are set here.
  return { window: probe.capabilities.contextSize!, source: probe.capabilities.contextSource! };
}

function claudeCodeWindow(m: WindowModel): ResolvedWindow {
  const window = CLAUDE_CODE_WINDOWS[m.model];
  if (window === undefined) {
    const known = Object.keys(CLAUDE_CODE_WINDOWS).join(", ");
    throw new Error(`no context window is known for Claude model '${m.model}' (known: ${known}); pass a number`);
  }
  if (typeof m.contextSize === "number") {
    if (m.contextSize > window) {
      throw new Error(`context size ${m.contextSize} is larger than the ${window}-token window of '${m.model}'`);
    }
    return { window: m.contextSize, source: "explicit" };
  }
  return { window, source: "table" };
}
