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
 * llama-server's OpenAI-compatible HTTP API (default http://127.0.0.1:8080).
 *
 * Works for single-model mode (`llama-server -m file.gguf`) and for the router
 * (`llama-server --models-dir ...`). Health, `/v1/models` and `/props` are the
 * preflight. Context is `n_ctx` from `GET /props?model=<id>`, falling back to
 * `GET /props` when that query is 404. Chat is `POST /v1/chat/completions` with
 * SSE streaming. A stream that ends without `finish_reason` or `[DONE]` is a
 * failure. Context length is fixed by the server's `-c` flag; this client
 * refuses a requested context larger than the one the server reports, and it
 * does not invent a window when `n_ctx` is missing.
 */

import { errorText, HttpClient, readLines, TransportError, type FetchLike } from "./http.js";
import { guardKnownFeatures, httpFailure, modelMissingError, transportFailure } from "./messages.js";
import {
  buildOpenAiChatBody,
  parseOpenAiChatResponse,
  parseOpenAiSseLines,
} from "./openai_chat.js";
import {
  ModelError,
  type Capabilities,
  type ChatRequest,
  type ChatResponse,
  type ModelBackend,
  type ProbeResult,
  type StreamEvent,
  assertJsonContent,
  assertRequiredTools,
  foldEvents,
} from "./types.js";
import { apiRoots } from "./url.js";

export interface LlamaCppDeps {
  fetch?: FetchLike;
  timeoutMs: number;
  retries: number;
  retryDelayMs?: number;
}

export interface ListedModel {
  id: string;
  loaded: boolean;
}

/** Accept an exact id, or a unique basename (`model.gguf` matches a path id). */
export function matchLoadedModel(
  ids: string[],
  wanted: string,
): { id: string } | { error: "none" | "ambiguous"; ids: string[] } {
  const exact = ids.filter((id) => id === wanted);
  if (exact.length === 1) return { id: exact[0]! };
  const base = ids.filter((id) => id.split(/[\\/]/).pop() === wanted);
  if (base.length === 1) return { id: base[0]! };
  if (base.length > 1) return { error: "ambiguous", ids: base };
  return { error: "none", ids };
}

export function parseModelIds(body: unknown): ListedModel[] {
  if (!body) return [];
  const list = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown }).data)
      ? ((body as { data: unknown[] }).data)
      : Array.isArray((body as { models?: unknown }).models)
        ? ((body as { models: unknown[] }).models)
        : [];
  const out: ListedModel[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      out.push({ id: item, loaded: true });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = rec.id ?? rec.name ?? rec.model;
    if (typeof id !== "string" || !id) continue;
    const status = modelStatus(rec);
    const loaded = status === "" ? rec.loaded !== false : status === "loaded" || status === "ready";
    out.push({ id, loaded: status === "unloaded" ? false : loaded });
  }
  return out;
}

function modelStatus(rec: Record<string, unknown>): string {
  if (typeof rec.status === "string") return rec.status.toLowerCase();
  if (rec.status && typeof rec.status === "object") {
    const value = (rec.status as { value?: unknown }).value;
    if (typeof value === "string") return value.toLowerCase();
  }
  return "";
}

export function parseLlamaContext(props: unknown): number | undefined {
  if (!props || typeof props !== "object") return undefined;
  const rec = props as Record<string, unknown>;
  if (typeof rec.n_ctx === "number") return rec.n_ctx;
  const defaults = rec.default_generation_settings;
  if (defaults && typeof defaults === "object") {
    const n = (defaults as Record<string, unknown>).n_ctx;
    if (typeof n === "number") return n;
  }
  return undefined;
}

export class LlamaCppBackend implements ModelBackend {
  readonly id = "llamacpp" as const;
  readonly baseUrl: string;
  /** Id the server actually serves. Probe may widen a basename to the full id. */
  model: string;
  private readonly root: string;
  private readonly openai: string;
  private readonly http: HttpClient;
  private capabilities: Capabilities | undefined;

  constructor(model: string, baseUrl: string, deps: LlamaCppDeps) {
    const roots = apiRoots(baseUrl);
    this.model = model;
    this.baseUrl = roots.root;
    this.root = roots.root;
    this.openai = roots.openai;
    this.http = new HttpClient(deps);
  }

  remember(capabilities: Capabilities): void {
    this.capabilities = capabilities;
  }

