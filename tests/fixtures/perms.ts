// Directories that cannot be listed, for tests that check how the harness treats a read error.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function icacls(...args: string[]): void {
  const r = spawnSync("icacls", args, { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`icacls ${args.join(" ")}: ${r.stderr || r.stdout}`);
}

/**
 * Make `dir` impossible to list, and return the function that undoes it. On POSIX its mode becomes
 * 000; on Windows Everyone (S-1-1-0) is denied the right to list it, which binds an administrator
 * unless SeBackupPrivilege is enabled (see canDenyList). Undo before deleting the directory.
 */
export function denyList(dir: string): () => void {
  if (process.platform === "win32") {
    icacls(dir, "/deny", "*S-1-1-0:(RD)");
    return () => icacls(dir, "/remove:d", "*S-1-1-0");
  }
  chmodSync(dir, 0o000);
  return () => chmodSync(dir, 0o700);
}

/**
 * True when denyList makes readdirSync fail here. Root lists any directory, and so does a Windows
 * process with SeBackupPrivilege enabled: Git Bash enables it for an administrator, and its children
 * inherit it. The answer is false there. test.skipIf needs the answer when the test is declared, so
 * it is probed once here.
 */
export const canDenyList: boolean = (() => {
  const dir = mkdtempSync(join(tmpdir(), "vt-perm-probe-"));
  const sub = join(dir, "sub");
  let undo: (() => void) | undefined;
  try {
    mkdirSync(sub);
    undo = denyList(sub);
    readdirSync(sub);
    return false;
  } catch {
    return undo !== undefined;
  } finally {
    undo?.();
    rmSync(dir, { recursive: true, force: true });
  }
})();
