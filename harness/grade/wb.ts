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

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HARNESS_DIR, benchRoot, DATA, TMP_DIR } from "../config.js";
import {
  assertNoSymlinks,
  copyTree,
  exists,
  isDir,
  partition,
  readText,
  rmrf,
  SymlinkError,
} from "../fsutil.js";
import type { GradeResult } from "./index.js";

const WB_PY = join(HARNESS_DIR, "grade", "wb.py");
const WB = join(benchRoot(), "benchmarks", "workbuddy", "workbuddy-bench");
const VENV_PY = join(WB, ".venv", "bin", "python");
const DATASETS = join(WB, "datasets");
const WORLDS = join(DATA, "_worlds", "wb");

const DS_NAME: Record<string, string> = {
  code: "wb-bench-code-v1.0",
  office: "wb-bench-office-v1.0",
  web: "wb-bench-web-v1.0",
};
const GRADER = "wb/CompositeVerifier";
const JUDGE_SLUG = "vertex/gemini-3.5-flash";
const JUDGE_DOMAINS = new Set(["office", "web"]);
const DRIVER_TIMEOUT = 4_200_000;

function dotenv(): Record<string, string> {
  const env: Record<string, string> = {};
  const path = join(WB, ".env");
  if (!exists(path)) return env;
  for (const ln of readText(path).split("\n")) {
    const line = ln.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[k] = v;
  }
  return env;
}

function wbEnv(): Record<string, string> {
  return { ...process.env, ...dotenv(), PYTHONPATH: join(WB, "src") };
}

function imageFor(tname: string): string | null {
  const mark = join(WORLDS, tname, ".exported");
  // stdout is null when the docker binary cannot be started; that means "no images", not a crash.
  const listed = spawnSync("docker", ["images", "--format", "{{.Repository}}"], {
    encoding: "utf8",
  });
  const images = (listed.stdout ?? "").split("\n").filter(Boolean);
  if (exists(mark)) {
    const cand = readText(mark).trim();
    if (images.includes(cand)) return cand;
  }
  const low = tname.toLowerCase();
  const imgPrefix = (i: string): string => {
    const end = i.lastIndexOf("__");
    if (end < 0) return i;
    const rest = i.slice(0, end);
    const start = rest.lastIndexOf("__");
    return start < 0 ? rest : rest.slice(0, start);
  };
  const hits = images
    .filter((i) => i.endsWith("__env-main") && low.startsWith(imgPrefix(i)))
    .sort();
  return hits[0] ?? null;
}

const proxy: { url: string | null; proc: ReturnType<typeof spawn> | null; dir: string | null } = {
  url: null,
  proc: null,
  dir: null,
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const addr = s.address();
      s.close(() => resolve(typeof addr === "object" && addr ? addr.port : 0));
    });
    s.on("error", reject);
  });
}

async function healthy(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    const j = (await r.json()) as { status?: string };
    return j.status === "ok";
  } catch {
    return false;
  }
}

function stopProxy(): void {
  const p = proxy.proc;
  if (p && p.exitCode === null) {
    p.kill("SIGTERM");
    try {
      spawnSync("kill", ["-0", String(p.pid)], { timeout: 100 });
    } catch {
      /* wait */
    }
  }
  if (proxy.dir) rmrf(proxy.dir);
  proxy.url = null;
  proxy.proc = null;
  proxy.dir = null;
}

