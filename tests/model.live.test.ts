import { describe, expect, test } from "bun:test";

import { createBackend, resolveLocalConfig } from "../harness/model/index.ts";

/**
 * Live checks against a real local server. They do not run in CI.
 *
 *   VERIHARNESS_LIVE_OLLAMA=1 VERIHARNESS_OLLAMA_MODEL=qwen2.5:7b bun test tests/model.live.test.ts
 *   VERIHARNESS_LIVE_LLAMACPP=1 VERIHARNESS_LLAMACPP_MODEL=model.gguf bun test tests/model.live.test.ts
 *
 * Optional: VERIHARNESS_OLLAMA_BASE_URL, VERIHARNESS_LLAMACPP_BASE_URL.
 */

const liveOllama = process.env.VERIHARNESS_LIVE_OLLAMA === "1";
const liveLlama = process.env.VERIHARNESS_LIVE_LLAMACPP === "1";

describe.skipIf(!liveOllama)("ollama live", () => {
  test(
    "probe and a short completion",
    async () => {
      const model = process.env.VERIHARNESS_OLLAMA_MODEL;
      if (!model) throw new Error("set VERIHARNESS_OLLAMA_MODEL");
      const backend = createBackend(resolveLocalConfig({ provider: "ollama", model }));
      const probe = await backend.probe();
      expect(probe.models.join("\n")).toContain(model.split(":")[0]!);
      const response = await backend.complete({
        messages: [{ role: "user", content: "Reply with the single word pong." }],
        maxTokens: 32,
        temperature: 0,
      });
      expect((response.message.content ?? "").toLowerCase()).toContain("pong");
    },
    { timeout: 180_000 },
  );
});

describe.skipIf(!liveLlama)("llama.cpp live", () => {
  test(
    "probe and a short completion",
    async () => {
      const model = process.env.VERIHARNESS_LLAMACPP_MODEL;
      if (!model) throw new Error("set VERIHARNESS_LLAMACPP_MODEL");
      const backend = createBackend(resolveLocalConfig({ provider: "llamacpp", model }));
      const probe = await backend.probe();
      expect(probe.model.length).toBeGreaterThan(0);
      const response = await backend.complete({
        messages: [{ role: "user", content: "Reply with the single word pong." }],
        maxTokens: 32,
        temperature: 0,
      });
      expect((response.message.content ?? "").toLowerCase()).toContain("pong");
    },
    { timeout: 180_000 },
  );
});
