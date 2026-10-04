import { describe, expect, test } from "bun:test";

import { createBackend, prepareLocalProvider, resolveLocalConfig } from "../harness/model/index.ts";
import { jsonResponse, pathname, quiet, scripted, type Hit } from "./fixtures/verify-model/mock.ts";

/**
 * llama-server in router mode serves many models from one port. `GET /props` then describes
 * the router, and a model's own window is only at `GET /props?model=<id>` [4178394578].
 * The mock below tells the two apart by query string, like the real router does.
 */

const ROUTED_ID = "/models/my model.gguf";

function router(opts: { scopedStatus?: number; scopedCtx?: number; bareBody?: unknown } = {}) {
  const { scopedStatus = 200, scopedCtx = 8192, bareBody = {} } = opts;
  return scripted((hit: Hit) => {
    const url = new URL(hit.url);
    switch (url.pathname) {
      case "/health":
        return jsonResponse({ status: "ok" });
      case "/v1/models":
        return jsonResponse({ data: [{ id: ROUTED_ID, status: { value: "loaded" } }] });
      case "/models":
        return jsonResponse({ error: "no such route" }, 404);
      case "/props": {
        const wanted = url.searchParams.get("model");
        if (wanted === null) return jsonResponse(bareBody);
        if (wanted !== ROUTED_ID) return jsonResponse({ error: `unknown model ${wanted}` }, 400);
        if (scopedStatus !== 200) return jsonResponse({ error: "router refused" }, scopedStatus);
        return jsonResponse({ default_generation_settings: { n_ctx: scopedCtx } });
      }
      default:
        return jsonResponse({ error: `unexpected ${hit.url}` }, 500);
    }
  });
}

function config(extra: { contextSize?: number } = {}) {
  return resolveLocalConfig({
    provider: "llamacpp",
    model: "my model.gguf",
    retries: 0,
    timeoutMs: 1000,
    env: {},
    ...extra,
  });
}

describe("llama.cpp router props [4178394578]", () => {
  test("probe reads the routed model's window from the URL-encoded model query", async () => {
    const mock = router({ scopedCtx: 8192 });
    const probe = await createBackend(config(), { fetch: mock.fetch }).probe();
    expect(probe.model).toBe(ROUTED_ID);
    expect(probe.capabilities.contextSize).toBe(8192);
    const props = mock.hits.filter((hit) => pathname(hit.url) === "/props");
    expect(props).toHaveLength(1);
    expect(props[0]!.url).toContain("?model=%2Fmodels%2Fmy%20model.gguf");
    expect(new URL(props[0]!.url).searchParams.get("model")).toBe(ROUTED_ID);
  });

  test("an oversized --context-size is rejected against the routed model's own window", async () => {
    const mock = router({ scopedCtx: 8192 });
    await expect(
      prepareLocalProvider(config({ contextSize: 32768 }), { fetch: mock.fetch, ...quiet, assumeTools: true }),
    ).rejects.toMatchObject({ code: "unsupported", message: expect.stringContaining("context 8192") });
  });

  test("a router that refuses the scoped query leaves the window unknown, and preflight fails closed", async () => {
    const mock = router({ scopedStatus: 400 });
    await expect(
      prepareLocalProvider(config({ contextSize: 32768 }), { fetch: mock.fetch, ...quiet, assumeTools: true }),
    ).rejects.toThrow(/did not report n_ctx/);
    // Only a 404 means "this build has no per-model props". A 400 must not fall through to the router's own /props.
    expect(mock.hits.filter((hit) => pathname(hit.url) === "/props")).toHaveLength(1);
  });

  test("the router's own bare /props is never used when the model query works", async () => {
    const mock = router({ scopedCtx: 16384, bareBody: { default_generation_settings: { n_ctx: 99999 } } });
    const probe = await createBackend(config(), { fetch: mock.fetch }).probe();
    expect(probe.capabilities.contextSize).toBe(16384);
  });
});
