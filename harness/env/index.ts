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

/** Native execution environments for the adjudication and delivery turns (optional). */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import * as config from "../config.js";
import { exists, isDir, partition, readText } from "../fsutil.js";

const NODE = join(config.HARNESS_DIR, "vendor", "node-v22", "bin");

const DEFAULT_IMAGES: Record<string, string> = {
  sb2: "veriharness-office",
  jb: "veriharness-office",
  wsb: "workspace-bench:local",
  apex: "veriharness-docs",
};

const uid = (): number => process.getuid?.() ?? 0;
const gid = (): number => process.getgid?.() ?? 0;

export function dockerAvailable(): boolean {
  try {
    const r = spawnSync("docker", ["info"], { encoding: "utf8", timeout: 30_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

function imageExists(tag: string): boolean {
  const r = spawnSync("docker", ["image", "inspect", tag], { encoding: "utf8" });
  return r.status === 0;
}

function imageEnv(tag: string): Record<string, string> {
  const p = spawnSync(
    "docker",
    ["image", "inspect", "--format", "{{json .Config.Env}}", tag],
    { encoding: "utf8" },
  );
  if (p.status !== 0) return {};
  try {
    const arr = JSON.parse(p.stdout || "[]") as string[];
    const out: Record<string, string> = {};
    for (const kv of arr) {
      const i = kv.indexOf("=");
      if (i >= 0) out[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return out;
  } catch {
    return {};
  }
}

/** Task name of a WorkBuddy workspace, which is named `<domain>__<task>`; the task may contain "__". */
export function wbTaskName(wsPath: string): string {
  const name = basename(wsPath);
  return partition(name, "__")[1] || name;
}

export function imageFor(ws: string): string | null {
  if (!dockerAvailable()) return null;
  const wsPath = resolve(ws);
  const bench = basename(dirname(wsPath)).replace(/_[^_]+$/, "");
  const override = process.env[`VERIHARNESS_IMAGE_${bench.toUpperCase()}`];
  if (override) return override;
  if (bench === "wb") {
    const taskName = wbTaskName(wsPath);
    const marker = join(config.DATA, "_worlds", "wb", taskName, ".exported");
    if (!exists(marker)) return null;
    const base = readText(marker).trim();
    const derived = "vh/" + base.split("/").pop()!.split(":")[0];
    return imageExists(derived) ? derived : base;
  }
  const image = DEFAULT_IMAGES[bench];
  return image && imageExists(image) ? image : null;
}

export class Native {
  readonly ws: string;
  readonly image: string;
  readonly gcloud: string;
  readonly imageEnv: Record<string, string>;

  constructor(ws: string, image: string) {
    this.ws = resolve(ws);
    this.image = image;
    this.gcloud = join(homedir(), ".config", "gcloud");
    this.imageEnv = imageEnv(image);
  }

  wrap(cmd: string[], env: Record<string, string>): [string[], string] {
    const ws = this.ws;
    const name = `vh_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const docker: string[] = [
      "docker",
      "run",
      "--rm",
      "--name",
      name,
      "--network",
      "host",
      "-u",
      `${uid()}:${gid()}`,
      "-w",
      ws,
      "-e",
      "HOME=/tmp/vh_home",
      "-e",
      `PATH=${NODE}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      "-v",
      `${join(config.HARNESS_DIR, "vendor")}:${join(config.HARNESS_DIR, "vendor")}:ro`,
      "-v",
      `${config.SKILLS_DIR}:${config.SKILLS_DIR}:ro`,
      "-v",
      `${config.PI_HOME}:${config.PI_HOME}`,
      "-v",
      `${ws}:${ws}`,
    ];
    for (const sub of ["spec", "workspace", "rollouts"]) {
      if (isDir(join(ws, sub))) {
        docker.push("-v", `${ws}/${sub}:${ws}/${sub}:ro`);
      }
    }
    const repo = join(ws, "workspace", "repo");
    if (isDir(repo)) {
      docker.push("-v", `${resolve(repo)}:/workspace:ro`);
    }
    const worlds = join(config.DATA, "_worlds");
    if (isDir(worlds)) {
      docker.push("-v", `${worlds}:${worlds}:ro`);
    }
    const browsers = join(homedir(), ".cache", "ms-playwright");
    if (isDir(browsers)) {
      docker.push("-v", `${browsers}:${browsers}:ro`);
      if (!this.imageEnv.PLAYWRIGHT_BROWSERS_PATH) {
        docker.push("-e", `PLAYWRIGHT_BROWSERS_PATH=${browsers}`);
      }
    }
    if (isDir(this.gcloud)) {
      docker.push(
        "-v",
        `${this.gcloud}:${this.gcloud}:ro`,
        "-e",
        `GOOGLE_APPLICATION_CREDENTIALS=${join(this.gcloud, "application_default_credentials.json")}`,
      );
    }
    for (const key of [
      "PI_CODING_AGENT_DIR",
      "PI_SKIP_VERSION_CHECK",
      "GOOGLE_CLOUD_LOCATION",
      "GOOGLE_CLOUD_PROJECT",
      "VERTEX_PROJECT",
      "VERTEX_LOCATION",
      "VERIHARNESS_DATA",
    ]) {
      if (env[key]) docker.push("-e", `${key}=${env[key]}`);
    }
    return [
      [
        ...docker,
        this.image,
        "bash",
        "-c",
        'mkdir -p "$HOME" && exec "$@"',
        "--",
        ...cmd,
      ],
      name,
    ];
  }

  kill(name: string): void {
    Native.kill(name);
  }

  static kill(name: string): void {
    spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" });
  }
}
