import { describe, expect, test } from "bun:test";

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main as batchMain } from "../harness/batch/main.ts";
import { createBackend, resolveLocalConfig } from "../harness/model/index.ts";
import { main as workersMain } from "../harness/workers/main.ts";

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
        // A thinking model (qwen3.5) spends its first tokens on reasoning: 32 left the reply empty.
        maxTokens: 1024,
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
        // A thinking model (qwen3.5) spends its first tokens on reasoning: 32 left the reply empty.
        maxTokens: 1024,
        temperature: 0,
      });
      expect((response.message.content ?? "").toLowerCase()).toContain("pong");
    },
    { timeout: 180_000 },
  );
});

describe.skipIf(!liveOllama)("batch and workers live", () => {
  test(
    "batch three items by the model's window, then two workers on b01",
    async () => {
      const model = process.env.VERIHARNESS_OLLAMA_MODEL;
      if (!model) throw new Error("set VERIHARNESS_OLLAMA_MODEL");
      const server = process.env.VERIHARNESS_OLLAMA_BASE_URL ? ["--base-url", process.env.VERIHARNESS_OLLAMA_BASE_URL] : [];
      const root = mkdtempSync(join(tmpdir(), "vh-live-batch-"));
      try {
        const items = join(root, "items.md");
        writeFileSync(items, "### item 1\nThe word is apple.\n### item 2\nThe word is pear.\n### item 3\nThe word is plum.\n");
        writeFileSync(join(root, "task.md"), "For each item in workspace/items.md, give its number and its word.\n");
        writeFileSync(
          join(root, "prompt.md"),
          'Read spec/task.md and workspace/items.md. Reply with JSON only, as {"items": [{"id": 1, "word": "apple"}]}.\n',
        );
        const out = join(root, "work");
        const argv = ["--items", items, "--split", "heading:^### item (\\d+)$", "--spec", join(root, "task.md")];
        const made = await batchMain([...argv, "--prompt", join(root, "prompt.md"), "--provider", "ollama", "--model", model, ...server, "--out", out]);
        expect(made).toBe(0);
        const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
        expect(["loaded", "num_ctx"]).toContain(manifest.windowSource);
        const ran = await workersMain([out, "--provider", "ollama", "--model", model, ...server, "--count", "2", "--only", "b01", "--timeout", "900"]);
        expect([0, 1]).toContain(ran); // 1: a worker that broke the format; the records still exist
        for (const r of ["r01", "r02"]) expect(existsSync(join(out, "b01", "rollouts", r, "trajectory", "worker.json"))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    { timeout: 1_900_000 },
  );
});
