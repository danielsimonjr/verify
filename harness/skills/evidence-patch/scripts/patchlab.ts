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

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const JUNK =
  /(^|\/)(__pycache__|\.pytest_cache|node_modules|\.git|\.venv|[^/]+\.egg-info)(\/|$)|\.pyc$/;

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "lab",
  GIT_AUTHOR_EMAIL: "lab@lab",
  GIT_COMMITTER_NAME: "lab",
  GIT_COMMITTER_EMAIL: "lab@lab",
  PYTHONDONTWRITEBYTECODE: "1",
  PYTHONNOUSERSITE: "1",
  PIP_NO_INPUT: "1",
  PYTEST_ADDOPTS: "-p no:randomly -p no:cacheprovider",
};

function sh(cmd: string[], cwd: string) {
  return spawnSync(cmd[0], cmd.slice(1), {
    cwd,
    env: ENV,
    encoding: "utf-8",
  });
}

function splitPatch(text: string) {
  const parts = text.split(/(?=^diff --git )/m);
  const keep: string[] = [];
  const dropped: string[] = [];
  const files: string[] = [];
  for (const p of parts) {
    const m = /^diff --git a\/(.*?) b\/(.*)/m.exec(p);
    if (!m) continue;
    const path = m[2].trim();
    if (
      JUNK.test(path) ||
      (/^Binary files .* differ$/m.test(p) && !p.includes("GIT binary patch"))
    ) {
      dropped.push(path);
      continue;
    }
    keep.push(p);
    files.push(path);
  }
  return { body: keep.join(""), dropped, files };
}

async function buildOne(lab: string, name: string, patch: string) {
  const tree = join(lab, name);
  if (existsSync(tree)) rmSync(tree, { recursive: true, force: true });
  cpSync(join(lab, "_base"), tree, { recursive: true });
  const info = {
    applied: false,
    mode: null as string | null,
    files: [] as string[],
    skipped: [] as string[],
    stderr: "",
  };
  try {
    const text = readFileSync(patch, "utf-8");
    const { body, dropped, files } = splitPatch(text);
    info.skipped = dropped;
    info.files = files;
    if (!body.trim()) {
      info.stderr = "empty patch (nothing replayable)";
      return { name, info };
    }
    const pf = join(lab, `${name}.clean.patch`);
    writeFileSync(pf, body);
    const modes: [string, string[]][] = [
      ["strict", ["git", "apply", "--whitespace=nowarn"]],
      ["recount", ["git", "apply", "--whitespace=nowarn", "--recount"]],
      ["3way", ["git", "apply", "--whitespace=nowarn", "--recount", "-3"]],
      ["fuzz", ["patch", "-p1", "-s", "-f", "--no-backup-if-mismatch", "-i"]],
    ];
    for (const [mode, cmd] of modes) {
      const r = sh([...cmd, pf], tree);
      if (r.status === 0) {
        info.applied = true;
        info.mode = mode;
        break;
      }
      info.stderr = (r.stderr || r.stdout || "").slice(-600);
      sh(["git", "checkout", "-q", "--", "."], tree);
      sh(["git", "clean", "-fdq"], tree);
    }
  } catch (e) {
    info.stderr = String(e);
  }
  return { name, info };
}

async function cmdBuild(a: {
  base: string;
  out: string;
  jobs: number;
  cands: string[];
}) {
  const lab = resolve(a.out);
  const base = join(lab, "_base");
  if (!existsSync(base)) {
    mkdirSync(lab, { recursive: true });
    cpSync(resolve(a.base), base, {
      recursive: true,
      filter: (src) => !src.includes("__pycache__") && !src.endsWith(".git"),
    });
    sh(["git", "init", "-q"], base);
    sh(["git", "config", "gc.auto", "0"], base);
    sh(["git", "add", "-A", "-f"], base);
    sh(["git", "commit", "-qm", "base", "--allow-empty"], base);
  }
  if (a.cands.some((x) => !x.includes("="))) {
    console.error("every candidate is NAME=PATCH");
    process.exit(1);
  }
  const pairs = a.cands.map((x) => x.split("=", 2) as [string, string]);
  const out: Record<string, unknown> = {};
  const chunks: Promise<{ name: string; info: unknown }>[] = [];
  for (const [name, patch] of pairs) chunks.push(buildOne(lab, name, patch));
  const results = await Promise.all(chunks);
  for (const { name, info } of results) {
    out[name] = info;
    const i = info as {
      applied: boolean;
      mode: string | null;
      files: string[];
      skipped: string[];
      stderr: string;
    };
    const tail =
      !i.applied && i.stderr
        ? i.stderr.trim().split("\n").pop() ?? ""
        : "";
    console.log(
      `${name.padEnd(8)} applied=${String(i.applied).padEnd(5)} mode=${i.mode} files=${i.files.length} skipped=${i.skipped.length} ${tail}`,
    );
  }
  writeFileSync(join(lab, "build.json"), JSON.stringify(out, null, 1));
}

