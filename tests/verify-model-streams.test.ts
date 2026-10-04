import { describe, expect, test } from "bun:test";

import { createBackend, resolveLocalConfig } from "../harness/model/index.ts";
import type { StreamEvent } from "../harness/model/types.ts";
import { scripted, textStream } from "./fixtures/verify-model/mock.ts";

/**
 * A stream is a completed reply only when the server says so. These tests replay the
 * scenarios from the PR #2 review: an HTTP-200 error frame, EOF without a terminal frame,
 * and tool calls that arrive over several frames. Every one runs on a scripted fetch.
 */

const ask = { messages: [{ role: "user" as const, content: "hi" }] };

async function drain(iter: AsyncIterable<StreamEvent>): Promise<{ events: StreamEvent[]; error: unknown }> {
  const events: StreamEvent[] = [];
  let error: unknown;
  try {
    for await (const event of iter) events.push(event);
  } catch (err) {
    error = err;
  }
  return { events, error };
}

function ollama(parts: string[]) {
  const mock = scripted(() => textStream(parts, "application/x-ndjson"));
  const backend = createBackend(
    resolveLocalConfig({ provider: "ollama", model: "qwen", retries: 0, timeoutMs: 1000, env: {} }),
    { fetch: mock.fetch },
  );
  return backend;
}

function llama(parts: string[]) {
  const mock = scripted(() => textStream(parts));
  const backend = createBackend(
    resolveLocalConfig({ provider: "llamacpp", model: "model.gguf", retries: 0, timeoutMs: 1000, env: {} }),
    { fetch: mock.fetch },
  );
  return backend;
}

const kinds = (events: StreamEvent[]) => events.map((event) => event.type);

describe("ollama stream termination [4178394511]", () => {
  test("an HTTP-200 error frame is a ModelError, not an empty chunk or a done event", async () => {
    const { events, error } = await drain(
      ollama(['{"error":"model runner has unexpectedly stopped"}\n']).stream(ask),
    );
    expect(error).toMatchObject({ name: "ModelError", provider: "ollama", code: "bad_response" });
    expect((error as Error).message).toContain("model runner has unexpectedly stopped");
    expect(events).toEqual([]);
  });

  test("an error frame after a pending tool call releases neither the call nor completion", async () => {
    const { events, error } = await drain(
      ollama([
        '{"message":{"tool_calls":[{"function":{"name":"read","arguments":{"path":"a"}}}]},"done":false}\n',
        '{"error":"out of memory"}\n',
      ]).stream(ask),
    );
    expect(error).toMatchObject({ code: "bad_response" });
    expect(kinds(events)).not.toContain("tool_call");
    expect(kinds(events)).not.toContain("done");
  });

  test("EOF without done:true rejects and does not release pending tool calls", async () => {
    const { events, error } = await drain(
      ollama([
        '{"message":{"tool_calls":[{"function":{"name":"read","arguments":{"path":"a"}}}]},"done":false}\n',
      ]).stream(ask),
    );
    expect(error).toMatchObject({ name: "ModelError", provider: "ollama", code: "bad_response" });
    expect((error as Error).message).toContain("done: true");
    expect(kinds(events)).not.toContain("tool_call");
    expect(kinds(events)).not.toContain("done");
  });

  test("a final frame cut off mid-JSON is a truncated stream, not a silent end", async () => {
    const { events, error } = await drain(
      ollama(['{"message":{"content":"he"},"done":false}\n{"message":{"content":""},"do']).stream(ask),
    );
    expect(error).toMatchObject({ code: "bad_response" });
    expect(kinds(events)).not.toContain("done");
  });

  test("a terminal frame without a trailing newline still completes", async () => {
    const { events, error } = await drain(
      ollama(['{"message":{"content":"ok"},"done":false}\n{"message":{"content":""},"done":true,"done_reason":"stop"}']).stream(ask),
    );
    expect(error).toBeUndefined();
    expect(events[events.length - 1]).toMatchObject({ type: "done", finishReason: "stop" });
  });
});

