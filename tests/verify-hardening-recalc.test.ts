// xlsx_recalc.ts took file names with `src.split("/").pop()`. On Windows resolve() returns backslashes,
// so that was the whole path, the copy into the scratch directory failed, and the script could not run
// at all; the out/deliverables test never matched either. It also passed LibreOffice a profile URL of
// the form file://C:\... where _shared/office.ts uses pathToFileURL. A stub soffice (a copy) stands in
// for LibreOffice, as in the render tests.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import ExcelJS from "exceljs";

const REPO = resolve(import.meta.dir, "..");
const SCRIPT = join(REPO, "harness", "skills", "repair-xlsx", "scripts", "xlsx_recalc.ts");
const STUB = join(import.meta.dir, "fixtures", "verify-hardening", "soffice-copy.ts");

// The long name of the temp directory: on the Windows runner it is C:\Users\RUNNER~1\..., the profile
// URL then holds %7E, and a .cmd stub refuses an argument with a percent sign.
const root = mkdtempSync(join(realpathSync.native(tmpdir()), "vh-recalc-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// One launcher per OS, as in verify-skills-render.test.ts: Node cannot spawn a .cmd; Bun can.
const bin = join(root, "bin");
mkdirSync(bin);
if (process.platform === "win32") {
  writeFileSync(join(bin, "soffice.cmd"), `@"%VS_BUN%" "${STUB}" %*\r\n`);
} else {
  const launcher = join(bin, "soffice");
  writeFileSync(launcher, `#!/bin/sh\nexec "$VS_BUN" "${STUB}" "$@"\n`);
  chmodSync(launcher, 0o755);
}
const scratchTmp = join(root, "tmp");
mkdirSync(scratchTmp);

async function workbook(path: string): Promise<void> {
  mkdirSync(join(path, ".."), { recursive: true });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("S");
  ws.getCell("A1").value = 1;
  ws.getCell("B1").value = { formula: "A1+1", result: 2 };
  await wb.xlsx.writeFile(path);
}

function recalc(file: string, ...extra: string[]) {
  return spawnSync(process.execPath, [SCRIPT, file, ...extra], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      VS_BUN: process.execPath,
      TMPDIR: scratchTmp,
      TEMP: scratchTmp,
      TMP: scratchTmp,
    },
    timeout: 60_000,
  });
}

describe("xlsx_recalc with a stub soffice", () => {
  test("a workbook under out/deliverables gets its recalculated copy in out/recalc", async () => {
    const file = join(root, "task1", "out", "deliverables", "book.xlsx");
    await workbook(file);
    const r = recalc(file);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const side = join(root, "task1", "out", "recalc", "book.recalc.xlsx");
    expect(r.stdout).toContain("# formulas still without a cached value after recalc: 0");
    expect(r.stdout).toContain(`# recalculated copy written to ${side}`);
    expect(existsSync(side)).toBe(true);
    // nothing but the workbook went into the bundle
    expect(readdirSync(join(root, "task1", "out", "deliverables"))).toEqual(["book.xlsx"]);
  }, 30_000);

  test("--inplace keeps the previous version beside it, outside the bundle", async () => {
    const file = join(root, "task2", "out", "deliverables", "book.xlsx");
    await workbook(file);
    const r = recalc(file, "--inplace");
    expect(r.status).toBe(0);
    expect(existsSync(join(root, "task2", "out", "recalc", "book.pre-recalc.xlsx"))).toBe(true);
    expect(r.stdout).toContain("# replaced book.xlsx with the recalculated file");
    expect(readdirSync(join(root, "task2", "out", "deliverables"))).toEqual(["book.xlsx"]);
  }, 30_000);

  test("a workbook elsewhere gets its copy next to it", async () => {
    const file = join(root, "task3", "book.xlsx");
    await workbook(file);
    const r = recalc(file);
    expect(r.status).toBe(0);
    expect(existsSync(join(root, "task3", "book.recalc.xlsx"))).toBe(true);
  }, 30_000);

  test("the scratch directory is left behind only as the script's own temp (nothing else is written outside)", async () => {
    // the profile URL must be a real file: URL for LibreOffice; a stub cannot check LibreOffice, so check the text
    const text = (await Bun.file(SCRIPT).text()).replace(/\r\n/g, "\n");
    expect(text).toContain("pathToFileURL");
    expect(text).not.toMatch(/UserInstallation=file:\/\/\$\{/);
  });
});
