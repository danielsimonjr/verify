// A test that creates a temp directory removes it. tests/harness.test.ts made a `vh-cells-*` directory
// in the temp folder on every run and never removed it. This test runs that one test in a child
// `bun test` whose temp folder is a fresh directory, and asserts nothing is left in it.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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
