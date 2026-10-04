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

export {
  canonicalLocalProvider,
  createBackend,
  DEFAULT_LLAMACPP_BASE_URL,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_PI_CONTEXT,
  DEFAULT_PI_MAX_TOKENS,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  isLocalProvider,
  PI_PLACEHOLDER_API_KEY,
  resolveLocalConfig,
} from "./config.js";
export type { BackendDeps, LocalModelConfig, LocalModelInput } from "./config.js";
export { flagValue, withModelOverride } from "./flags.js";
export { materializePiHome, buildPiProvider } from "./pi.js";
export type { PiProviderRecord } from "./pi.js";
export { prepareLocalProvider } from "./prepare.js";
export type { PreparedLocal, PrepareDeps } from "./prepare.js";
export { ModelError } from "./types.js";
export type {
  Capabilities,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  LocalProviderId,
  ModelBackend,
  ProbeResult,
  StreamEvent,
  TokenUsage,
  ToolCall,
  ToolSpec,
} from "./types.js";
