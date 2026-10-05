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

import { createServer } from "node:http";
import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/** The file a request names, or the status that refuses it. */
export type ServedPath = { path: string } | { status: 400 | 403 | 404 };

/** True when `target` is `dir` or lies under it. Both are absolute and already normalised. */
function within(dir: string, target: string): boolean {
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  return target === dir || target.startsWith(prefix);
}

/**
 * Map a request URL to a file under `root`.
 *
 * The page under test is agent-written, and so is any script it runs, so the request path is
 * untrusted. The path is percent-decoded exactly once, resolved against `root`, and refused (403)
 * unless the result still lies under `root`. A symlink or junction that leads out of `root` is
 * refused too: `readFileSync` would follow it. A malformed escape or a NUL byte is a 400.
 *
 * A backslash is refused (403) wherever it appears. It is a separator on Windows and a name
 * character on POSIX, and Bun's `realpathSync` reads it as a separator on Linux as well, where
 * Node's does not (oven-sh/bun#33403). Without this rule, one URL would name different files on
 * different platforms and runtimes.
 */
export function resolveServedPath(root: string, requestUrl: string | undefined): ServedPath {
  const rawPath = (requestUrl ?? "/").split(/[?#]/, 1)[0] ?? "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { status: 400 };
  }
  if (decoded.includes("\0")) return { status: 400 };
  if (decoded.includes("\\")) return { status: 403 };

  const base = resolve(root);
  const path = resolve(base, decoded === "/" ? "index.html" : decoded.replace(/^\/+/, ""));
  if (!within(base, path)) return { status: 403 };

  let real: string;
  let realBase: string;
  try {
    real = realpathSync(path);
    realBase = realpathSync(base);
  } catch {
    return { status: 404 };
  }
  // The root directory is not a file. The containment test follows inline, on the value that is
  // returned: CodeQL (js/path-injection) sees a guard only when it stands on that very value.
  if (real === realBase) return { status: 404 };
  const prefix = realBase.endsWith(sep) ? realBase : realBase + sep;
  if (!real.startsWith(prefix)) return { status: 403 };
  return { path: real };
}

/** Serve `root` on an ephemeral loopback port. */
export function serve(root: string): { server: ReturnType<typeof createServer>; port: number } {
  const server = createServer((req, res) => {
    const target = resolveServedPath(root, req.url);
    if ("status" in target) {
      res.writeHead(target.status);
      res.end(target.status === 404 ? "not found" : "refused");
      return;
    }
    try {
      const data = readFileSync(target.path);
      res.writeHead(200);
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  server.listen(0, "127.0.0.1");
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, port };
}
