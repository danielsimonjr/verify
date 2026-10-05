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
 * Ollama native API (default http://127.0.0.1:11434).
 *
 * `/api/tags` and `/api/show` answer "is the server up?" and "is the model pulled?"
 * `/api/ps` reports the context of a model that is already loaded; `num_ctx` in
 * `ollama show` is the fallback. `/api/chat` carries tools, JSON mode (`format: "json"`),
 * `options.num_ctx` and token counts. Streaming is NDJSON: each chunk's tool calls are
 * new calls (a repeated id updates that call), and a stream without `done: true` is a
 * failure. The OpenAI-compatible `/v1` endpoint is what pi speaks during a verifier run.
 */

import { HttpClient, readLines, TransportError, type FetchLike } from "./http.js";
import {
  guardKnownFeatures,
  httpFailure,
  modelMissingError,
  transportFailure,
} from "./messages.js";
import { openAiTool } from "./openai_chat.js";
import {
  ModelError,
  type Capabilities,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ModelBackend,
  type ProbeResult,
  type StreamEvent,
  type TokenUsage,
  type ToolCall,
  argumentsToJson,
  assertJsonContent,
  assertRequiredTools,
  foldEvents,
} from "./types.js";

export interface OllamaDeps {
  fetch?: FetchLike;
  timeoutMs: number;
  retries: number;
  retryDelayMs?: number;
}

export function ollamaModelPresent(names: string[], wanted: string): boolean {
  const has = (name: string) => names.some((n) => n === name);
  if (has(wanted)) return true;
  if (!wanted.includes(":") && has(`${wanted}:latest`)) return true;
  if (wanted.endsWith(":latest") && has(wanted.slice(0, -":latest".length))) return true;
  return false;
}

export function parseOllamaNumCtx(parameters: unknown): number | undefined {
  if (typeof parameters !== "string") return undefined;
  const match = parameters.match(/(?:^|\n)\s*num_ctx\s+(\d+)/);
  return match ? Number(match[1]) : undefined;
}

export function parseOllamaContextLength(info: unknown): number | undefined {
  if (!info || typeof info !== "object") return undefined;
  let max = 0;
  for (const [key, value] of Object.entries(info as Record<string, unknown>)) {
    if (key.endsWith(".context_length") && typeof value === "number" && value > max) max = value;
  }
  return max || undefined;
}

export function parseOllamaToolCapability(capabilities: unknown): boolean | "unknown" {
  if (!Array.isArray(capabilities)) return "unknown";
  return capabilities.some((item) => String(item).toLowerCase() === "tools") ? true : false;
}

export function buildOllamaChatBody(model: string, req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: req.messages.map(toOllamaMessage),
    stream: Boolean(req.stream),
  };
  const options: Record<string, unknown> = {};
  if (req.temperature !== undefined) options.temperature = req.temperature;
  if (req.topP !== undefined) options.top_p = req.topP;
  if (req.maxTokens !== undefined) options.num_predict = req.maxTokens;
  if (req.contextSize !== undefined) options.num_ctx = req.contextSize;
  if (Object.keys(options).length) body.options = options;
  if (req.tools?.length) {
    body.tools = req.tools.map(openAiTool);
    if (req.toolChoice) body.tool_choice = req.toolChoice;
  }
  if (req.json) body.format = "json";
  return body;
}

function toOllamaMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    const out: Record<string, unknown> = { role: "tool", content: message.content ?? "" };
    if (message.name) out.tool_name = message.name;
    if (message.toolCallId) out.tool_call_id = message.toolCallId;
    return out;
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content ?? "",
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: safeObject(call.arguments),
        },
      })),
    };
  }
  return { role: message.role, content: message.content ?? "" };
}

function safeObject(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** The calls in a reply, in order. A call without a server id has an empty `id`. */
function toolCallsOf(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const fn = (rec.function ?? {}) as Record<string, unknown>;
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name) continue;
    const id = typeof rec.id === "string" && rec.id ? rec.id : "";
    out.push({
      id,
      name,
      arguments: argumentsToJson(fn.arguments),
    });
  }
  return out;
}

/** The context Ollama is actually using for a loaded model. `model_info` is not this. */
export function parseOllamaRunningContext(body: unknown, wanted: string): number | undefined {
  const models = Array.isArray((body as { models?: unknown } | null)?.models)
    ? ((body as { models: unknown[] }).models)
    : [];
  for (const item of models) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name : typeof rec.model === "string" ? rec.model : "";
    if (!name || !ollamaModelPresent([name], wanted)) continue;
    const ctx = rec.context_length;
    if (typeof ctx === "number" && Number.isFinite(ctx) && ctx > 0) return ctx;
  }
  return undefined;
}

