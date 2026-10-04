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
 * Shared chat types for local model backends.
 *
 * The verifier's agent loop still runs inside pi. These types are the harness's
 * own view of a chat turn: request building, response parsing, streaming, tool
 * calls, JSON mode and token usage. Hosted providers stay inside pi.
 */

export type LocalProviderId = "ollama" | "llamacpp";

export type ModelErrorCode =
  | "unreachable"
  | "model_missing"
  | "unsupported"
  | "timeout"
  | "http"
  | "bad_response";

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly provider: string;

  constructor(provider: string, code: ModelErrorCode, message: string) {
    super(message);
    this.name = "ModelError";
    this.provider = provider;
    this.code = code;
  }
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON object encoded as text, matching the OpenAI function-call shape. */
  arguments: string;
}

export interface ToolSpec {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export type ToolChoice = "auto" | "none" | "required";

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: ToolChoice;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** Ollama `options.num_ctx`. llama-server takes context from its process flags. */
  contextSize?: number;
  /** Ask for a JSON object. A non-JSON body is an error, never a successful reply. */
  json?: boolean;
  stream?: boolean;
  timeoutMs?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResponse {
  model: string;
  message: ChatMessage;
  finishReason: string;
  usage?: TokenUsage;
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "done"; finishReason?: string; usage?: TokenUsage };

export interface Capabilities {
  /** `unknown` means the server did not say; a required tool call is the check. */
  tools: boolean | "unknown";
  /** `unknown` means JSON mode is attempted and rejected if the server or body disagrees. */
  json: boolean | "unknown";
  /** Context the server is actually configured with, when it reports one. */
  contextSize?: number;
}

export interface ProbeResult {
  model: string;
  capabilities: Capabilities;
  /** Models the server currently has loaded or pulled. */
  models: string[];
}

export interface ModelBackend {
  readonly id: LocalProviderId;
  readonly model: string;
  readonly baseUrl: string;
  probe(): Promise<ProbeResult>;
  complete(req: ChatRequest): Promise<ChatResponse>;
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
}

export function argumentsToJson(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "{}";
  return JSON.stringify(value);
}

export function foldEvents(model: string, events: StreamEvent[]): ChatResponse {
  let text = "";
  const toolCalls: ToolCall[] = [];
  let finishReason = "stop";
  let usage: TokenUsage | undefined;
  for (const event of events) {
    if (event.type === "text") text += event.text;
    else if (event.type === "tool_call") toolCalls.push(event.toolCall);
    else {
      if (event.finishReason) finishReason = event.finishReason;
      if (event.usage) usage = event.usage;
    }
  }
  if (toolCalls.length && finishReason === "stop") finishReason = "tool_calls";
  return {
    model,
    finishReason,
    usage,
    message: {
      role: "assistant",
      content: text.length ? text : null,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    },
  };
}

export function assertJsonContent(provider: string, content: string | null): void {
  const text = (content ?? "").trim();
  try {
    JSON.parse(text);
  } catch {
    throw new ModelError(
      provider,
      "bad_response",
      `model returned text that is not JSON after a JSON-mode request, so the reply was rejected. ` +
        `First 200 characters: ${JSON.stringify(text.slice(0, 200))}`,
    );
  }
}

export function assertRequiredTools(provider: string, req: ChatRequest, response: ChatResponse): void {
  if (!req.tools?.length || req.toolChoice !== "required") return;
  if (response.message.toolCalls?.length) return;
  throw new ModelError(
    provider,
    "unsupported",
    `model '${response.model}' was required to call a tool and returned none. ` +
      `It may not support tool calling. The verifier needs tools (read, bash, write); ` +
      `see docs/local-models.md.`,
  );
}
