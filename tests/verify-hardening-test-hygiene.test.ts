// A test that creates a temp directory removes it. tests/harness.test.ts made a `vh-cells-*` directory
// in the temp folder on every run and never removed it. This test runs that one test in a child
// `bun test` whose temp folder is a fresh directory, and asserts nothing is left in it.
//
// The suite has one test timeout, the --timeout flag in the `test` script. Bun's own 5 s default
// fails child-process tests on a loaded host: one measured 5.3 s, and the grade test's slow docker
// kill takes 13.7-14.8 s on an idle one. A setDefaultTimeout call sets the bound for its own file
// only: 12 files carried a copy, and the child-process files without one ran at 5 s.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const sandbox = mkdtempSync(join(tmpdir(), "vh-hygiene-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

test("renderCellsTsv test leaves nothing in the temp folder", () => {
  const r = spawnSync(process.execPath, ["test", "tests/harness.test.ts", "-t", "renderCellsTsv"], {
    cwd: REPO,
    encoding: "utf8",
    // os.tmpdir() reads TEMP/TMP on Windows and TMPDIR elsewhere.
    env: { ...process.env, TEMP: sandbox, TMP: sandbox, TMPDIR: sandbox },
  });
  // Bun prints its summary on stderr.
  expect(r.stderr).toMatch(/\b1 pass\b/);
  expect(readdirSync(sandbox)).toEqual([]);
});

// tests/verify-hardening-ci.test.ts checks that CI runs this script and never a bare `bun test`.
test("one test timeout: the test script sets it, and no file overrides it", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };
  expect(pkg.scripts.test).toBe("bun test --timeout 30000");

  // Split, so this file does not match itself. \s* also finds a call with a space or a line break
  // before its parenthesis.
  const call = new RegExp(["\\bsetDefault", "Timeout\\s*\\("].join(""));
  const offenders = readdirSync(join(REPO, "tests"), { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(ts|mjs|js)$/.test(f))
    .filter((f) => call.test(readFileSync(join(REPO, "tests", f), "utf8")));
  expect(offenders).toEqual([]);
});