export function parseOllamaChat(body: unknown, fallbackModel: string): ChatResponse {
  const rec = (body ?? {}) as Record<string, unknown>;
  const message = (rec.message ?? {}) as Record<string, unknown>;
  const toolCalls: ToolCall[] = [];
  accumulateToolCalls(toolCalls, toolCallsOf(message.tool_calls), { n: 0, generated: new Set() });
  const content = typeof message.content === "string" ? message.content : null;
  const model = typeof rec.model === "string" && rec.model ? rec.model : fallbackModel;
  const finish =
    typeof rec.done_reason === "string" ? rec.done_reason : toolCalls.length ? "tool_calls" : "stop";
  const usage = ollamaUsage(rec);
  return {
    model,
    finishReason: finish,
    usage,
    message: {
      role: "assistant",
      content: content && content.length ? content : null,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    },
  };
}

function ollamaUsage(rec: Record<string, unknown>): TokenUsage | undefined {
  const input = rec.prompt_eval_count;
  const output = rec.eval_count;
  if (typeof input !== "number" && typeof output !== "number") return undefined;
  return {
    inputTokens: typeof input === "number" ? input : 0,
    outputTokens: typeof output === "number" ? output : 0,
  };
}

export function pushOllamaChunk(
  payload: unknown,
): { text: string; toolCalls: ToolCall[]; done: boolean; finish?: string; usage?: TokenUsage; model?: string } {
  const rec = (payload ?? {}) as Record<string, unknown>;
  const message = (rec.message ?? {}) as Record<string, unknown>;
  const text = typeof message.content === "string" ? message.content : "";
  return {
    text,
    toolCalls: toolCallsOf(message.tool_calls),
    done: rec.done === true,
    finish: typeof rec.done_reason === "string" ? rec.done_reason : undefined,
    usage: ollamaUsage(rec),
    model: typeof rec.model === "string" ? rec.model : undefined,
  };
}

function ollamaFrameError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const err = (payload as Record<string, unknown>).error;
  if (typeof err === "string" && err.trim()) return err.trim();
  return undefined;
}

/** Id state for one reply: a counter for generated ids, and which calls got a generated id. */
interface ToolCallIds {
  n: number;
  generated: Set<ToolCall>;
}

/**
 * Later chunks add calls. A repeated server id updates that call; missing ids get one counter for
 * the whole reply. A generated id never merges with a server id: when a server call arrives with an
 * id that a generated call already holds, the generated call (our invention) takes a new id.
 */
function accumulateToolCalls(acc: ToolCall[], incoming: ToolCall[], ids: ToolCallIds): void {
  const nextFreeId = (): string => {
    let id = `call_${ids.n}`;
    while (acc.some((item) => item.id === id)) {
      ids.n += 1;
      id = `call_${ids.n}`;
    }
    ids.n += 1;
    return id;
  };
  for (const call of incoming) {
    if (call.id) {
      const existing = acc.find((item) => item.id === call.id && !ids.generated.has(item));
      if (existing) {
        if (call.name) existing.name = call.name;
        if (call.arguments && call.arguments !== "{}") existing.arguments = call.arguments;
        continue;
      }
      const clash = acc.find((item) => item.id === call.id);
      if (clash) clash.id = nextFreeId();
      acc.push({ ...call });
      continue;
    }
    const generated = { ...call, id: nextFreeId() };
    ids.generated.add(generated);
    acc.push(generated);
  }
}

export async function* parseOllamaNdjson(lines: AsyncIterable<string>): AsyncGenerator<StreamEvent> {
  let finish: string | undefined;
  let usage: TokenUsage | undefined;
  const toolCalls: ToolCall[] = [];
  const ids: ToolCallIds = { n: 0, generated: new Set() };
  let sawDone = false;
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const failed = ollamaFrameError(payload);
    if (failed) {
      throw new ModelError("ollama", "bad_response", `Ollama stream failed: ${failed}`);
    }
    const chunk = pushOllamaChunk(payload);
    if (chunk.text) yield { type: "text", text: chunk.text };
    if (chunk.toolCalls.length) accumulateToolCalls(toolCalls, chunk.toolCalls, ids);
    if (chunk.finish) finish = chunk.finish;
    if (chunk.usage) usage = chunk.usage;
    if (chunk.done) {
      sawDone = true;
      break;
    }
  }
  if (!sawDone) {
    throw new ModelError(
      "ollama",
      "bad_response",
      "Ollama stream ended before a terminal frame with done: true. The partial reply was discarded.",
    );
  }
  for (const call of toolCalls) yield { type: "tool_call", toolCall: call };
  yield { type: "done", finishReason: finish ?? (toolCalls.length ? "tool_calls" : undefined), usage };
}

