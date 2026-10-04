import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main as cliMain } from "../harness/cli.ts";
import { parseDriverArgv, main as driverMain } from "../harness/driver.ts";
import { flagsForLane } from "../harness/runner.ts";
import {
  buildPiProvider,
  createBackend,
  materializePiHome,
  PI_PLACEHOLDER_API_KEY,
  prepareLocalProvider,
  resolveLocalConfig,
} from "../harness/model/index.ts";
import { flagValue, withModelOverride } from "../harness/model/flags.ts";
import { matchLoadedModel, parseLlamaContext, parseModelIds } from "../harness/model/llamacpp.ts";
import {
  ollamaModelPresent,
  parseOllamaContextLength,
  parseOllamaNumCtx,
  parseOllamaRunningContext,
  parseOllamaToolCapability,
} from "../harness/model/ollama.ts";
import { ModelError } from "../harness/model/types.ts";
import { normalizeBaseUrl } from "../harness/model/url.ts";

interface Hit {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textStream(parts: string[], status = 200, contentType = "text/event-stream"): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "content-type": contentType } });
}

function scripted(handler: (hit: Hit, index: number) => Response | Promise<Response>): {
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  hits: Hit[];
} {
  const hits: Hit[] = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    const hit = { url: String(input), init: init ?? {} };
    hits.push(hit);
    return handler(hit, hits.length - 1);
  };
  return { fetch: fetchImpl, hits };
}

function refused(): never {
  const cause = new Error("connect ECONNREFUSED 127.0.0.1");
  (cause as { code?: string }).code = "ECONNREFUSED";
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = cause;
  throw err;
}

function bodyOf(hit: Hit): Record<string, unknown> {
  return JSON.parse(String(hit.init.body)) as Record<string, unknown>;
}

function headersOf(hit: Hit): Headers {
  return new Headers(hit.init.headers);
}

function pathname(url: string): string {
  return new URL(url).pathname;
}

const quiet = { cache: false as const, assumeTools: false as const, retryDelayMs: 0 };

describe("local model config", () => {
  test("defaults and host normalisation", () => {
    const ollama = resolveLocalConfig({ provider: "ollama", model: "qwen", env: {} });
    expect(ollama.baseUrl).toBe("http://127.0.0.1:11434");
    expect(ollama.provider).toBe("ollama");
    const fromHost = resolveLocalConfig({
      provider: "ollama",
      model: "qwen",
      env: { OLLAMA_HOST: "0.0.0.0:11434" },
    });
    expect(fromHost.baseUrl).toBe("http://127.0.0.1:11434");
    const llama = resolveLocalConfig({ provider: "llama.cpp", model: "m.gguf", env: {} });
    expect(llama.provider).toBe("llamacpp");
    expect(llama.baseUrl).toBe("http://127.0.0.1:8080");
    expect(normalizeBaseUrl("http://localhost:8080/v1/")).toBe("http://localhost:8080/v1");
  });

  test("CLI overrides env and a missing model is an error", () => {
    const cfg = resolveLocalConfig({
      provider: "ollama",
      model: "custom",
      baseUrl: "http://10.0.0.8:11434",
      temperature: 0.2,
      contextSize: 32768,
      env: { OLLAMA_HOST: "http://127.0.0.1:1", VERIHARNESS_TEMPERATURE: "0.9" },
    });
    expect(cfg.baseUrl).toBe("http://10.0.0.8:11434");
    expect(cfg.temperature).toBe(0.2);
    expect(cfg.contextSize).toBe(32768);
    expect(() => resolveLocalConfig({ provider: "ollama", env: {} })).toThrow(/--model is required/);
    expect(() => resolveLocalConfig({ provider: "anthropic", model: "x", env: {} })).toThrow(/not a local backend/);
    expect(() => resolveLocalConfig({ provider: "ollama", model: "q", contextSize: -1, env: {} })).toThrow(
      /positive integer/,
    );
    expect(() => resolveLocalConfig({ provider: "ollama", model: "q", contextSize: 1.5, env: {} })).toThrow(
      /positive integer/,
    );
    expect(() =>
      resolveLocalConfig({ provider: "ollama", model: "q", env: { VERIHARNESS_CONTEXT_SIZE: "0" } }),
    ).toThrow(/positive integer/);
  });

  test("ollama name and capability parsers", () => {
    expect(ollamaModelPresent(["qwen:latest"], "qwen")).toBe(true);
    expect(ollamaModelPresent(["qwen:7b"], "qwen")).toBe(false);
    expect(parseOllamaNumCtx("temperature 0.8\nnum_ctx 4096\n")).toBe(4096);
    expect(parseOllamaContextLength({ "llama.context_length": 131072, "bert.context_length": 512 })).toBe(131072);
    expect(parseOllamaToolCapability(["completion", "tools"])).toBe(true);
    expect(parseOllamaToolCapability(["completion"])).toBe(false);
    expect(parseOllamaToolCapability(undefined)).toBe("unknown");
    expect(parseOllamaRunningContext({ models: [{ name: "qwen:latest", context_length: 8192 }] }, "qwen")).toBe(8192);
    expect(parseOllamaRunningContext({ model_info: { "llama.context_length": 131072 } }, "qwen")).toBeUndefined();
  });

  test("llama.cpp model id matching", () => {
    expect(matchLoadedModel(["/models/a.gguf"], "a.gguf")).toEqual({ id: "/models/a.gguf" });
    expect("error" in matchLoadedModel(["a.gguf", "b.gguf"], "missing")).toBe(true);
    expect(parseModelIds({ data: [{ id: "a", status: { value: "unloaded" } }, { id: "b" }] })).toEqual([
      { id: "a", loaded: false },
      { id: "b", loaded: true },
    ]);
    expect(parseLlamaContext({ default_generation_settings: { n_ctx: 32768 } })).toBe(32768);
  });
});

