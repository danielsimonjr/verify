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
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/**
 * Split at the first `sep`, like Python's `str.partition` without the separator.
 * Returns [head, tail]; tail is "" when `sep` is absent. Do not use `split(sep, 2)` for this:
 * the limit truncates the result, so "a__b__c".split("__", 2) is ["a", "b"] and loses "__c".
 */
export function partition(text: string, sep: string): [string, string] {
  const i = text.indexOf(sep);
  return i < 0 ? [text, ""] : [text.slice(0, i), text.slice(i + sep.length)];
}

export function readText(path: string, encoding: BufferEncoding = "utf8"): string {
  return readFileSync(path, { encoding });
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

export function readJson<T = unknown>(path: string): T | null {
  try {
    return JSON.parse(readText(path)) as T;
  } catch {
    return null;
  }
}

export function writeJson(path: string, obj: unknown): void {
  writeText(path, JSON.stringify(obj, null, 1));
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function rmrf(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function walkFiles(
  root: string,
  opts: { followLinks?: boolean } = {},
): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = join(dir, ent.name);
      if (ent.isSymbolicLink() && !opts.followLinks) {
        continue;
      }
      if (ent.isDirectory() || (opts.followLinks && ent.isSymbolicLink() && isDir(p))) {
        walk(p);
      } else if (ent.isFile() || (opts.followLinks && ent.isSymbolicLink() && isFile(p))) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

export function copyFile(src: string, dst: string): void {
  ensureDir(dirname(dst));
  copyFileSync(src, dst);
}

/** A bundle staged for a grader holds a symlink. `path` is relative to the bundle root. */
export class SymlinkError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`deliverables contain a symlink: ${path}`);
    this.name = "SymlinkError";
    this.path = path;
  }
}

/**
 * Throw SymlinkError for the first symlink at or under `root` (the root itself included).
 *
 * Delivery validation (walkFiles) skips symlinks, so a link is never counted in a bundle. Staging
 * must therefore refuse it: following it would copy whatever file or directory on the host it
 * points at into the grader's input. Links are never followed here.
 */
export function assertNoSymlinks(root: string): void {
  if (isSymlink(root)) throw new SymlinkError(".");
  const walk = (dir: string, rel: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const entRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) throw new SymlinkError(entRel);
      if (ent.isDirectory()) walk(join(dir, ent.name), entRel);
    }
  };
  walk(root, "");
}

/** Copy a bundle for staging. Symlinks are refused (SymlinkError), never dereferenced. */
export function copyTree(src: string, dst: string, filter?: (rel: string) => boolean): void {
  assertNoSymlinks(src);
  ensureDir(dst);
  cpSync(src, dst, {
    recursive: true,
    dereference: false,
    filter: (from) => {
      if (!filter) return true;
      const rel = relative(src, from);
      if (!rel || rel === ".") return true;
      return filter(rel.split(sep).join("/"));
    },
  });
}

export function symlinkDir(target: string, linkPath: string): void {
  ensureDir(dirname(linkPath));
  symlinkSync(target, linkPath, "dir");
}

export function chmod(path: string, mode: number): void {
  chmodSync(path, mode);
}

export function exists(path: string): boolean {
  return existsSync(path);
}

export function fileSize(path: string): number {
  return statSync(path).size;
}

export function mtime(path: string): number {
  return statSync(path).mtimeMs / 1000;
}

export function posixRel(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}
