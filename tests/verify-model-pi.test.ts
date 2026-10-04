import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildPiProvider,
  materializePiHome,
  prepareLocalProvider,
  resolveLocalConfig,
} from "../harness/model/index.ts";
import { jsonResponse, pathname, quiet, scripted, type Hit } from "./fixtures/verify-model/mock.ts";

/**
 * The pi registry and the preflight that feeds it: the output-token field pi really sends
 * [4178394544] and the context window that is registered with pi [4178394609, 4178394627].
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("pi registry output cap [4178394544]", () => {
  test("both providers register max_tokens, and the materialized models.json carries it", () => {
    for (const provider of ["ollama", "llamacpp"]) {
      const config = resolveLocalConfig({ provider, model: "m", maxTokens: 1000, env: {} });
      const record = buildPiProvider(config, "m", 32768);
      expect(record.config.compat).toMatchObject({ maxTokensField: "max_tokens" });
      const dir = mkdtempSync(join(tmpdir(), "vh-vm-"));
      dirs.push(dir);
      materializePiHome(dir, record);
      const written = JSON.parse(readFileSync(join(dir, "models.json"), "utf8")) as {
        providers: Record<string, { compat: { maxTokensField: string }; models: { maxTokens: number }[] }>;
      };
      expect(written.providers[provider]!.compat.maxTokensField).toBe("max_tokens");
      expect(written.providers[provider]!.models[0]!.maxTokens).toBe(1000);
    }
  });

  test("the output ceiling defaults to 8192 and never exceeds the window", () => {
    const config = resolveLocalConfig({ provider: "ollama", model: "m", env: {} });
    const models = (window: number) => buildPiProvider(config, "m", window).config.models as { maxTokens: number }[];
    expect(models(32768)[0]!.maxTokens).toBe(8192);
    expect(models(5000)[0]!.maxTokens).toBe(5000);
  });
});

describe("registered context window [4178394609, 4178394627]", () => {
  function ollamaServer(opts: { show?: Record<string, unknown>; ps?: unknown[] }) {
    return scripted((hit: Hit) => {
      if (hit.url.endsWith("/api/tags")) return jsonResponse({ models: [{ name: "qwen:latest" }] });
      if (hit.url.endsWith("/api/show")) return jsonResponse({ capabilities: ["tools"], ...opts.show });
      if (hit.url.endsWith("/api/ps")) return jsonResponse({ models: opts.ps ?? [] });
      return jsonResponse({ error: `unexpected ${hit.url}` }, 500);
    });
  }
  const ollamaConfig = (extra: { contextSize?: number } = {}) =>
    resolveLocalConfig({ provider: "ollama", model: "qwen", retries: 0, timeoutMs: 1000, env: {}, ...extra });

  test("an unknown Ollama window is an error that names the settings, never a 32768 default", async () => {
    for (const extra of [{}, { contextSize: 32768 }]) {
      const mock = ollamaServer({ show: { model_info: { "llama.context_length": 131072 } } });
      const error = await prepareLocalProvider(ollamaConfig(extra), { fetch: mock.fetch, ...quiet }).then(
        () => undefined,
        (err: unknown) => err as Error,
      );
      expect(error).toMatchObject({ name: "ModelError", code: "unsupported" });
      expect(error!.message).toContain("OLLAMA_CONTEXT_LENGTH");
      expect(error!.message).toContain("num_ctx");
      expect(error!.message).not.toContain("registered");
      expect(mock.hits.some((hit) => hit.url.endsWith("/api/chat"))).toBe(false);
    }
  });

  test("a server-wide OLLAMA_CONTEXT_LENGTH is only visible once the model is loaded, and the error says to load it", async () => {
    const mock = ollamaServer({ ps: [] });
    await expect(prepareLocalProvider(ollamaConfig(), { fetch: mock.fetch, ...quiet })).rejects.toThrow(/ollama run qwen/);

    const loaded = ollamaServer({ ps: [{ name: "qwen:latest", model: "qwen:latest", context_length: 32768 }] });
    const prepared = await prepareLocalProvider(ollamaConfig(), { fetch: loaded.fetch, ...quiet });
    expect(prepared.probe.capabilities.contextSize).toBe(32768);
    expect(prepared.piProvider.config.models).toEqual([expect.objectContaining({ contextWindow: 32768 })]);
  });

  test("buildPiProvider will not register a model without a verified window", () => {
    const config = resolveLocalConfig({ provider: "ollama", model: "qwen", env: {} });
    expect(() => buildPiProvider(config, "qwen")).toThrow(/verified context window/);
    expect(() => buildPiProvider(config, "qwen", 0)).toThrow(/verified context window/);
  });

  test("pi's 4096-token reserve: every window at or below it is refused, one above it is registered", async () => {
    for (const window of [1, 2048, 4095, 4096]) {
      const mock = ollamaServer({ show: { parameters: `num_ctx ${window}` } });
      await expect(prepareLocalProvider(ollamaConfig(), { fetch: mock.fetch, ...quiet })).rejects.toMatchObject({
        code: "unsupported",
        message: expect.stringContaining("reserves 4096 tokens"),
      });
    }
    const mock = ollamaServer({ show: { parameters: "num_ctx 4097" } });
    const prepared = await prepareLocalProvider(ollamaConfig(), { fetch: mock.fetch, ...quiet });
    expect(prepared.piProvider.config.models).toEqual([expect.objectContaining({ contextWindow: 4097 })]);
    expect(prepared.warnings.join(" ")).toContain("4097");
  });

  test("the reserve check uses the window pi will get: the requested size when given, else the server's", async () => {
    const big = () => ollamaServer({ show: { parameters: "num_ctx 32768" } });
    await expect(prepareLocalProvider(ollamaConfig({ contextSize: 4096 }), { fetch: big().fetch, ...quiet })).rejects.toThrow(
      /4096-token context window/,
    );
    const ok = await prepareLocalProvider(ollamaConfig({ contextSize: 6000 }), { fetch: big().fetch, ...quiet });
    expect(ok.piProvider.config.models).toEqual([expect.objectContaining({ contextWindow: 6000 })]);
  });

  test("a short window warning says what pi does with it, instead of claiming it runs fine", async () => {
    const mock = ollamaServer({ show: { parameters: "num_ctx 5000" } });
    const prepared = await prepareLocalProvider(ollamaConfig(), { fetch: mock.fetch, ...quiet });
    const warning = prepared.warnings.join(" ");
    expect(warning).toContain("5000");
    expect(warning).toContain("4096");
    expect(warning).not.toContain("pi can run that");
  });

  test("llama-server: a 4096-token n_ctx is refused the same way", async () => {
    const mock = scripted((hit: Hit) => {
      switch (pathname(hit.url)) {
        case "/health":
          return jsonResponse({ status: "ok" });
        case "/v1/models":
          return jsonResponse({ data: [{ id: "model.gguf" }] });
        case "/props":
          return jsonResponse({ default_generation_settings: { n_ctx: 4096 } });
        default:
          return jsonResponse({}, 404);
      }
    });
    await expect(
      prepareLocalProvider(
        resolveLocalConfig({ provider: "llamacpp", model: "model.gguf", retries: 0, timeoutMs: 1000, env: {} }),
        { fetch: mock.fetch, ...quiet },
      ),
    ).rejects.toThrow(/reserves 4096 tokens/);
  });
});