function runOne(
  lab: string,
  name: string,
  cmd: string,
  timeout: number,
  tag: string,
) {
  const t0 = Date.now();
  const log = join(lab, `${name}.${tag}.log`);
  let to = false;
  const env = {
    ...ENV,
    PYTHONPATH: [join(lab, name), join(lab, name, "src"), process.env.PYTHONPATH]
      .filter(Boolean)
      .join(process.platform === "win32" ? ";" : ":"),
  };
  const r = spawnSync(cmd, {
    shell: true,
    cwd: join(lab, name),
    env,
    encoding: "utf-8",
    timeout: timeout * 1000,
  });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    to = true;
  }
  const combined = (r.stdout || "") + (r.stderr || "");
  writeFileSync(log, combined);
  const tail = combined.trim().split("\n").slice(-3);
  const rc = to ? -9 : (r.status ?? 1);
  return {
    name,
    res: {
      rc,
      secs: Math.round((Date.now() - t0) / 100) / 10,
      timeout: to,
      tail,
    },
  };
}

async function cmdRun(a: {
  out: string;
  timeout: number;
  jobs: number;
  only?: string;
  tag: string;
  cmd: string[];
}) {
  const lab = resolve(a.out);
  let names = readdirSync(lab).filter((p) => statSync(join(lab, p)).isDirectory()).sort();
  if (a.only) {
    const only = new Set(a.only.split(","));
    names = names.filter((n) => only.has(n) || n === "_base");
  }
  const cmd = a.cmd.join(" ");
  const out: Record<string, unknown> = {};
  const results = names.map((n) => runOne(lab, n, cmd, a.timeout, a.tag));
  for (const { name, res } of results) {
    out[name] = res;
    console.log(
      `${name.padEnd(8)} rc=${String(res.rc).padEnd(4)} ${String(res.secs).padStart(6)}s ${res.timeout ? "TIMEOUT " : ""}| ${res.tail[res.tail.length - 1]?.slice(0, 150) ?? ""}`,
    );
  }
  writeFileSync(join(lab, `run_${a.tag}.json`), JSON.stringify(out, null, 1));
}

const raw = process.argv.slice(2);
const sub = raw[0];
if (sub === "build") {
  const { values, positionals } = parseArgs({
    args: raw.slice(1),
    options: {
      base: { type: "string" },
      out: { type: "string" },
      jobs: { type: "string", default: "4" },
    },
    allowPositionals: true,
  });
  if (!values.base || !values.out) {
    console.error("build requires --base and --out");
    process.exit(1);
  }
  await cmdBuild({
    base: values.base,
    out: values.out,
    jobs: parseInt(values.jobs ?? "4", 10),
    cands: positionals,
  });
} else if (sub === "run") {
  const idx = raw.indexOf("--");
  if (idx < 0 || idx === raw.length - 1) {
    console.error("run: give a command after --");
    process.exit(1);
  }
  const before = raw.slice(1, idx);
  const cmd = raw.slice(idx + 1);
  const { values } = parseArgs({
    args: before,
    options: {
      out: { type: "string" },
      timeout: { type: "string", default: "300" },
      jobs: { type: "string", default: "4" },
      only: { type: "string" },
      tag: { type: "string", default: "t" },
    },
  });
  if (!values.out) {
    console.error("run requires --out");
    process.exit(1);
  }
  await cmdRun({
    out: values.out,
    timeout: parseInt(values.timeout ?? "300", 10),
    jobs: parseInt(values.jobs ?? "4", 10),
    only: values.only,
    tag: values.tag ?? "t",
    cmd,
  });
} else {
  console.error("usage: patchlab.py build|run ...");
  process.exit(2);
}
