// Shared by the verify-core tests that exercise a grader module.
//
// Each grader call runs in a subprocess (run-grader.ts) with its own environment: the stand-in
// bench checkout, a scratch staging directory, and a PATH that names one existing, EMPTY directory
// so no `docker` or `python3` can start. A grader must stop before it reaches a container or a
// judge; if a regression lets it through, the spawn fails with ENOENT instead of contacting a
// real daemon.
//
// The PATH is an empty directory and not an empty string on purpose: on Linux CI an empty PATH did
// NOT stop `spawnSync("docker")` from finding the runner's docker (the empty value is treated as
// unset), while a PATH naming a directory with nothing in it has no such fallback.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const BENCH_ROOT = resolve(import.meta.dir, "bench");
const RUN_GRADER = resolve(import.meta.dir, "run-grader.ts");

/** The environment for a grader subprocess; PATH (any case) is one empty directory inside `stageDir`. */
export function guardedEnv(stageDir: string): NodeJS.ProcessEnv {
  const emptyBin = join(stageDir, "empty-bin");
  mkdirSync(emptyBin, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VERIHARNESS_BENCH_ROOT: BENCH_ROOT,
    VERIHARNESS_TMP: stageDir,
  };
  for (const k of Object.keys(env)) if (k.toLowerCase() === "path") env[k] = emptyBin;
  return env;
}

/** Call `<bench>.<fn>(...args)` in a guarded subprocess and return its JSON result. */
export function runGrader(
  scratch: string,
  bench: string,
  fn: string,
  args: unknown[],
): Record<string, any> {
  const stageDir = join(scratch, "stage");
  mkdirSync(stageDir, { recursive: true });
  const r = spawnSync(process.execPath, [RUN_GRADER, bench, fn, JSON.stringify(args)], {
    encoding: "utf8",
    env: guardedEnv(stageDir),
  });
  const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) {
    throw new Error(`grader subprocess gave no result (status ${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
  return JSON.parse(line.slice("RESULT ".length));
}
