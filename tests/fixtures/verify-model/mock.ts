/**
 * HTTP mocks for the local-model tests. Nothing here opens a socket: every request goes
 * to a scripted `fetch`, so no test can reach a real Ollama or llama-server.
 */

export interface Hit {
  url: string;
  init: RequestInit;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function textStream(parts: string[], contentType = "text/event-stream"): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": contentType } });
}

export function scripted(handler: (hit: Hit, index: number) => Response | Promise<Response>): {
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

export function pathname(url: string): string {
  return new URL(url).pathname;
}

/** Options every test passes so no cache file is read or written and retries do not sleep. */
export const quiet = { cache: false as const, assumeTools: false as const, retryDelayMs: 0 };