describe("ollama backend", () => {
  test("chat request shape, tool calls and token counts", async () => {
    const mock = scripted((hit) => {
      expect(hit.url).toBe("http://127.0.0.1:11434/api/chat");
      expect(hit.init.method).toBe("POST");
      expect(headersOf(hit).has("authorization")).toBe(false);
      expect(headersOf(hit).get("content-type")).toBe("application/json");
      const body = bodyOf(hit);
      expect(body).toMatchObject({
        model: "qwen",
        stream: false,
        format: "json",
        tool_choice: "auto",
        options: { temperature: 0.2, num_ctx: 32768, num_predict: 128 },
      });
      expect(body.tools).toEqual([
        {
          type: "function",
          function: { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } },
        },
      ]);
      return jsonResponse({
        model: "qwen",
        message: {
          role: "assistant",
          content: "{\"ok\":true}",
          tool_calls: [{ function: { name: "read", arguments: { path: "a" } } }],
        },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 11,
        eval_count: 7,
      });
    });
    const backend = createBackend(
      resolveLocalConfig({ provider: "ollama", model: "qwen", retries: 0, timeoutMs: 1000, env: {} }),
      { fetch: mock.fetch, retryDelayMs: 0 },
    );
    const response = await backend.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
      toolChoice: "auto",
      temperature: 0.2,
      contextSize: 32768,
      maxTokens: 128,
      json: true,
    });
    expect(response.message.content).toBe('{"ok":true}');
    expect(response.message.toolCalls?.[0]).toEqual({ id: "call_0", name: "read", arguments: '{"path":"a"}' });
    expect(response.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(mock.hits).toHaveLength(1);
  });

  test("streams NDJSON split across packets", async () => {
    const mock = scripted(() =>
      textStream(
        ['{"message":{"content":"he"},"done":false}\n{"message":{"content":"llo"},"done":', 'false}\n{"message":{"content":""},"done":true,"done_reason":"stop","eval_count":2}\n'],
        200,
        "application/x-ndjson",
      ),
    );
    const backend = createBackend(
      resolveLocalConfig({ provider: "ollama", model: "qwen", retries: 0, timeoutMs: 1000, env: {} }),
      { fetch: mock.fetch },
    );
    const events = [];
    for await (const event of backend.stream({ messages: [{ role: "user", content: "hi" }] })) events.push(event);
    expect(events).toContainEqual({ type: "text", text: "he" });
    expect(events).toContainEqual({ type: "text", text: "llo" });
    expect(events[events.length - 1]).toMatchObject({ type: "done", finishReason: "stop", usage: { outputTokens: 2 } });
    expect(bodyOf(mock.hits[0]!).stream).toBe(true);
  });

  test("keeps every streamed tool call and updates a repeated id", async () => {
    const mock = scripted(() =>
      textStream(
        [
          '{"message":{"tool_calls":[{"id":"a","function":{"name":"read","arguments":{"path":"a"}}}]},"done":false}\n',
          '{"message":{"tool_calls":[{"id":"a","function":{"name":"read","arguments":{"path":"ab"}}},{"function":{"name":"bash","arguments":{}}}]},"done":true,"done_reason":"tool_calls"}\n',
        ],
        200,
        "application/x-ndjson",
      ),
    );
    const backend = createBackend(
      resolveLocalConfig({ provider: "ollama", model: "qwen", retries: 0, timeoutMs: 1000, env: {} }),
      { fetch: mock.fetch },
    );
    const events = [];
    for await (const event of backend.stream({ messages: [{ role: "user", content: "hi" }] })) events.push(event);
    expect(events.filter((event) => event.type === "tool_call")).toEqual([
      { type: "tool_call", toolCall: { id: "a", name: "read", arguments: '{"path":"ab"}' } },
      { type: "tool_call", toolCall: { id: "call_0", name: "bash", arguments: "{}" } },
    ]);
  });

  test("an error frame or a truncated stream is not a completed reply", async () => {
    const crashed = scripted(() =>
      textStream(['{"message":{"content":"he"},"done":false}\n{"error":"runner crashed"}\n'], 200, "application/x-ndjson"),
    );
    const crashedBackend = createBackend(
      resolveLocalConfig({ provider: "ollama", model: "qwen", retries: 0, timeoutMs: 1000, env: {} }),
      { fetch: crashed.fetch },
    );
    const crashedEvents = [];
    await expect(
      (async () => {
        for await (const event of crashedBackend.stream({ messages: [{ role: "user", content: "hi" }] })) {
          crashedEvents.push(event);
        }
      })(),
    ).rejects.toMatchObject({ code: "bad_response" });
    expect(crashedEvents.some((event) => event.type === "done")).toBe(false);

    const truncated = scripted(() =>
      textStream(['{"message":{"content":"he"},"done":false}\n'], 200, "application/x-ndjson"),
    );
    const truncatedBackend = createBackend(
      resolveLocalConfig({ provider: "ollama", model: "qwen", retries: 0, timeoutMs: 1000, env: {} }),
      { fetch: truncated.fetch },
    );
    await expect(
      (async () => {
        for await (const event of truncatedBackend.stream({ messages: [{ role: "user", content: "hi" }] })) {
          void event;
        }
      })(),
    ).rejects.toThrow(/done: true/);
  });

  test("server down, model missing, and refused features", async () => {
    const down = scripted(() => refused());
    const backend = createBackend(
      resolveLocalConfig({ provider: "ollama", model: "qwen", retries: 1, timeoutMs: 1000, env: {} }),
      { fetch: down.fetch, retryDelayMs: 0 },
    );
    const downError = await backend.probe().then(
      () => {
        throw new Error("expected probe to fail");
      },
      (err) => err as ModelError,
    );
    expect(downError).toMatchObject({ code: "unreachable" });
    expect(downError.message).toContain("ollama serve");
    expect(down.hits).toHaveLength(1);

    const missing = scripted(() => jsonResponse({ models: [{ name: "other:latest" }] }));
    const missingBackend = createBackend(
      resolveLocalConfig({ provider: "ollama", model: "qwen", retries: 0, timeoutMs: 1000, env: {} }),
      { fetch: missing.fetch },
    );
    await expect(missingBackend.probe()).rejects.toThrow(/ollama pull qwen/);

    const noTools = scripted((hit) => {
      if (hit.url.endsWith("/api/chat")) return jsonResponse({ error: "should not chat" }, 500);
      return jsonResponse({});
    });
    const bare = createBackend(
      resolveLocalConfig({ provider: "ollama", model: "qwen", retries: 0, timeoutMs: 1000, env: {} }),
      { fetch: noTools.fetch },
    );
    (bare as { remember: (caps: { tools: false; json: true }) => void }).remember({ tools: false, json: true });
    await expect(
      bare.complete({
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "ping", parameters: { type: "object", properties: {} } }],
      }),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(noTools.hits.some((hit) => hit.url.endsWith("/api/chat"))).toBe(false);

    const badJson = scripted(() =>
      jsonResponse({ message: { role: "assistant", content: "sure" }, done: true, done_reason: "stop" }),
    );
    const jsonBackend = createBackend(
      resolveLocalConfig({ provider: "ollama", model: "qwen", retries: 0, timeoutMs: 1000, env: {} }),
      { fetch: badJson.fetch },
    );
    await expect(
      jsonBackend.complete({ messages: [{ role: "user", content: "hi" }], json: true }),
    ).rejects.toMatchObject({ code: "bad_response" });
  });

  test("retries a transient chat error and then parses the reply", async () => {
    let n = 0;
    const mock = scripted(() => {
      n += 1;
      if (n === 1) return jsonResponse({ error: "busy" }, 503);
      return jsonResponse({ message: { role: "assistant", content: "pong" }, done: true, done_reason: "stop" });
    });
    const backend = createBackend(
      resolveLocalConfig({ provider: "ollama", model: "qwen", retries: 1, timeoutMs: 1000, env: {} }),
      { fetch: mock.fetch, retryDelayMs: 0 },
    );
    const response = await backend.complete({ messages: [{ role: "user", content: "ping" }] });
    expect(response.message.content).toBe("pong");
    expect(mock.hits).toHaveLength(2);
  });
});

