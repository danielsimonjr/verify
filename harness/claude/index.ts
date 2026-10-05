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

export { classifyFailure } from "./errors.js";
export type { FailureKind } from "./errors.js";
export { KEPT_VARIABLES, SESSION_MARKERS, withoutSessionMarkers } from "./env.js";
export { claudeConfigDir, findPersisted, movePersisted } from "./persisted.js";
export { ClaudeCheckError, claudeCommand, modelCheck, startCheck } from "./preflight.js";
export type { ModelCheckOptions, ModelCheckReport } from "./preflight.js";
export {
  CLAUDE_CODE_PROVIDER,
  PI_TO_CLAUDE_TOOL,
  UNSUPPORTED_WITH_CLAUDE_CODE,
  USAGE_LIMIT_EXIT,
  claudeTools,
  isClaudeCodeProvider,
} from "./provider.js";
export { claudeOwnRecord, parseStream, splitPlugins } from "./stream.js";
export type { StreamInit, StreamResult } from "./stream.js";
export { ClaudeRuntime, ClaudeSession, claudeArgs } from "./turn.js";
export type { ClaudeArgsInput, ClaudeRuntimeOptions } from "./turn.js";
