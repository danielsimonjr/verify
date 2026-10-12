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

/** The class of a `ModelError`: why a call to a local model server failed. */
export type ModelErrorCode =
  | "unreachable"
  | "model_missing"
  | "unsupported"
  | "timeout"
  | "http"
  | "bad_response";

/** The error that the model layer throws. `provider` names the backend and `code` gives the class of failure. */
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

/** One tool call that the model made: a call `id`, the tool `name`, and its arguments. */
export interface ToolCall {
  id: string;
  name: string;
  /** JSON object encoded as text, matching the OpenAI function-call shape. */
  arguments: string;
}

/** A tool that a request offers to the model: its `name`, an optional `description`, and a JSON Schema for its `parameters`. */
export interface ToolSpec {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

/**
 * One message of a chat. An `assistant` message may carry `toolCalls`; a `tool` message answers one call
 * and sets `toolCallId`. `content` is `null` when a message holds only tool calls.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

/** Whether the model may call a tool (`auto`), must not (`none`), or must call at least one (`required`). */
export type ToolChoice = "auto" | "none" | "required";

/** One chat request to a backend: the messages, the tools on offer, and the sampling and limit settings. */
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

/** The token counts of one reply: tokens read from the prompt and tokens written. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** A complete reply: the model name, the assistant `message`, the `finishReason`, and the `usage` when the server reports it. */
export interface ChatResponse {
  model: string;
  message: ChatMessage;
  finishReason: string;
  usage?: TokenUsage;
}

/** One event of a streamed reply: a piece of text, a finished tool call, or the last event with the finish reason and usage. */
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "done"; finishReason?: string; usage?: TokenUsage };

/**
 * Which weights a model name stands for. A tag can be re-created under the same name, so a record that
 * names the tag alone cannot tell two runs apart: the digest can.
 */
export interface ModelIdentity {
  /** The server's digest of the model (Ollama: the `digest` of its `/api/tags` entry). */
  digest: string;
  /** The quantization the server reports, such as `Q4_K_M`; absent when it does not say. */
  quantization?: string;
}

/** The identity as ` digest=D quantization=Q` for a log line; empty when the server listed none. */
export function describeIdentity(identity: ModelIdentity | undefined): string {
  if (!identity) return "";
  return ` digest=${identity.digest}${identity.quantization ? ` quantization=${identity.quantization}` : ""}`;
}

/**
 * What a probe found out about a model: tool and JSON-mode support, the context window and where it came
 * from, the identity, and the tool-list placement.
 */
export interface Capabilities {
  /** `unknown` means the server did not say; a required tool call is the check. */
  tools: boolean | "unknown";
  /** `unknown` means JSON mode is attempted and rejected if the server or body disagrees. */
  json: boolean | "unknown";
  /** Context the server is actually configured with, when it reports one. */
  contextSize?: number;
  /** Where `contextSize` came from: a loaded Ollama model, Ollama's `num_ctx`, or llama.cpp's `n_ctx`. */
  contextSource?: "loaded" | "num_ctx" | "n_ctx";
  /** The model's digest and quantization, when the server lists them. */
  identity?: ModelIdentity;
  /**
   * Where the chat template prints the tool list: `system` (every turn) or `message` (with the last user
   * message only). Absent when the server does not show the template or it names no tools.
   */
  toolList?: "system" | "message";
}

/** What a backend's `probe` returns: the model name it resolved, the capabilities it found, and the model names on the server. */
export interface ProbeResult {
  model: string;
  capabilities: Capabilities;
  /** Models the server currently has loaded or pulled. */
  models: string[];
}

/**
 * A client for one local model server and one model. `probe` reads the server's capabilities,
 * `complete` returns a whole reply, and `stream` yields the reply as events.
 */
export interface ModelBackend {
  readonly id: LocalProviderId;
  readonly model: string;
  readonly baseUrl: string;
  probe(): Promise<ProbeResult>;
  complete(req: ChatRequest): Promise<ChatResponse>;
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
}

/** Return tool-call arguments as JSON text: a string unchanged, `{}` for a missing value, and `JSON.stringify` of anything else. */
export function argumentsToJson(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "{}";
  return JSON.stringify(value);
}

/**
 * Join stream events into one `ChatResponse`. Text events become the content, tool-call events become
 * `toolCalls`, and the `done` event gives the finish reason and usage. A reply with tool calls and the
 * reason `stop` gets the reason `tool_calls`.
 */
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

/**
 * Throw a `bad_response` `ModelError` when `content` is not valid JSON, after a request that asked for
 * JSON mode. The message holds the first 200 characters.
 */
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

/**
 * Throw an `unsupported` `ModelError` when the request offered tools with `toolChoice` `required` and the
 * response holds no tool call.
 */
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
