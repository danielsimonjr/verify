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
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/**
 * Split at the first `sep`, like Python's `str.partition` without the separator.
 * Returns [head, tail]; tail is "" when `sep` is absent. Do not use `split(sep, 2)` for this:
 * the limit truncates the result, so "a__b__c".split("__", 2) is ["a", "b"] and loses "__c".
 */
export function partition(text: string, sep: string): [string, string] {
  const i = text.indexOf(sep);
  return i < 0 ? [text, ""] : [text.slice(0, i), text.slice(i + sep.length)];
}

/** Read a whole file as text. */
export function readText(path: string, encoding: BufferEncoding = "utf8"): string {
  return readFileSync(path, { encoding });
}

/** Write text as UTF-8, creating the parent directories. */
export function writeText(path: string, text: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, text, "utf8");
}

/** Options for renameReplacing and writeFileAtomic. `rename`, `write` and `platform` exist for tests. */
export type RenameOptions = {
  /** How long to keep retrying a transient failure. */
  budgetMs?: number;
  rename?: (from: string, to: string) => void;
  /** Writes the temp file in writeFileAtomic. renameReplacing does not use it. */
  write?: (path: string, data: string | Uint8Array) => void;
  platform?: NodeJS.Platform;
};

const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Rename `from` over `to`.
 *
 * On Windows a rename onto an existing file fails with EPERM, EACCES or EBUSY while another
 * process holds the target open without delete sharing: an antivirus scan of a file that was
 * just written, or the search indexer. The handle closes on its own, so those errors are retried
 * with a growing pause until `budgetMs` runs out. Elsewhere the same codes mean a real permission
 * problem and are thrown at once, as is every other error.
 */
export function renameReplacing(from: string, to: string, opts: RenameOptions = {}): void {
  const { budgetMs = 5000, rename = renameSync, platform = process.platform } = opts;
  const deadline = Date.now() + budgetMs;
  for (let pause = 10; ; pause = Math.min(pause * 2, 250)) {
    try {
      rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (platform !== "win32" || !TRANSIENT_RENAME_CODES.has(code) || Date.now() + pause > deadline) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);
    }
  }
}

/**
 * Write a file through a temp file and a rename, so a crash never leaves a half-written file.
 * A write or rename that fails for good removes the temp file when it can, and throws its own error.
 */
export function writeFileAtomic(path: string, data: string | Uint8Array, opts?: RenameOptions): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  const write = opts?.write ?? writeFileSync;
  try {
    write(tmp, data);
    renameReplacing(tmp, path, opts);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // The temp file cannot be removed, for example because another process holds it open.
      // Report why the write failed, not why the cleanup failed.
    }
    throw e;
  }
}

/** Parse a JSON file. Null when the file is missing or is not valid JSON; use readJsonStrict when either is an error. */
export function readJson<T = unknown>(path: string): T | null {
  try {
    return JSON.parse(readText(path)) as T;
  } catch {
    return null;
  }
}

/** Write `obj` as JSON with a one-space indent, creating the parent directories. */
export function writeJson(path: string, obj: unknown): void {
  writeText(path, JSON.stringify(obj, null, 1));
}

/**
 * Create `path` and its parents. A directory that exists is left alone, because a recursive mkdir
 * of one can still throw: EPERM for a Windows drive root such as "C:\" (Node and Bun), and EEXIST
 * for "." or ".." under Bun on Windows (oven-sh/bun#44576). The path is resolved for the same Bun bug.
 */
export function ensureDir(path: string): void {
  if (isDir(path)) return;
  mkdirSync(resolve(path), { recursive: true });
}

/**
 * Remove a file or a directory tree. A missing path is not an error. A busy file (EBUSY, EPERM) is
 * tried again a few times, because on Windows a killed process can hold its handles for a moment.
 */
export function rmrf(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** True when `path` is a directory, following a symlink. False when it does not exist. */
export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when `path` is a regular file, following a symlink. False when it does not exist. */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** True when `path` itself is a symbolic link. The link is not followed. */
export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Every file under `root`, depth first. Symlinks are skipped unless `followLinks` is set; an unreadable directory is skipped. */
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

/** Copy one file, creating the destination's parent directories. */
export function copyFile(src: string, dst: string): void {
  ensureDir(dirname(dst));
  copyFileSync(src, dst);
}

/** A grader's input holds a symlink. `path` is relative to the directory the check started from. */
export class SymlinkError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`grader input holds a symlink: ${path}`);
    this.name = "SymlinkError";
    this.path = path;
  }
}

/** Throw SymlinkError for the first symlink under directory `dir`, named `<rel>/<entry>`. */
function walkForLinks(dir: string, rel: string): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const entRel = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isSymbolicLink()) throw new SymlinkError(entRel);
    if (ent.isDirectory()) walkForLinks(join(dir, ent.name), entRel);
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
  walkForLinks(root, "");
}

/**
 * Throw SymlinkError for the first symlink on the way from `root` down to `root/rel`, or under it.
 *
 * Each step of `rel` is checked without following it, so a link above a bundle (`out`, or the
 * bundle directory itself) is refused as well as a link inside it. `root` is not checked: it is
 * the caller's own directory. A step that does not exist ends the check, as there is nothing
 * there to follow. The error names the link relative to `root`.
 */
export function assertNoLinkBelow(root: string, rel: string): void {
  let path = root;
  let at = "";
  // Only the platform's separators: on POSIX a backslash is part of a name, and splitting there
  // would make up steps that do not exist and end the check early.
  for (const step of rel.split(sep === "/" ? "/" : /[\\/]/).filter(Boolean)) {
    path = join(path, step);
    at = at ? `${at}/${step}` : step;
    let st;
    try {
      st = lstatSync(path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw e;
    }
    if (st.isSymbolicLink()) throw new SymlinkError(at);
  }
  if (isDir(path)) walkForLinks(path, at);
}

/**
 * Copy one deliverable file for staging. Throw SymlinkError when `src` is a symlink: copyFileSync
 * follows a link, so the staged file would be the host file that the link names. `rel` names the file
 * in the error.
 */
export function copyDeliverable(src: string, dst: string, rel: string = basename(src)): void {
  if (isSymlink(src)) throw new SymlinkError(rel);
  copyFileSync(src, dst);
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

/** Create a directory symlink at `linkPath` that points to `target`, creating the parent directories. */
export function symlinkDir(target: string, linkPath: string): void {
  ensureDir(dirname(linkPath));
  symlinkSync(target, linkPath, "dir");
}

/** Set the permission bits of `path`. */
export function chmod(path: string, mode: number): void {
  chmodSync(path, mode);
}

/** True when `path` exists. A symlink is followed, so a dangling link is false. */
export function exists(path: string): boolean {
  return existsSync(path);
}

/** Size of a file in bytes. Throws when the file does not exist. */
export function fileSize(path: string): number {
  return statSync(path).size;
}

/** Modification time in seconds since the epoch, as Python's os.path.getmtime returns it. */
export function mtime(path: string): number {
  return statSync(path).mtimeMs / 1000;
}

/** The path of `to` relative to `from`, with forward slashes on every platform. */
export function posixRel(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}
