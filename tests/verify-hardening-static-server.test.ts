import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serve } from "../harness/skills/_shared/static_server.ts";

// CodeQL alert #2 (js/path-injection): pageprobe's static server joined the raw request path
// under the served root with no containment check. The page under test is agent-written, so its
// own script could read any host file the probe process could.

const SECRET = "HOST-SECRET-DO-NOT-SERVE";

let base: string;
let root: string;
let server: ReturnType<typeof serve>["server"];
let port: number;

/** A raw GET. `fetch` and `URL` normalise "../" away before sending; node:http sends the path as given. */
function get(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "vh-static-"));
  root = join(base, "site");
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(base, "secret.txt"), SECRET);
  writeFileSync(join(root, "index.html"), "<h1>home</h1>");
  writeFileSync(join(root, "sub", "page.html"), "<p>page</p>");
  writeFileSync(join(root, "..odd-name.txt"), "dots are fine inside a name");
  const s = serve(root);
  server = s.server;
  if (!server.listening) await once(server, "listening");
  port = s.port;
});

afterAll(() => {
  server.close();
  rmSync(base, { recursive: true, force: true });
});

describe("static server serves the page under test", () => {
  test("/ is index.html, and a query string is ignored", async () => {
    expect(await get("/")).toEqual({ status: 200, body: "<h1>home</h1>" });
    expect(await get("/index.html?v=3")).toEqual({ status: 200, body: "<h1>home</h1>" });
  });

  test("nested files are served; a missing file and a directory are 404", async () => {
    expect(await get("/sub/page.html")).toEqual({ status: 200, body: "<p>page</p>" });
    expect((await get("/nope.html")).status).toBe(404);
    expect((await get("/sub")).status).toBe(404);
  });

  test("a file name that merely starts with two dots is served", async () => {
    expect((await get("/..odd-name.txt")).status).toBe(200);
  });

  test("an encoded space and other ordinary escapes decode once", async () => {
    writeFileSync(join(root, "a b.txt"), "spaced");
    expect(await get("/a%20b.txt")).toEqual({ status: 200, body: "spaced" });
  });
});

describe("static server refuses a path that leaves the root", () => {
  const escapes: [string, string][] = [
    ["a literal ../", "/../secret.txt"],
    ["a nested ../", "/sub/../../secret.txt"],
    ["an encoded dot-dot", "/%2e%2e/secret.txt"],
    ["an upper-case encoded dot-dot", "/%2E%2E/secret.txt"],
    ["a fully encoded dot-dot and slash", "/%2e%2e%2fsecret.txt"],
    ["an encoded backslash", "/..%5csecret.txt"],
    ["an encoded dot-dot and backslash", "/%2e%2e%5csecret.txt"],
    ["a doubled leading slash", "//../secret.txt"],
  ];
  for (const [name, path] of escapes) {
    test(`${name}: ${path}`, async () => {
      const r = await get(path);
      expect(r.body).not.toContain(SECRET);
      expect(r.status).toBe(403);
    });
  }

  // A backslash is a separator on Windows and a name character on POSIX, and Bun 1.4's
  // realpathSync reads it as a separator on Linux too, where Node does not. Refusing it everywhere
  // gives one answer on every platform and runtime.
  test("a backslash is refused even when the path it names stays inside the root", async () => {
    const r = await get("/sub%5cpage.html");
    expect(r.body).not.toContain("<p>page</p>");
    expect(r.status).toBe(403);
  });

  test("a double-encoded dot-dot is decoded once, so it names a file that does not exist", async () => {
    const r = await get("/%252e%252e/secret.txt");
    expect(r.body).not.toContain(SECRET);
    expect(r.status).toBe(404);
  });

  test("a malformed escape is a 400, not a crash", async () => {
    expect((await get("/%E0%A4%A")).status).toBe(400);
    expect((await get("/ok.html%00.png")).status).toBe(400);
    expect((await get("/")).status).toBe(200); // the server is still up
  });

  test.if(process.platform === "win32")("a drive-letter path is refused", async () => {
    const r = await get(`/${join(base, "secret.txt").replaceAll("\\", "/")}`);
    expect(r.body).not.toContain(SECRET);
    expect(r.status).toBe(403);
  });

  test("a directory link inside the root that points outside it is not followed", async () => {
    // A junction needs no privilege on Windows; on other platforms the type is ignored and it is a plain symlink.
    symlinkSync(base, join(root, "out"), "junction");
    const r = await get("/out/secret.txt");
    expect(r.body).not.toContain(SECRET);
    expect(r.status).toBe(403);
  });
});