async function proxyUrl(): Promise<string> {
  if (proxy.url && proxy.proc && proxy.proc.exitCode === null) return proxy.url;
  stopProxy();
  const port = await freePort();
  const pdir = mkdtempSync(join(TMP_DIR, "vh_wb_proxy_"));
  const cfg = join(pdir, "proxy.yaml");
  writeFileSync(
    cfg,
    JSON.stringify({
      proxy: {
        host: "0.0.0.0",
        port,
        log_dir: pdir,
        log_enabled: false,
        max_concurrent: 64,
        shared: true,
        routes: [],
      },
    }),
  );
  const env = wbEnv();
  const r = spawnSync(
    VENV_PY,
    [
      "-m",
      "workbuddy_bench.runner.proxy_config",
      "--judge-only",
      "--judge-slug",
      JUDGE_SLUG,
      "--judge-model-config",
      join(WB, "configs", "models", `${JUDGE_SLUG}.yaml`),
      "--shared",
      cfg,
      "--port",
      String(port),
      "--log-dir",
      pdir,
      "--max-concurrent",
      "64",
    ],
    { encoding: "utf8", env, cwd: WB },
  );
  if (r.status !== 0) {
    throw new Error(`proxy_config failed: ${((r.stderr || "") + (r.stdout || "")).slice(-600)}`);
  }
  const logPath = join(pdir, "proxy.log");
  const logFd = openSync(logPath, "a");
  proxy.proc = spawn(
    VENV_PY,
    ["-m", "workbuddy_bench.proxy", "--config", cfg, "--port", String(port), "--log-dir", pdir],
    { env, cwd: WB, stdio: ["ignore", logFd, logFd] },
  );
  proxy.dir = pdir;
  process.on("exit", stopProxy);
  for (let i = 0; i < 60; i++) {
    if (await healthy(port)) {
      proxy.url = `http://host.docker.internal:${port}`;
      return proxy.url;
    }
    if (proxy.proc.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`judge proxy did not come up; see ${pdir}/proxy.log`);
}

export async function grade(
  key: string,
  deliverables: string,
  opts: { keep?: boolean } = {},
): Promise<GradeResult> {
  const keep = opts.keep ?? false;
  // Keys are `<domain>__<task>` and the task name may itself contain "__".
  const [dom, tname] = partition(key, "__");
  if (!dom || !DS_NAME[dom]) {
    return { score: null, error: `unknown domain ${dom}`, grader: GRADER };
  }
  if (!tname) {
    return { score: null, error: `malformed key ${key}: expected <domain>__<task>`, grader: GRADER };
  }
  const taskDir = join(DATASETS, DS_NAME[dom], "tasks", tname);
  if (!exists(join(taskDir, "task.toml"))) {
    return { score: null, error: `no task dir ${taskDir}`, grader: GRADER };
  }
  if (!isDir(deliverables)) {
    return { score: null, error: `no deliverables dir ${deliverables}`, grader: GRADER };
  }
  // Refuse a symlinked bundle before anything else touches Docker. copyTree below checks again.
  try {
    assertNoSymlinks(deliverables);
  } catch (e) {
    if (e instanceof SymlinkError) return { score: null, error: e.message, grader: GRADER };
    throw e;
  }
  const image = imageFor(tname);
  if (!image) {
    return { score: null, error: `no local env image for ${tname}`, grader: GRADER };
  }
  const tmp = mkdtempSync(join(TMP_DIR, "vh_wb_grade_"));
  const cname = `vh_wb_${tmp.split("vh_wb_grade_").pop()}`;
  try {
    copyTree(deliverables, join(tmp, "deliverable"));
    const proxyArg = JUDGE_DOMAINS.has(dom) ? await proxyUrl() : "";
    const cmd = [
      VENV_PY,
      WB_PY,
      "--driver",
      "--domain",
      dom,
      "--task-dir",
      taskDir,
      "--image",
      image,
      "--deliverable",
      join(tmp, "deliverable"),
      "--trial-dir",
      join(tmp, "trial"),
      "--container",
      cname,
      "--proxy-url",
      proxyArg,
    ];
    let p: ReturnType<typeof spawnSync>;
    try {
      p = spawnSync(cmd[0], cmd.slice(1), {
        encoding: "utf8",
        env: wbEnv(),
        cwd: WB,
        timeout: DRIVER_TIMEOUT,
      });
    } catch {
      return {
        score: null,
        error: `driver timed out after ${DRIVER_TIMEOUT}s`,
        grader: GRADER,
      };
    } finally {
      spawnSync("docker", ["rm", "-f", cname], { encoding: "utf8" });
    }
    const stdout = typeof p.stdout === "string" ? p.stdout : p.stdout?.toString() ?? "";
    const stderr = typeof p.stderr === "string" ? p.stderr : p.stderr?.toString() ?? "";
    const lines = stdout.split("\n").filter(Boolean);
    const line = [...lines].reverse().find((ln) => ln.startsWith("VH_RESULT "));
    if (!line) {
      return {
        score: null,
        error: `driver produced no result (rc=${p.status}): ${(stderr + stdout).slice(-800)}`,
        grader: GRADER,
      };
    }
    const res = JSON.parse(line.slice("VH_RESULT ".length)) as GradeResult;
    if (keep) {
      const detail = (res.detail as Record<string, unknown>) || {};
      detail.kept = tmp;
      res.detail = detail;
    }
    return res;
  } finally {
    if (!keep) rmrf(tmp);
  }
}