describe("ollama tool calls across frames [4178394592]", () => {
  test("separate read and write frames both survive, with one response-wide id counter", async () => {
    const { events, error } = await drain(
      ollama([
        '{"message":{"tool_calls":[{"function":{"name":"read","arguments":{"path":"a"}}}]},"done":false}\n',
        '{"message":{"tool_calls":[{"function":{"name":"write","arguments":{"path":"b","content":"x"}}}]},"done":false}\n',
        '{"message":{"content":""},"done":true,"done_reason":"stop"}\n',
      ]).stream(ask),
    );
    expect(error).toBeUndefined();
    expect(events.filter((event) => event.type === "tool_call")).toEqual([
      { type: "tool_call", toolCall: { id: "call_0", name: "read", arguments: '{"path":"a"}' } },
      { type: "tool_call", toolCall: { id: "call_1", name: "write", arguments: '{"path":"b","content":"x"}' } },
    ]);
    expect(kinds(events)[events.length - 1]).toBe("done");
  });

  test("server-provided ids are kept, and a generated id never collides with one", async () => {
    const { events } = await drain(
      ollama([
        '{"message":{"tool_calls":[{"id":"call_0","function":{"name":"read","arguments":{}}}]},"done":false}\n',
        '{"message":{"tool_calls":[{"function":{"name":"write","arguments":{}}}]},"done":false}\n',
        '{"message":{"tool_calls":[{"id":"srv_z","function":{"name":"bash","arguments":{}}}]},"done":true}\n',
      ]).stream(ask),
    );
    const ids = events.flatMap((event) => (event.type === "tool_call" ? [event.toolCall.id] : []));
    expect(ids).toEqual(["call_0", "call_1", "srv_z"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a non-streaming reply numbers its calls once for the whole response", async () => {
    const mock = scripted(() =>
      new Response(
        JSON.stringify({
          model: "qwen",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { function: { name: "read", arguments: { path: "a" } } },
              { function: { name: "write", arguments: { path: "b" } } },
            ],
          },
          done: true,
          done_reason: "stop",
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const backend = createBackend(
      resolveLocalConfig({ provider: "ollama", model: "qwen", retries: 0, timeoutMs: 1000, env: {} }),
      { fetch: mock.fetch },
    );
    const reply = await backend.complete(ask);
    expect(reply.message.toolCalls?.map((call) => call.id)).toEqual(["call_0", "call_1"]);
  });
});

describe("llama.cpp stream termination [4178394529]", () => {
  test("an HTTP-200 error payload is a ModelError, not an ignored frame", async () => {
    for (const payload of ['{"error":{"code":500,"message":"slot unavailable"}}', '{"error":"slot unavailable"}']) {
      const { events, error } = await drain(llama([`data: ${payload}\n\n`]).stream(ask));
      expect(error).toMatchObject({ name: "ModelError", provider: "llamacpp", code: "bad_response" });
      expect((error as Error).message).toContain("slot unavailable");
      expect(events).toEqual([]);
    }
  });

  test("an error payload after a pending tool call releases neither the call nor completion", async () => {
    const { events, error } = await drain(
      llama([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"read","arguments":"{\\"path\\":"}}]}}]}\n\n',
        'data: {"error":{"message":"context exceeded"}}\n\n',
      ]).stream(ask),
    );
    expect(error).toMatchObject({ code: "bad_response" });
    expect(kinds(events)).not.toContain("tool_call");
    expect(kinds(events)).not.toContain("done");
  });

  test("EOF with neither [DONE] nor finish_reason rejects and does not flush pending tool calls", async () => {
    const { events, error } = await drain(
      llama([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"read","arguments":"{}"}}]}}]}\n\n',
      ]).stream(ask),
    );
    expect(error).toMatchObject({ name: "ModelError", provider: "llamacpp", code: "bad_response" });
    expect((error as Error).message).toContain("finish_reason or [DONE]");
    expect(kinds(events)).not.toContain("tool_call");
    expect(kinds(events)).not.toContain("done");
  });

  test("[DONE] alone is a terminator, and it flushes the assembled call", async () => {
    const { events, error } = await drain(
      llama([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"read","arguments":"{}"}}]}}]}\n\n',
        "data: [DONE]\n\n",
      ]).stream(ask),
    );
    expect(error).toBeUndefined();
    expect(events.filter((event) => event.type === "tool_call")).toEqual([
      { type: "tool_call", toolCall: { id: "a", name: "read", arguments: "{}" } },
    ]);
    expect(kinds(events)[events.length - 1]).toBe("done");
  });
});