describe("llama.cpp backend", () => {
  function llamaBackend(
    handler: (hit: Hit, index: number) => Response | Promise<Response>,
    model = "model.gguf",
    extra: { retries?: number } = {},
  ) {
    const mock = scripted(handler);
    const backend = createBackend(
      resolveLocalConfig({
        provider: "llamacpp",
        model,
        retries: extra.retries ?? 0,
        timeoutMs: 1000,
        env: {},
      }),
      { fetch: mock.fetch, retryDelayMs: 0 },
    );
    return { backend, mock };
  }

  function route(hit: Hit, chat: () => Response): Response {
    const path = pathname(hit.url);
    if (path === "/health") return jsonResponse({ status: "ok" });
    if (path === "/v1/models") return jsonResponse({ data: [{ id: "model.gguf" }] });
    if (path === "/models") return jsonResponse({ error: "no router" }, 404);
    if (path === "/props") return jsonResponse({ default_generation_settings: { n_ctx: 32768 } });
    if (path === "/v1/chat/completions") return chat();
    return jsonResponse({ error: `unexpected ${hit.url}` }, 500);
  }

  test("chat request shape and response usage", async () => {
    const { backend, mock } = llamaBackend((hit) =>
      route(hit, () => {
        const body = bodyOf(hit);
        expect(body).toMatchObject({
          model: "model.gguf",
          stream: false,
          temperature: 0,
          max_tokens: 32,
          tool_choice: "required",
          response_format: { type: "json_object" },
        });
        expect(headersOf(hit).has("authorization")).toBe(false);
        expect(body).not.toHaveProperty("api_key");
        return jsonResponse({
          model: "model.gguf",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "call_9", type: "function", function: { name: "ping", arguments: "{}" } }],
              },
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 3 },
        });
      }),
    );
    await backend.probe();
    const response = await backend.complete({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: null, toolCalls: [{ id: "call_1", name: "read", arguments: "{}" }] },
        { role: "tool", toolCallId: "call_1", content: "ok" },
      ],
      tools: [{ name: "ping", parameters: { type: "object", properties: {} } }],
      toolChoice: "required",
      temperature: 0,
      maxTokens: 32,
      json: true,
    });
    expect(response.message.toolCalls?.[0]?.name).toBe("ping");
    expect(response.usage).toEqual({ inputTokens: 4, outputTokens: 3 });
    expect(response.message.content).toBeNull();
    const chat = mock.hits.filter((hit) => hit.url.endsWith("/chat/completions"));
    expect(bodyOf(chat[0]!).messages).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ]);
  });

  test("streams SSE split across packets and retries without stream_options", async () => {
    let chats = 0;
    const { backend, mock } = llamaBackend((hit) =>
      route(hit, () => {
        chats += 1;
        if (chats === 1) return jsonResponse({ error: "unknown field stream_options" }, 400);
        const body = bodyOf(hit);
        expect(body).not.toHaveProperty("stream_options");
        return textStream([
          'data: {"choices":[{"delta":{"content":"he"}}]}\n',
          'data: {"choices":[{"delta":{"content":"llo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\ndata: [DONE]\n',
        ]);
      }),
    );
    const events = [];
    for await (const event of backend.stream({ messages: [{ role: "user", content: "hi" }] })) events.push(event);
    expect(events.map((event) => (event.type === "text" ? event.text : event.type)).join("")).toContain("hello");
    expect(events[events.length - 1]).toMatchObject({
      type: "done",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    expect(mock.hits.filter((hit) => hit.url.endsWith("/chat/completions"))).toHaveLength(2);
  });

  test("an error frame, a truncated stream, and finish_reason without [DONE]", async () => {
    const crashed = llamaBackend((hit) =>
      route(hit, () => textStream(['data: {"error":{"message":"context exceeded"}}\n'])),
    );
    const crashedEvents = [];
    await expect(
      (async () => {
        for await (const event of crashed.backend.stream({ messages: [{ role: "user", content: "hi" }] })) {
          crashedEvents.push(event);
        }
      })(),
    ).rejects.toThrow(/context exceeded/);
    expect(crashedEvents.some((event) => event.type === "done")).toBe(false);

    const truncated = llamaBackend((hit) =>
      route(hit, () => textStream(['data: {"choices":[{"delta":{"content":"he"}}]}\n'])),
    );
    await expect(
      (async () => {
        for await (const event of truncated.backend.stream({ messages: [{ role: "user", content: "hi" }] })) {
          void event;
        }
      })(),
    ).rejects.toThrow(/finish_reason or \[DONE\]/);

    const finished = llamaBackend((hit) =>
      route(hit, () => textStream(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n'])),
    );
    const events = [];
    for await (const event of finished.backend.stream({ messages: [{ role: "user", content: "hi" }] })) events.push(event);
    expect(events[events.length - 1]).toMatchObject({ type: "done", finishReason: "stop" });
  });

  test("server down, still loading, wrong model, and tool rejection", async () => {
    const down = scripted(() => refused());
    const downBackend = createBackend(
      resolveLocalConfig({ provider: "llamacpp", model: "m", retries: 1, timeoutMs: 1000, env: {} }),
      { fetch: down.fetch, retryDelayMs: 0 },
    );
    const downError = await downBackend.probe().then(
      () => {
        throw new Error("expected probe to fail");
      },
      (err) => err as ModelError,
    );
    expect(downError).toMatchObject({ code: "unreachable" });
    expect(downError.message).toContain("llama-server");
    expect(down.hits).toHaveLength(1);

    const loading = llamaBackend((hit) => {
      if (hit.url.endsWith("/health")) return jsonResponse({ status: "loading" }, 503);
      return jsonResponse({});
    });
    await expect(loading.backend.probe()).rejects.toThrow(/still loading/);

    const wrong = llamaBackend((hit) => {
      if (hit.url.endsWith("/health")) return jsonResponse({ status: "ok" });
      if (hit.url.endsWith("/v1/models")) return jsonResponse({ data: [{ id: "other.gguf" }] });
      if (hit.url.endsWith("/models")) {
        return jsonResponse({ data: [{ id: "wanted.gguf", status: "unloaded" }] });
      }
      return jsonResponse({});
    }, "wanted.gguf");
    await expect(wrong.backend.probe()).rejects.toThrow(/not loaded/);

    const noTools = llamaBackend((hit) =>
      route(hit, () => jsonResponse({ error: "tool calls require --jinja" }, 400)),
    );
    await noTools.backend.probe();
    await expect(
      noTools.backend.complete({
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "ping", parameters: { type: "object", properties: {} } }],
        toolChoice: "required",
      }),
    ).rejects.toThrow(/--jinja/);

    const badJson = llamaBackend((hit) =>
      route(hit, () =>
        jsonResponse({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "not json" } }],
        }),
      ),
    );
    await expect(
      badJson.backend.complete({ messages: [{ role: "user", content: "hi" }], json: true }),
    ).rejects.toMatchObject({ code: "bad_response" });
  });

  test("a basename resolves to the server id used in later requests", async () => {
    const { backend, mock } = llamaBackend(
      (hit) => {
        const path = pathname(hit.url);
        if (path === "/health") return jsonResponse({ status: "ok" });
        if (path === "/v1/models") return jsonResponse({ data: [{ id: "/w/model.gguf" }] });
        if (path === "/models") return jsonResponse({}, 404);
        if (path === "/props") return jsonResponse({ n_ctx: 8192 });
        return jsonResponse({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
        });
      },
      "model.gguf",
    );
    const probe = await backend.probe();
    expect(probe.model).toBe("/w/model.gguf");
    await backend.complete({ messages: [{ role: "user", content: "hi" }] });
    const chat = mock.hits.find((hit) => hit.url.endsWith("/chat/completions"))!;
    expect(bodyOf(chat).model).toBe("/w/model.gguf");
    const props = mock.hits.find((hit) => pathname(hit.url) === "/props")!;
    expect(new URL(props.url).searchParams.get("model")).toBe("/w/model.gguf");
  });

  test("props falls back to the unscoped endpoint when the model query is 404", async () => {
    let props = 0;
    const { backend, mock } = llamaBackend((hit) => {
      const path = pathname(hit.url);
      if (path === "/health") return jsonResponse({ status: "ok" });
      if (path === "/v1/models") return jsonResponse({ data: [{ id: "model.gguf" }] });
      if (path === "/models") return jsonResponse({}, 404);
      if (path === "/props") {
        props += 1;
        if (props === 1) {
          expect(new URL(hit.url).searchParams.get("model")).toBe("model.gguf");
          return jsonResponse({ error: "unsupported" }, 404);
        }
        expect(new URL(hit.url).search).toBe("");
        return jsonResponse({ n_ctx: 16384 });
      }
      return jsonResponse({ error: "no chat" }, 500);
    });
    const probe = await backend.probe();
    expect(probe.capabilities.contextSize).toBe(16384);
    expect(mock.hits.filter((hit) => pathname(hit.url) === "/props")).toHaveLength(2);
  });
});

