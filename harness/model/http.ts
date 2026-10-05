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

import { timerDelay } from "../timer.js";

/**
 * Minimal HTTP for local model servers.
 *
 * No Authorization header is ever set: Ollama and llama-server do not need a key.
 * Connection refused is not retried (the server is down). 408/429/500/502/503/504
 * and connection resets are retried. A caller-supplied fetch keeps tests off the network.
 */

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class TransportError extends Error {
  readonly kind: "unreachable" | "timeout" | "reset";

  constructor(kind: "unreachable" | "timeout" | "reset", message: string) {
    super(message);
    this.name = "TransportError";
    this.kind = kind;
  }
}

export interface HttpResult {
  status: number;
  text: string;
  json: unknown;
  stream: ReadableStream<Uint8Array> | null;
}

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUS.has(status);
}

export function networkFailureKind(err: unknown): "refused" | "timeout" | "reset" | "other" {
  if (!err || typeof err !== "object") return "other";
  const e = err as { name?: string; message?: string; code?: string; cause?: unknown };
  const cause = e.cause && typeof e.cause === "object" ? (e.cause as { code?: string; message?: string }) : undefined;
  const code = e.code ?? cause?.code;
  const msg = `${e.name ?? ""} ${e.message ?? ""} ${cause?.message ?? ""} ${code ?? ""}`;
  if (e.name === "AbortError" || e.name === "TimeoutError" || /aborted|timed out|TimeoutError/i.test(msg)) {
    return "timeout";
  }
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ETIMEDOUT") return "reset";
  if (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EHOSTUNREACH" ||
    code === "EAI_AGAIN" ||
    /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|network/i.test(msg)
  ) {
    return "refused";
  }
  return "other";
}

export class HttpClient {
  readonly fetchImpl: FetchLike;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly retryDelayMs: number;

  constructor(opts: { fetch?: FetchLike; timeoutMs: number; retries: number; retryDelayMs?: number }) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs;
    this.retries = opts.retries;
    this.retryDelayMs = opts.retryDelayMs ?? 400;
  }

  async send(
    url: string,
    init: { method?: string; body?: unknown; timeoutMs?: number; stream?: boolean },
  ): Promise<HttpResult> {
    const timeoutMs = init.timeoutMs ?? this.timeoutMs;
    const attempts = this.retries + 1;
    let lastReset: TransportError | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const result = await this.once(url, init, timeoutMs);
        if (isTransientStatus(result.status) && attempt < attempts - 1) {
          await delay(this.retryDelayMs * (attempt + 1));
          continue;
        }
        return result;
      } catch (err) {
        const kind = networkFailureKind(err);
        if (kind === "timeout") {
          throw new TransportError("timeout", `request to ${url} timed out after ${timeoutMs}ms`);
        }
        if (kind === "refused") {
          throw new TransportError("unreachable", `cannot connect to ${url}`);
        }
        if (kind === "reset" && attempt < attempts - 1) {
          lastReset = new TransportError("reset", `connection to ${url} failed`);
          await delay(this.retryDelayMs * (attempt + 1));
          continue;
        }
        if (kind === "reset") {
          throw new TransportError("reset", `connection to ${url} failed`);
        }
        throw err;
      }
    }
    throw lastReset ?? new TransportError("reset", `request to ${url} failed`);
  }

  private async once(
    url: string,
    init: { method?: string; body?: unknown; stream?: boolean },
    timeoutMs: number,
  ): Promise<HttpResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timerDelay(timeoutMs));
    let keepTimer = false;
    try {
      const headers: Record<string, string> = {};
      if (init.body !== undefined) headers["content-type"] = "application/json";
      const res = await this.fetchImpl(url, {
        method: init.method ?? "GET",
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: ctrl.signal,
      });
      if (init.stream && res.ok && res.body) {
        keepTimer = true;
        const stream = res.body;
        const tracked = new ReadableStream<Uint8Array>({
          async start(controller) {
            const reader = stream.getReader();
            try {
              while (true) {
                const step = await reader.read();
                if (step.done) break;
                controller.enqueue(step.value);
              }
              controller.close();
            } catch (err) {
              controller.error(err);
            } finally {
              clearTimeout(timer);
              reader.releaseLock();
            }
          },
          cancel() {
            clearTimeout(timer);
          },
        });
        return { status: res.status, text: "", json: undefined, stream: tracked };
      }
      const text = await res.text();
      let json: unknown;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
      }
      return { status: res.status, text, json, stream: null };
    } finally {
      if (!keepTimer) clearTimeout(timer);
    }
  }
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      buf += decoder.decode(step.value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        yield buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    }
    buf += decoder.decode();
    if (buf.length) yield buf.replace(/\r$/, "");
  } finally {
    reader.releaseLock();
  }
}

export function errorText(json: unknown, text: string): string {
  if (json && typeof json === "object") {
    const rec = json as Record<string, unknown>;
    if (typeof rec.error === "string") return rec.error;
    if (rec.error && typeof rec.error === "object") {
      const inner = rec.error as Record<string, unknown>;
      if (typeof inner.message === "string") return inner.message;
    }
    if (typeof rec.message === "string") return rec.message;
  }
  return text.trim();
}
