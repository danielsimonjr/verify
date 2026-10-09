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
import { CLAUDE_CODE_WINDOWS, claudeCodeWindow } from "../config.js";
import { createBackend, resolveLocalConfig, type BackendDeps, type ContextSize } from "./config.js";
import { enforceContext } from "./prepare.js";

/** Where a window came from: an explicit number, the server (loaded, num_ctx, n_ctx) or the Claude table. */
export type WindowSource = "explicit" | "loaded" | "num_ctx" | "n_ctx" | "table";

/** A context window in tokens and its source. */
export interface ResolvedWindow {
  window: number;
  source: WindowSource;
}

/** The model whose window resolveWindow finds. */
export interface WindowModel {
  provider: string;
  model: string;
  baseUrl?: string;
  contextSize?: ContextSize;
}

/** The window of `m`: the explicit size once the server confirms it fits, else what the server or the table reports. */
export async function resolveWindow(m: WindowModel, deps: BackendDeps = {}): Promise<ResolvedWindow> {
  if (isClaudeCodeProvider(m.provider)) return tableWindow(m);
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

function tableWindow(m: WindowModel): ResolvedWindow {
  const window = claudeCodeWindow(m.model);
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
