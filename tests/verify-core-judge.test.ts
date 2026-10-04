import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

// Grader modules read VERIHARNESS_BENCH_ROOT when first imported; use the stand-in checkout.
const BENCH_ROOT = resolve(import.meta.dir, "fixtures", "verify-core", "bench");

async function importWithBenchRoot<T>(load: () => Promise<T>): Promise<T> {
  const prev = process.env.VERIHARNESS_BENCH_ROOT;
  process.env.VERIHARNESS_BENCH_ROOT = BENCH_ROOT;
  try {
    return await load();
  } finally {
    if (prev === undefined) delete process.env.VERIHARNESS_BENCH_ROOT;
    else process.env.VERIHARNESS_BENCH_ROOT = prev;
  }
}

type FetchCall = { url: string; init?: RequestInit };
const realFetch = globalThis.fetch;
let calls: FetchCall[] = [];

/** Replace fetch with a stub. The real fetch is restored after each test; nothing leaves the process. */
function stubFetch(respond: () => Response | Promise<Response>): void {
  calls = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond();
  }) as unknown as typeof fetch;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const JUDGES = [
  {
    name: "jb",
    load: () => importWithBenchRoot(() => import("../harness/grade/jb.ts")),
  },
  {
    name: "wsb",
    load: () => importWithBenchRoot(() => import("../harness/grade/wsb.ts")),
  },
] as const;

for (const judge of JUDGES) {
  describe(`${judge.name} judge preflight`, () => {
    test("a 2xx JSON response is healthy", async () => {
      const mod = await judge.load();
      stubFetch(() => json(200, { choices: [] }));
      expect(await mod.preflight()).toBe("");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toEndWith("/chat/completions");
    });

    test("HTTP 401 with a JSON body is NOT healthy", async () => {
      const mod = await judge.load();
      stubFetch(() => json(401, { error: { message: "invalid api key" } }));
      const problem = await mod.preflight();
      expect(problem).not.toBe("");
      expect(problem).toContain("401");
    });

    test("HTTP 404 with a JSON body is NOT healthy", async () => {
      const mod = await judge.load();
      stubFetch(() => json(404, { error: { message: "model not found" } }));
      const problem = await mod.preflight();
      expect(problem).not.toBe("");
      expect(problem).toContain("404");
    });

    test("HTTP 500 with a JSON body is NOT healthy", async () => {
      const mod = await judge.load();
      stubFetch(() => json(500, { error: { message: "upstream failure" } }));
      const problem = await mod.preflight();
      expect(problem).not.toBe("");
      expect(problem).toContain("500");
      expect(problem).toContain("upstream failure");
    });

    test("a network error is NOT healthy", async () => {
      const mod = await judge.load();
      stubFetch(() => {
        throw new TypeError("connect ECONNREFUSED");
      });
      const problem = await mod.preflight();
      expect(problem).toContain("unreachable");
    });

    test("a 200 response that is not JSON is NOT healthy", async () => {
      const mod = await judge.load();
      stubFetch(() => new Response("<html>gateway</html>", { status: 200 }));
      expect(await mod.preflight()).not.toBe("");
    });

    test("the error text never contains the API key", async () => {
      const mod = await judge.load();
      stubFetch(() => json(401, { error: { message: "denied" } }));
      const problem = await mod.preflight();
      const auth = (calls[0]!.init?.headers as Record<string, string>).Authorization;
      // The Authorization header is "Bearer <key>"; with no key configured the key part is empty.
      const key = auth.replace(/^Bearer\s*/, "");
      if (key) expect(problem).not.toContain(key);
    });
  });
}