  async probe(): Promise<ProbeResult> {
    await this.assertHealthy();
    const listed = await this.listModels();
    const loaded = listed.filter((m) => m.loaded);
    const match = matchLoadedModel(
      loaded.map((m) => m.id),
      this.model,
    );
    if ("error" in match) {
      const known = listed.find((m) => m.id === this.model || m.id.split(/[\\/]/).pop() === this.model);
      const loadedIds = loaded.map((m) => m.id).join(", ") || "(none)";
      if (known && !known.loaded) {
        throw modelMissingError(
          "llamacpp",
          this.model,
          this.baseUrl,
          `The model is on the server but not loaded. Loaded models: ${loadedIds}.`,
        );
      }
      const shown = (match.ids.length ? match.ids : loaded.map((m) => m.id)).join(", ") || "(none)";
      const why =
        match.error === "ambiguous"
          ? `Several loaded models match that name (${shown}). Pass the full id.`
          : `Loaded models: ${shown}.`;
      throw modelMissingError("llamacpp", this.model, this.baseUrl, why);
    }
    this.model = match.id;
    const props = await this.readProps(this.model);
    const contextSize = props.status < 400 ? parseLlamaContext(props.json) : undefined;
    const capabilities: Capabilities = { tools: "unknown", json: "unknown", contextSize };
    this.capabilities = capabilities;
    return { model: this.model, capabilities, models: listed.map((m) => m.id) };
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    guardKnownFeatures("llamacpp", this.model, req, this.capabilities?.tools, this.capabilities?.json);
    const body = buildOpenAiChatBody(this.model, { ...req, stream: false });
    const json = await this.post("/chat/completions", body, req.timeoutMs);
    const parsed = parseOpenAiChatResponse(json, this.model);
    if (req.json && !parsed.message.toolCalls?.length) assertJsonContent("llamacpp", parsed.message.content);
    assertRequiredTools("llamacpp", req, parsed);
    return parsed;
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    guardKnownFeatures("llamacpp", this.model, req, this.capabilities?.tools, this.capabilities?.json);
    let body = buildOpenAiChatBody(this.model, { ...req, stream: true });
    let res = await this.postStream(body, req.timeoutMs);
    if (res.status >= 400 && /stream_options/i.test(errorText(res.json, res.text))) {
      delete body.stream_options;
      body = { ...body };
      res = await this.postStream(body, req.timeoutMs);
    }
    if (res.status >= 400 || !res.stream) {
      throw httpFailure("llamacpp", this.model, this.baseUrl, res.status, res.text, res.json);
    }
    const events: StreamEvent[] = [];
    for await (const event of parseOpenAiSseLines(readLines(res.stream))) {
      events.push(event);
      if (event.type === "done") {
        const folded = foldEvents(this.model, events);
        if (req.json && !folded.message.toolCalls?.length) assertJsonContent("llamacpp", folded.message.content);
        assertRequiredTools("llamacpp", req, folded);
      }
      yield event;
    }
  }

  /** Router builds expose per-model props. A 404 falls back to the single-model `/props`. */
  private async readProps(model: string): Promise<{ status: number; json: unknown; text: string }> {
    const scoped = await this.getQuiet(`${this.root}/props?model=${encodeURIComponent(model)}`);
    if (scoped.status !== 404) return scoped;
    return this.getQuiet(`${this.root}/props`);
  }

  private async getQuiet(url: string): Promise<{ status: number; json: unknown; text: string }> {
    try {
      return await this.http.send(url, { method: "GET" });
    } catch (err) {
      if (err instanceof TransportError) throw transportFailure("llamacpp", this.baseUrl, err);
      throw err;
    }
  }

  private async assertHealthy(): Promise<void> {
    let res;
    try {
      res = await this.http.send(`${this.root}/health`, { method: "GET" });
    } catch (err) {
      if (err instanceof TransportError) throw transportFailure("llamacpp", this.baseUrl, err);
      throw err;
    }
    if (res.status === 404) return;
    if (res.status === 503) {
      const detail = typeof res.json === "object" && res.json ? JSON.stringify(res.json) : res.text;
      throw new ModelError(
        "llamacpp",
        "http",
        `llama-server at ${this.baseUrl} is up but the model is still loading (${detail.slice(0, 200) || "HTTP 503"}). Retry shortly.`,
      );
    }
    if (res.status >= 400) {
      throw httpFailure("llamacpp", this.model, this.baseUrl, res.status, res.text, res.json);
    }
  }

  private async listModels(): Promise<ListedModel[]> {
    const collected: ListedModel[] = [];
    for (const path of [`${this.openai}/models`, `${this.root}/models`]) {
      let res;
      try {
        res = await this.http.send(path, { method: "GET" });
      } catch (err) {
        if (err instanceof TransportError) throw transportFailure("llamacpp", this.baseUrl, err);
        throw err;
      }
      if (res.status === 404) continue;
      if (res.status >= 400) {
        throw httpFailure("llamacpp", this.model, this.baseUrl, res.status, res.text, res.json);
      }
      for (const item of parseModelIds(res.json)) {
        const prev = collected.find((m) => m.id === item.id);
        if (!prev) collected.push(item);
        else if (item.loaded) prev.loaded = true;
      }
    }
    return collected;
  }

  private async postStream(body: unknown, timeoutMs?: number) {
    try {
      return await this.http.send(`${this.openai}/chat/completions`, {
        method: "POST",
        body,
        timeoutMs,
        stream: true,
      });
    } catch (err) {
      if (err instanceof TransportError) throw transportFailure("llamacpp", this.baseUrl, err);
      throw err;
    }
  }

  private async post(path: string, body: unknown, timeoutMs?: number): Promise<unknown> {
    try {
      const res = await this.http.send(`${this.openai}${path}`, { method: "POST", body, timeoutMs });
      if (res.status >= 400) throw httpFailure("llamacpp", this.model, this.baseUrl, res.status, res.text, res.json);
      return res.json;
    } catch (err) {
      if (err instanceof TransportError) throw transportFailure("llamacpp", this.baseUrl, err);
      throw err;
    }
  }
}
