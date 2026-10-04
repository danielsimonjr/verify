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
 * OpenAI Chat Completions request and response codec.
 * llama-server speaks this at `/v1/chat/completions`. Ollama's `/v1` does too;
 * the Ollama backend uses the native API instead, where context size and model
 * errors are first-class.
 */

import {
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type StreamEvent,
  type TokenUsage,
  type ToolCall,
  argumentsToJson,
} from "./types.js";

export function openAiTool(tool: { name: string; description?: string; parameters: Record<string, unknown> }) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters,
    },
  };
}

export function toOpenAiMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId ?? message.name ?? "",
      content: message.content ?? "",
    };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content ?? "" };
}

export function buildOpenAiChatBody(model: string, req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: req.messages.map(toOpenAiMessage),
    stream: Boolean(req.stream),
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.tools?.length) {
    body.tools = req.tools.map(openAiTool);
    if (req.toolChoice) body.tool_choice = req.toolChoice;
  }
  if (req.json) body.response_format = { type: "json_object" };
  if (req.stream) body.stream_options = { include_usage: true };
  return body;
}

function usageOf(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const input = u.prompt_tokens;
  const output = u.completion_tokens;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  return { inputTokens: input, outputTokens: output };
}

function toolCallsOf(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCall[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const fn = (rec.function ?? {}) as Record<string, unknown>;
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name) continue;
    out.push({
      id: typeof rec.id === "string" && rec.id ? rec.id : `call_${i}`,
      name,
      arguments: argumentsToJson(fn.arguments),
    });
  }
  return out;
}

export function parseOpenAiChatResponse(body: unknown, fallbackModel: string): ChatResponse {
  const rec = (body ?? {}) as Record<string, unknown>;
  const model = typeof rec.model === "string" && rec.model ? rec.model : fallbackModel;
  const choices = Array.isArray(rec.choices) ? rec.choices : [];
  const choice = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (choice.message ?? {}) as Record<string, unknown>;
  const toolCalls = toolCallsOf(message.tool_calls);
  const content = typeof message.content === "string" ? message.content : null;
  const finish =
    typeof choice.finish_reason === "string"
      ? choice.finish_reason
      : toolCalls.length
        ? "tool_calls"
        : "stop";
  return {
    model,
    finishReason: finish,
    usage: usageOf(rec.usage),
    message: {
      role: "assistant",
      content: content && content.length ? content : null,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    },
  };
}

interface ToolBuild {
  id: string;
  name: string;
  arguments: string;
}

/** Parse one `data:` payload. Returns events to emit; mutates tool-call assembly. */
export function pushOpenAiDelta(
  tools: Map<number, ToolBuild>,
  payload: unknown,
): { events: StreamEvent[]; finish?: string; usage?: TokenUsage } {
  const rec = (payload ?? {}) as Record<string, unknown>;
  const events: StreamEvent[] = [];
  const usage = usageOf(rec.usage);
  const choices = Array.isArray(rec.choices) ? rec.choices : [];
  const choice = (choices[0] ?? {}) as Record<string, unknown>;
  const delta = (choice.delta ?? {}) as Record<string, unknown>;
  if (typeof delta.content === "string" && delta.content.length) {
    events.push({ type: "text", text: delta.content });
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const item of delta.tool_calls) {
      if (!item || typeof item !== "object") continue;
      const call = item as Record<string, unknown>;
      const index = typeof call.index === "number" ? call.index : tools.size;
      const prev = tools.get(index) ?? { id: "", name: "", arguments: "" };
      const fn = (call.function ?? {}) as Record<string, unknown>;
      if (typeof call.id === "string" && call.id) prev.id = call.id;
      if (typeof fn.name === "string" && fn.name) prev.name += fn.name;
      if (typeof fn.arguments === "string") prev.arguments += fn.arguments;
      tools.set(index, prev);
    }
  }
  const finish = typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;
  return { events, finish, usage };
}

export function flushToolCalls(tools: Map<number, ToolBuild>): StreamEvent[] {
  const events: StreamEvent[] = [];
  const indexes = [...tools.keys()].sort((a, b) => a - b);
  for (let i = 0; i < indexes.length; i++) {
    const call = tools.get(indexes[i]!)!;
    if (!call.name) continue;
    events.push({
      type: "tool_call",
      toolCall: {
        id: call.id || `call_${i}`,
        name: call.name,
        arguments: call.arguments || "{}",
      },
    });
  }
  return events;
}

export async function* parseOpenAiSseLines(lines: AsyncIterable<string>): AsyncGenerator<StreamEvent> {
  const tools = new Map<number, ToolBuild>();
  let finish: string | undefined;
  let usage: TokenUsage | undefined;
  let done = false;
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") {
      done = true;
      break;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    const pushed = pushOpenAiDelta(tools, payload);
    if (pushed.finish) finish = pushed.finish;
    if (pushed.usage) usage = pushed.usage;
    for (const event of pushed.events) yield event;
  }
  if (!done && finish === undefined && tools.size === 0) {
    // A stream that ended without a terminator still flushes whatever it held.
  }
  for (const event of flushToolCalls(tools)) yield event;
  yield { type: "done", finishReason: finish, usage };
}