export class OllamaBackend implements ModelBackend {
  readonly id = "ollama" as const;
  readonly model: string;
  readonly baseUrl: string;
  private readonly http: HttpClient;
  private capabilities: Capabilities | undefined;

  constructor(model: string, baseUrl: string, deps: OllamaDeps) {
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.http = new HttpClient(deps);
  }

  remember(capabilities: Capabilities): void {
    this.capabilities = capabilities;
  }

  async probe(): Promise<ProbeResult> {
    const tags = await this.getJson("/api/tags");
    const names = modelNames(tags.json);
    if (!ollamaModelPresent(names, this.model)) {
      throw modelMissingError("ollama", this.model, this.baseUrl);
    }
    let tools: boolean | "unknown" = "unknown";
    let numCtx: number | undefined;
    const show = await this.http.send(`${this.baseUrl}/api/show`, {
      method: "POST",
      body: { name: this.model },
    });
    if (show.status < 400) {
      const rec = (show.json ?? {}) as Record<string, unknown>;
      numCtx = parseOllamaNumCtx(rec.parameters);
      tools = parseOllamaToolCapability(rec.capabilities);
    }
    const running = await this.runningContext();
    const capabilities: Capabilities = {
      tools,
      json: true,
      contextSize: running ?? numCtx,
    };
    this.capabilities = capabilities;
    return { model: this.model, capabilities, models: names };
  }

  /** Loaded context wins over `num_ctx`. A missing or failed `/api/ps` leaves the show value in place. */
  private async runningContext(): Promise<number | undefined> {
    let res;
    try {
      res = await this.http.send(`${this.baseUrl}/api/ps`, { method: "GET" });
    } catch (err) {
      if (err instanceof TransportError) throw transportFailure("ollama", this.baseUrl, err);
      throw err;
    }
    if (res.status >= 400) return undefined;
    return parseOllamaRunningContext(res.json, this.model);
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    guardKnownFeatures("ollama", this.model, req, this.capabilities?.tools, this.capabilities?.json);
    const body = buildOllamaChatBody(this.model, { ...req, stream: false });
    const res = await this.post("/api/chat", body, req.timeoutMs);
    const parsed = parseOllamaChat(res, this.model);
    if (req.json && !parsed.message.toolCalls?.length) assertJsonContent("ollama", parsed.message.content);
    assertRequiredTools("ollama", req, parsed);
    return parsed;
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    guardKnownFeatures("ollama", this.model, req, this.capabilities?.tools, this.capabilities?.json);
    const body = buildOllamaChatBody(this.model, { ...req, stream: true });
    const events: StreamEvent[] = [];
    const res = await this.http.send(`${this.baseUrl}/api/chat`, {
      method: "POST",
      body,
      timeoutMs: req.timeoutMs,
      stream: true,
    });
    if (res.status >= 400 || !res.stream) {
      throw httpFailure("ollama", this.model, this.baseUrl, res.status, res.text, res.json);
    }
    for await (const event of parseOllamaNdjson(readLines(res.stream))) {
      events.push(event);
      if (event.type === "done") {
        const folded = foldEvents(this.model, events);
        if (req.json && !folded.message.toolCalls?.length) assertJsonContent("ollama", folded.message.content);
        assertRequiredTools("ollama", req, folded);
      }
      yield event;
    }
  }

  private async getJson(path: string): Promise<{ status: number; json: unknown; text: string }> {
    try {
      const res = await this.http.send(`${this.baseUrl}${path}`, { method: "GET" });
      if (res.status >= 400) throw httpFailure("ollama", this.model, this.baseUrl, res.status, res.text, res.json);
      return res;
    } catch (err) {
      if (err instanceof TransportError) throw transportFailure("ollama", this.baseUrl, err);
      throw err;
    }
  }

  private async post(path: string, body: unknown, timeoutMs?: number): Promise<unknown> {
    try {
      const res = await this.http.send(`${this.baseUrl}${path}`, { method: "POST", body, timeoutMs });
      if (res.status >= 400) throw httpFailure("ollama", this.model, this.baseUrl, res.status, res.text, res.json);
      return res.json;
    } catch (err) {
      if (err instanceof TransportError) throw transportFailure("ollama", this.baseUrl, err);
      throw err;
    }
  }
}

function modelNames(body: unknown): string[] {
  const rec = (body ?? {}) as Record<string, unknown>;
  const models = Array.isArray(rec.models) ? rec.models : [];
  const names: string[] = [];
  for (const item of models) {
    if (!item || typeof item !== "object") continue;
    const recItem = item as Record<string, unknown>;
    const name = recItem.name ?? recItem.model;
    if (typeof name === "string" && name) names.push(name);
  }
  return names;
}
