import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";

/** A throwaway data dir and runs dir, plus a sibling dir that a path escape would hit. */
export interface Sandbox {
  root: string;
  dataDir: string;
  runsDir: string;
  /** Lives next to runsDir: a "../outside" run name resolves into it. */
  outside: string;
  cleanup(): void;
}

export function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "vr-"));
  const dataDir = join(root, "data");
  const runsDir = join(root, "runs");
  const outside = join(root, "outside");
  for (const d of [dataDir, runsDir, outside]) mkdirSync(d, { recursive: true });
  return { root, dataDir, runsDir, outside, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Create `<data>/<bench>/<pool>/tasks/<key>/{workspace,rollouts}` and return the task dir. */
export function addTask(dataDir: string, bench: string, pool: string, key: string): string {
  const dir = join(dataDir, bench, pool, "tasks", key);
  mkdirSync(join(dir, "workspace"), { recursive: true });
  mkdirSync(join(dir, "rollouts", "r01"), { recursive: true });
  return dir;
}

export async function writeXlsx(path: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Sheet1").getCell("A1").value = "hello";
  await wb.xlsx.writeFile(path);
}

/** Run `fn` while collecting everything written to stderr. */
export async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const real = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await fn(), stderr };
  } finally {
    process.stderr.write = real;
  }
}

/** Resolves to "hung" if `p` has not settled after `ms`: a fixed bug must return, not spin. */
export async function within<T>(p: Promise<T>, ms: number): Promise<T | "hung"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<"hung">((r) => {
    timer = setTimeout(() => r("hung"), ms);
  });
  try {
    return await Promise.race([p, hung]);
  } finally {
    clearTimeout(timer);
  }
}