describe("preflight and pi registry", () => {
  test("known tool support skips the generation probe", async () => {
    const mock = scripted((hit) => {
      if (hit.url.endsWith("/api/tags")) return jsonResponse({ models: [{ name: "qwen:latest" }] });
      if (hit.url.endsWith("/api/show")) {
        return jsonResponse({ capabilities: ["completion", "tools"], parameters: "num_ctx 32768\n" });
      }
      return jsonResponse({ error: "no chat" }, 500);
    });
    const prepared = await prepareLocalProvider(
      resolveLocalConfig({
        provider: "ollama",
        model: "qwen",
        temperature: 0.2,
        maxTokens: 1000,
        retries: 0,
        timeoutMs: 1000,
        env: {},
      }),
      { fetch: mock.fetch, ...quiet },
    );
    expect(prepared.probe.capabilities.tools).toBe(true);
    expect(prepared.piProvider.config).toMatchObject({
      baseUrl: "http://127.0.0.1:11434/v1",
      api: "openai-completions",
      apiKey: PI_PLACEHOLDER_API_KEY,
      compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false, supportsReasoningEffort: false },
    });
    expect(prepared.piProvider.config.models).toEqual([
      expect.objectContaining({
        id: "qwen",
        contextWindow: 32768,
        maxTokens: 1000,
        samplingParams: { temperature: 0.2 },
      }),
    ]);
    expect(mock.hits.some((hit) => hit.url.endsWith("/api/chat"))).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "vh-pi-"));
    materializePiHome(dir, prepared.piProvider);
    const written = JSON.parse(readFileSync(join(dir, "models.json"), "utf8")) as {
      providers: Record<string, { apiKey?: string }>;
    };
    expect(written.providers.ollama?.apiKey).toBe("local");
    expect(written.providers["vertex-litellm"]).toBeUndefined();
  });

  test("missing tools and a text-only probe fail instead of continuing", async () => {
    const declared = scripted((hit) => {
      if (hit.url.endsWith("/api/tags")) return jsonResponse({ models: [{ name: "tiny" }] });
      if (hit.url.endsWith("/api/show")) return jsonResponse({ capabilities: ["completion"], parameters: "num_ctx 32768" });
      return jsonResponse({ error: "chat" }, 500);
    });
    await expect(
      prepareLocalProvider(
        resolveLocalConfig({ provider: "ollama", model: "tiny", retries: 0, timeoutMs: 1000, env: {} }),
        { fetch: declared.fetch, ...quiet },
      ),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(declared.hits.some((hit) => hit.url.endsWith("/api/chat"))).toBe(false);

    const unknown = scripted((hit) => {
      if (hit.url.endsWith("/api/tags")) return jsonResponse({ models: [{ name: "tiny" }] });
      if (hit.url.endsWith("/api/show")) return jsonResponse({ parameters: "num_ctx 32768" });
      return jsonResponse({ message: { role: "assistant", content: "hello" }, done: true, done_reason: "stop" });
    });
    await expect(
      prepareLocalProvider(
        resolveLocalConfig({ provider: "ollama", model: "tiny", retries: 0, timeoutMs: 1000, env: {} }),
        { fetch: unknown.fetch, ...quiet },
      ),
    ).rejects.toBeInstanceOf(ModelError);
    expect(unknown.hits.some((hit) => hit.url.endsWith("/api/chat"))).toBe(true);
  });

  test("context mismatches fail clearly", async () => {
    const small = scripted((hit) => {
      if (hit.url.endsWith("/api/tags")) return jsonResponse({ models: [{ name: "qwen" }] });
      return jsonResponse({ capabilities: ["tools"], parameters: "num_ctx 2048" });
    });
    await expect(
      prepareLocalProvider(
        resolveLocalConfig({
          provider: "ollama",
          model: "qwen",
          contextSize: 32768,
          retries: 0,
          timeoutMs: 1000,
          env: {},
        }),
        { fetch: small.fetch, ...quiet },
      ),
    ).rejects.toThrow(/num_ctx 2048/);

    const unset = scripted((hit) => {
      if (hit.url.endsWith("/api/tags")) return jsonResponse({ models: [{ name: "qwen" }] });
      return jsonResponse({ capabilities: ["tools"], model_info: { "llama.context_length": 131072 } });
    });
    await expect(
      prepareLocalProvider(
        resolveLocalConfig({
          provider: "ollama",
          model: "qwen",
          contextSize: 32768,
          retries: 0,
          timeoutMs: 1000,
          env: {},
        }),
        { fetch: unset.fetch, ...quiet },
      ),
    ).rejects.toThrow(/does not advertise num_ctx/);
  });

  test("a loaded Ollama context wins over num_ctx, and a failed /api/ps does not", async () => {
    const loaded = scripted((hit) => {
      if (hit.url.endsWith("/api/tags")) return jsonResponse({ models: [{ name: "qwen" }] });
      if (hit.url.endsWith("/api/show")) {
        return jsonResponse({ capabilities: ["tools"], parameters: "num_ctx 32768" });
      }
      if (hit.url.endsWith("/api/ps")) return jsonResponse({ models: [{ name: "qwen:latest", context_length: 8192 }] });
      return jsonResponse({ error: "no chat" }, 500);
    });
    const prepared = await prepareLocalProvider(
      resolveLocalConfig({ provider: "ollama", model: "qwen", retries: 0, timeoutMs: 1000, env: {} }),
      { fetch: loaded.fetch, ...quiet },
    );
    expect(prepared.probe.capabilities.contextSize).toBe(8192);
    expect(prepared.piProvider.config.models).toEqual([expect.objectContaining({ contextWindow: 8192 })]);

    const down = scripted((hit) => {
      if (hit.url.endsWith("/api/tags")) return jsonResponse({ models: [{ name: "qwen" }] });
      if (hit.url.endsWith("/api/show")) {
        return jsonResponse({ capabilities: ["tools"], parameters: "num_ctx 32768" });
      }
      return jsonResponse({ error: "ps down" }, 500);
    });
    const fallback = await prepareLocalProvider(
      resolveLocalConfig({ provider: "ollama", model: "qwen", retries: 0, timeoutMs: 1000, env: {} }),
      { fetch: down.fetch, ...quiet },
    );
    expect(fallback.probe.capabilities.contextSize).toBe(32768);
  });

  test("unknown, tiny, and merely short contexts", async () => {
    const unknown = scripted((hit) => {
      if (hit.url.endsWith("/api/tags")) return jsonResponse({ models: [{ name: "qwen" }] });
      if (hit.url.endsWith("/api/ps")) return jsonResponse({ models: [] });
      return jsonResponse({ capabilities: ["tools"], model_info: { "llama.context_length": 131072 } });
    });
    await expect(
      prepareLocalProvider(
        resolveLocalConfig({ provider: "ollama", model: "qwen", retries: 0, timeoutMs: 1000, env: {} }),
        { fetch: unknown.fetch, ...quiet },
      ),
    ).rejects.toThrow(/does not advertise num_ctx/);

    for (const size of [2048, 4096]) {
      const tiny = scripted((hit) => {
        if (hit.url.endsWith("/api/tags")) return jsonResponse({ models: [{ name: "qwen" }] });
        if (hit.url.endsWith("/api/ps")) return jsonResponse({ models: [] });
        return jsonResponse({ capabilities: ["tools"], parameters: `num_ctx ${size}` });
      });
      await expect(
        prepareLocalProvider(
          resolveLocalConfig({ provider: "ollama", model: "qwen", retries: 0, timeoutMs: 1000, env: {} }),
          { fetch: tiny.fetch, ...quiet },
        ),
      ).rejects.toThrow(/4096/);
    }

    const requested = scripted((hit) => {
      if (hit.url.endsWith("/api/tags")) return jsonResponse({ models: [{ name: "qwen" }] });
      if (hit.url.endsWith("/api/ps")) return jsonResponse({ models: [] });
      return jsonResponse({ capabilities: ["tools"], parameters: "num_ctx 32768" });
    });
    await expect(
      prepareLocalProvider(
        resolveLocalConfig({
          provider: "ollama",
          model: "qwen",
          contextSize: 2048,
          retries: 0,
          timeoutMs: 1000,
          env: {},
        }),
        { fetch: requested.fetch, ...quiet },
      ),
    ).rejects.toThrow(/2048-token context window/);

    const short = scripted((hit) => {
      if (hit.url.endsWith("/api/tags")) return jsonResponse({ models: [{ name: "qwen" }] });
      if (hit.url.endsWith("/api/ps")) return jsonResponse({ models: [] });
      return jsonResponse({ capabilities: ["tools"], parameters: "num_ctx 5000" });
    });
    const prepared = await prepareLocalProvider(
      resolveLocalConfig({ provider: "ollama", model: "qwen", retries: 0, timeoutMs: 1000, env: {} }),
      { fetch: short.fetch, ...quiet },
    );
    expect(prepared.warnings.join(" ")).toContain("5000");
    expect(prepared.piProvider.config.models).toEqual([expect.objectContaining({ contextWindow: 5000 })]);

    expect(() =>
      buildPiProvider(resolveLocalConfig({ provider: "ollama", model: "qwen", env: {} }), "qwen"),
    ).toThrow(/verified context window/);
  });

  test("llama-server without n_ctx fails preflight", async () => {
    const mock = scripted((hit) => {
      const path = pathname(hit.url);
      if (path === "/health") return jsonResponse({ status: "ok" });
      if (path === "/v1/models") return jsonResponse({ data: [{ id: "model.gguf" }] });
      if (path === "/models") return jsonResponse({}, 404);
      if (path === "/props") return jsonResponse({});
      return jsonResponse({ error: "no chat" }, 500);
    });
    await expect(
      prepareLocalProvider(
        resolveLocalConfig({ provider: "llamacpp", model: "model.gguf", retries: 0, timeoutMs: 1000, env: {} }),
        { fetch: mock.fetch, ...quiet },
      ),
    ).rejects.toThrow(/did not report n_ctx/);
  });
});

