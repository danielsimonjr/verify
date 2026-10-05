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
 * The copy of a session that Claude Code saves in its own configuration directory.
 *
 * `--resume` reads that copy, so it must stay there while a task runs. When the task ends the harness
 * moves it next to the task's other records, so verifier sessions do not fill the user's own session
 * history. The configuration directory also holds the user's real sessions, and on a host that runs
 * several agents it holds theirs: this module touches one kind of file only, `<uuid>.jsonl` for a UUID
 * the caller names, and removes one kind of directory only, an empty project directory. It never
 * deletes recursively and never matches a pattern.
 */

import { copyFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ensureDir, isFile } from "../fsutil.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `CLAUDE_CONFIG_DIR` when set, else `~/.claude`: where Claude Code keeps its settings and sessions. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CLAUDE_CONFIG_DIR;
  const dir = raw !== undefined && raw !== "" ? raw : join(homedir(), ".claude");
  return resolve(dir.startsWith("~") ? join(homedir(), dir.slice(1)) : dir);
}

function projectDirs(configDir: string): string[] {
  const projects = join(configDir, "projects");
  try {
    return readdirSync(projects, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(projects, e.name));
  } catch {
    return [];
  }
}

/**
 * The saved copy of session `uuid`: `<configDir>/projects/<project>/<uuid>.jsonl`. Claude Code derives
 * the project directory's name from the working directory in a way this code does not reproduce, so it
 * looks in each. Null when there is none, and for anything that is not a UUID.
 */
export function findPersisted(configDir: string, uuid: string): string | null {
  if (!UUID.test(uuid)) return null;
  for (const dir of projectDirs(configDir)) {
    const candidate = join(dir, `${uuid}.jsonl`);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (e) {
    // Across volumes (the configuration directory on one drive, the workspace on another) a rename fails.
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

/**
 * Move the saved copy of session `uuid` to `<destDir>/<uuid>.jsonl` and remove its project directory if
 * that is now empty. Returns the new path, or null when no copy was found. Nothing else is moved:
 * a sibling `<uuid>/` directory (large tool results) and other sessions' files stay where they are.
 */
export function movePersisted(configDir: string, uuid: string, destDir: string): string | null {
  const from = findPersisted(configDir, uuid);
  if (from === null) return null;
  ensureDir(destDir);
  const to = join(destDir, `${uuid}.jsonl`);
  moveFile(from, to);
  const projectDir = resolve(from, "..");
  try {
    // rmdir fails on a directory that has anything in it; that is the check this relies on.
    if (statSync(projectDir).isDirectory()) rmdirSync(projectDir);
  } catch {
    /* not empty, or already gone */
  }
  return to;
}
