import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { isMain } from "../harness/runtime.ts";

const scratch = mkdtempSync(join(tmpdir(), "vd-ismain-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Node reports import.meta.url as the REAL path of the entry file, but leaves process.argv[1] as
// the path it was started with. `npm i -g` installs the bin as a symlink, so the two differ.
const real = join(scratch, "real");
mkdirSync(real);
const entry = join(real, "cli.mjs");
writeFileSync(entry, "export {};\n");
writeFileSync(join(real, "other.mjs"), "export {};\n");
const entryUrl = pathToFileURL(entry).href;

// A "junction" is a directory symlink that Windows lets an unprivileged user create. On POSIX Node
// ignores the type and makes an ordinary directory symlink, which is what npm's bin link is.
const linked = join(scratch, "linked");
symlinkSync(real, linked, "junction");

describe("isMain", () => {
  test("is true when argv[1] is the file itself", () => {
    expect(isMain(entryUrl, entry)).toBe(true);
  });

  test("is true when argv[1] reaches the file through a link", () => {
    expect(isMain(entryUrl, join(linked, "cli.mjs"))).toBe(true);
  });

  test("is false for a different file", () => {
    expect(isMain(entryUrl, join(real, "other.mjs"))).toBe(false);
  });

  test("is false when there is no argv[1] or it names nothing", () => {
    expect(isMain(entryUrl, undefined)).toBe(false);
    expect(isMain(entryUrl, "")).toBe(false);
    expect(isMain(entryUrl, join(scratch, "does-not-exist.mjs"))).toBe(false);
  });

  test("is false for a module URL that is not a file", () => {
    expect(isMain("https://example.com/cli.mjs", entry)).toBe(false);
  });

  // Windows paths are case-insensitive and a shell may hand over any case of the drive letter.
  const windowsOnly = process.platform === "win32" ? test : test.skip;
  windowsOnly("ignores the case of a Windows path", () => {
    expect(isMain(entryUrl, entry.toUpperCase())).toBe(true);
    expect(isMain(entryUrl, entry.toLowerCase())).toBe(true);
  });
});