describe("runner flag merge", () => {
  test("a local provider replaces the lane model and drops its thinking level", () => {
    const flags = flagsForLane("flash", ["--contract", "artifact", "--provider", "ollama", "--model", "qwen"]);
    expect(flags).toEqual(["--contract", "artifact", "--provider", "ollama", "--model", "qwen"]);
    expect(flagValue(flags, "--provider")).toBe("ollama");
    const opus = flagsForLane("opus", ["--contract", "artifact"]);
    expect(flagValue(opus, "--provider")).toBe("vertex-litellm");
    expect(opus).toContain("--thinking");
    const kept = withModelOverride(
      ["--provider", "ollama", "--model", "a", "--thinking", "low"],
      ["--model", "b", "--thinking", "high"],
    );
    expect(kept).toEqual(["--provider", "ollama", "--model", "b", "--thinking", "high"]);
    expect(flagValue(["--provider", "vertex-litellm", "--provider=ollama"], "--provider")).toBe("ollama");
    const equals = flagsForLane("opus", ["--provider=ollama", "--model", "qwen"]);
    expect(equals).toEqual(["--provider", "ollama", "--model", "qwen"]);
    expect(equals).not.toContain("vertex-litellm");
    expect(equals).not.toContain("--thinking");
    expect(flagValue(equals, "--provider")).toBe("ollama");
  });
});

describe("cli", () => {
  test("driver accepts local options and canonicalises llama.cpp", () => {
    const parsed = parseDriverArgv([
      "tasks/one",
      "--provider",
      "llama.cpp",
      "--model",
      "m.gguf",
      "--base-url",
      "http://127.0.0.1:8081",
      "--context-size",
      "4096",
      "--temperature",
      "0.2",
      "--request-timeout",
      "30",
    ]);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.args.provider).toBe("llamacpp");
    expect(parsed.args.model).toBe("m.gguf");
    expect(parsed.args.baseUrl).toBe("http://127.0.0.1:8081");
    expect(parsed.args.contextSize).toBe(4096);
    expect(parsed.args.temperature).toBe(0.2);
    expect(parsed.args.requestTimeout).toBe(30);
  });

  test("help mentions local providers", async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await driverMain(["--help"])).toBe(0);
      expect(await cliMain(["model-check", "--help"])).toBe(0);
      expect(await cliMain(["model-check"])).toBe(2);
    } finally {
      process.stdout.write = orig;
    }
    const text = chunks.join("");
    expect(text).toContain("--base-url");
    expect(text).toContain("ollama");
    expect(text).toContain("model-check");
  });
});
