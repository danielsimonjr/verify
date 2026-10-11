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
 * The binaries behind pi's `find` (fd) and `grep` (rg) tools.
 *
 * pi downloads each one the first time a tool needs it. It runs the tool calls of one turn at the
 * same time, they share one agent directory, and every download writes to the same archive path: the
 * first extraction deletes the archive and the others fail with "fd is not available and could not
 * be downloaded". Sessions of one task that share a pi home (the driver's elim and fals) fail the
 * same way. The harness provides the binaries once, in one process and in order, before a session
 * starts; it seeds each pi home from that cache, and it does not offer a tool whose binary it could
 * not provide.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as config from "../config.js";
import { run as runProcess, type RunOptions, type RunResult } from "../grade/proc.js";
import { isBun } from "../runtime.js";

/** The pi tools that need a downloaded binary, and the binary each one needs. */
export const PI_TOOL_BINARY: Readonly<Record<string, string>> = { find: "fd", grep: "rg" };

/** The path of each binary asked for, or null for one that could not be provided. */
export type Provided = Record<string, string | null>;
export type Provide = (binaries: readonly string[]) => Promise<Provided>;

export interface PiToolsResult {
  /** The tools to offer, in the order asked: those whose binary was provided, and those that need none. */
  tools: string;
  /** The tools left out, each with the binary it needed. */
  dropped: { tool: string; binary: string }[];
}

export interface PiTools {
  /** Provide the binaries the tools need, once per process, and name the tools that can run. */
  provide(tools: string): Promise<PiToolsResult>;
  /** Copy the cached binaries a pi agent directory lacks into its `bin/`. A no-op for the cache's own directory. */
  seed(agentDir: string): void;
}

const exeSuffix = process.platform === "win32" ? ".exe" : "";

export function makePiTools(opts: { provide: Provide; cacheDir: string }): PiTools {
  const memo = new Map<string, Promise<string | null>>();

  /** One call to the provider for every binary not asked for yet; each binary keeps its own promise. */
  function ask(binaries: readonly string[]): void {
    const fresh = binaries.filter((b) => !memo.has(b));
    if (fresh.length === 0) return;
    const call = (async (): Promise<Provided> => {
      try {
        return await opts.provide(fresh);
      } catch {
        return {};
      }
    })();
    for (const b of fresh) memo.set(b, call.then((got) => got[b] ?? null));
  }

  return {
    async provide(tools: string): Promise<PiToolsResult> {
      const names = tools.split(",").map((t) => t.trim()).filter((t) => t !== "");
      const needed = [...new Set(names.flatMap((t) => (PI_TOOL_BINARY[t] ? [PI_TOOL_BINARY[t]!] : [])))];
      ask(needed);
      const got = new Map<string, string | null>();
      for (const b of needed) got.set(b, await memo.get(b)!);
      const kept: string[] = [];
      const dropped: PiToolsResult["dropped"] = [];
      for (const tool of names) {
        const binary = PI_TOOL_BINARY[tool];
        if (binary !== undefined && got.get(binary) === null) dropped.push({ tool, binary });
        else kept.push(tool);
      }
      return { tools: kept.join(","), dropped };
    },

    seed(agentDir: string): void {
      if (resolve(agentDir) === resolve(dirname(opts.cacheDir))) return;
      for (const binary of Object.values(PI_TOOL_BINARY)) {
        const from = join(opts.cacheDir, binary + exeSuffix);
        const to = join(agentDir, "bin", binary + exeSuffix);
        if (!existsSync(from) || existsSync(to)) continue;
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
      }
    },
  };
}

/** What a pi tool manager prints: one JSON line, tool name to the path pi resolved. */
const MANAGER_SCRIPT = [
  'const { pathToFileURL } = await import("node:url");',
  "const [manager, ...tools] = process.argv.slice(1);",
  "const m = await import(pathToFileURL(manager).href);",
  "const out = {};",
  "for (const t of tools) out[t] = m.getToolPath(t) ?? (await m.ensureTool(t)) ?? null;",
  "console.log(JSON.stringify(out));",
].join("\n");

/** The whole of a download is bounded: pi's own limit is 120 s for the file and 10 s for each request. */
const PROVIDE_TIMEOUT_MS = 300_000;

export interface PiManagerOptions {
  run: (cmd: string, args: string[], opts: RunOptions) => Promise<RunResult>;
  /** pi's `dist/utils/tools-manager.js`. */
  toolsManager: string;
  /** The agent directory the downloads go to: its `bin/` is the cache. */
  agentDir: string;
  /** The command that starts Node. */
  node: string;
}

/**
 * Ask pi's own tool manager for each binary, one after the other in one process, so there is nothing
 * to race. A binary on PATH counts. A helper that fails, times out or prints no JSON provides nothing.
 */
export async function provideWithPi(binaries: readonly string[], o: PiManagerOptions): Promise<Provided> {
  const none: Provided = Object.fromEntries(binaries.map((b) => [b, null]));
  const result = await o.run(o.node, ["--input-type=module", "-e", MANAGER_SCRIPT, o.toolsManager, ...binaries], {
    timeoutMs: PROVIDE_TIMEOUT_MS,
    env: { ...process.env, PI_CODING_AGENT_DIR: o.agentDir, PI_SKIP_VERSION_CHECK: "1" },
  });
  if (result.error !== undefined || result.timedOut || result.status !== 0) return none;
  for (const line of result.stdout.split("\n").reverse()) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed === null || typeof parsed !== "object") continue;
      return Object.fromEntries(binaries.map((b) => [b, typeof parsed[b] === "string" ? (parsed[b] as string) : null]));
    } catch {
      // A line that is not JSON is a notice from the downloader.
    }
  }
  return none;
}

/** The harness's own: pi's tool manager from the pinned install, the cache in the default pi home. */
export const piTools: PiTools = makePiTools({
  cacheDir: join(config.PI_HOME, "bin"),
  provide: (binaries) =>
    provideWithPi(binaries, {
      run: runProcess,
      toolsManager: join(dirname(config.PI_CLI_JS), "..", "utils", "tools-manager.js"),
      agentDir: config.PI_HOME,
      node: isBun ? "node" : process.execPath,
    }),
});
