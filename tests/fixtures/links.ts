// Links for tests that check how the harness treats a symlink.
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A directory link that needs no privilege: a junction on Windows, a symlink elsewhere. */
export function linkDir(target: string, at: string): void {
  symlinkSync(target, at, "junction");
}

/**
 * True when this process can make a file symlink. On Windows that needs Developer Mode or
 * elevation. test.skipIf needs the answer when the test is declared, so it is probed once here.
 */
export const canLinkFiles: boolean = (() => {
  const dir = mkdtempSync(join(tmpdir(), "vt-link-probe-"));
  try {
    writeFileSync(join(dir, "t"), "x");
    symlinkSync(join(dir, "t"), join(dir, "l"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
