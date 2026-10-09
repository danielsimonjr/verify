import { describe, expect, test } from "bun:test";

import { CLAUDE_CODE_WINDOWS, LANES } from "../harness/config.ts";
import { parseContextSize, resolveLocalConfig } from "../harness/model/config.ts";
import { ModelError } from "../harness/model/types.ts";
import { resolveWindow } from "../harness/model/window.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pathname(url: string): string {
  return new URL(url).pathname;
}

/** An Ollama server that has `name` pulled. `running` is the /api/ps context; `numCtx` the show parameter. */
function ollama(name: string, opts: { running?: number; numCtx?: number }) {
  return async (input: string | URL): Promise<Response> => {
    const path = pathname(String(input));
    if (path === "/api/tags") return jsonResponse({ models: [{ name }] });
    if (path === "/api/show") {
      const parameters = opts.numCtx === undefined ? "" : `num_ctx ${opts.numCtx}`;
      return jsonResponse({ capabilities: ["completion", "tools"], parameters });
    }
    if (path === "/api/ps") {
      const models = opts.running === undefined ? [] : [{ name, context_length: opts.running }];
      return jsonResponse({ models });
    }
    return jsonResponse({ error: "not found" }, 404);
  };
}

const BASE = "http://127.0.0.1:11434";

describe("resolveWindow", () => {
  test("ollama loaded wins", async () => {
    const got = await resolveWindow(
      { provider: "ollama", model: "qwen:latest", baseUrl: BASE },
      { fetch: ollama("qwen:latest", { running: 65536, numCtx: 32768 }), retryDelayMs: 0 },
    );
    expect(got).toEqual({ window: 65536, source: "loaded" });
  });

  test("ollama num_ctx when not loaded", async () => {
    const got = await resolveWindow(
      { provider: "ollama", model: "qwen:latest", baseUrl: BASE },
      { fetch: ollama("qwen:latest", { numCtx: 32768 }), retryDelayMs: 0 },
    );
    expect(got).toEqual({ window: 32768, source: "num_ctx" });
  });

  test("ollama no source throws", async () => {
    const run = resolveWindow(
      { provider: "ollama", model: "qwen:latest", baseUrl: BASE, contextSize: "auto" },
      { fetch: ollama("qwen:latest", {}), retryDelayMs: 0 },
    );
    await expect(run).rejects.toBeInstanceOf(ModelError);
    await expect(run).rejects.toMatchObject({ code: "unsupported" });
  });

  test("llamacpp n_ctx", async () => {
    const fetch = async (input: string | URL): Promise<Response> => {
      const path = pathname(String(input));
      if (path === "/health") return jsonResponse({ status: "ok" });
      if (path === "/v1/models") return jsonResponse({ data: [{ id: "model.gguf" }] });
      if (path === "/props") return jsonResponse({ default_generation_settings: { n_ctx: 16384 } });
      return jsonResponse({ error: "not found" }, 404);
    };
    const got = await resolveWindow(
      { provider: "llamacpp", model: "model.gguf", baseUrl: "http://127.0.0.1:8080" },
      { fetch, retryDelayMs: 0 },
    );
    expect(got).toEqual({ window: 16384, source: "n_ctx" });
  });

  test("claude-code table", async () => {
    const got = await resolveWindow({ provider: "claude-code", model: "claude-haiku-5-5" });
    expect(got).toEqual({ window: CLAUDE_CODE_WINDOWS["claude-haiku-5-5"]!, source: "table" });
    await expect(resolveWindow({ provider: "claude-code", model: "claude-nope-9" })).rejects.toThrow(/claude-nope-9/);
  });

  test("explicit number", async () => {
    const got = await resolveWindow(
      { provider: "ollama", model: "qwen:latest", baseUrl: BASE, contextSize: 8192 },
      { fetch: ollama("qwen:latest", { running: 65536 }), retryDelayMs: 0 },
    );
    expect(got).toEqual({ window: 8192, source: "explicit" });
  });

  test("explicit number above the server window throws", async () => {
    const run = resolveWindow(
      { provider: "ollama", model: "qwen:latest", baseUrl: BASE, contextSize: 131072 },
      { fetch: ollama("qwen:latest", { running: 65536 }), retryDelayMs: 0 },
    );
    await expect(run).rejects.toBeInstanceOf(ModelError);
  });
});

describe("parseContextSize", () => {
  test("auto in any case", () => {
    expect(parseContextSize("auto", "--context-size")).toBe("auto");
    expect(parseContextSize("AUTO", "--context-size")).toBe("auto");
  });

  test("a whole number above 4096", () => {
    expect(parseContextSize("8192", "--context-size")).toBe(8192);
    expect(parseContextSize(undefined, "--context-size")).toBeUndefined();
  });

  test("4096 and words throw", () => {
    expect(() => parseContextSize("4096", "--context-size")).toThrow(/--context-size/);
    expect(() => parseContextSize("big", "--context-size")).toThrow(/--context-size/);
  });

  test("resolveLocalConfig treats auto as omitted", () => {
    const cfg = resolveLocalConfig({ provider: "ollama", model: "q", contextSize: "auto", env: {} });
    expect(cfg.contextSize).toBeUndefined();
  });
});

test("every lane model has a window", () => {
  for (const flags of Object.values(LANES)) {
    const model = flags[flags.indexOf("--model") + 1]!;
    expect(CLAUDE_CODE_WINDOWS[model]).toBeGreaterThan(0);
  }
});
