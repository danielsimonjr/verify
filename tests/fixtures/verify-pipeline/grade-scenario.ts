// Runs one grader scenario in its own process, so the environment it reads at import time is the
// test's own. Prints one JSON line. Test fixture only; started by tests/verify-pipeline-grade.test.ts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const grade = join(here, "..", "..", "..", "harness", "grade");
const scenario = process.argv[2];
const env = process.env;

const load = (file: string) => import(pathToFileURL(join(grade, file)).href);

const out = (v: unknown): void => {
  process.stdout.write(JSON.stringify(v) + "\n");
};

async function apexGrade(timeout?: number) {
  const apex = await load("apex.ts");
  return apex.grade(env.SCENARIO_KEY ?? "000_Law", env.SCENARIO_DELIVERABLES!, {
    command: [process.execPath, join(here, "fake-apex-runner.mjs")],
    timeout,
  });
}

if (scenario === "apex-grade") {
  out({ ...(await apexGrade(Number(env.SCENARIO_TIMEOUT ?? 30_000))), pid: process.pid });
} else if (scenario === "apex-gap") {
  // The runner (FAKE_MODE=handshake) writes READY_FILE and waits for GO_FILE, which this loop writes
  // only once READY_FILE exists. A grade that blocked the loop while the runner ran, as spawnSync
  // did, could not answer until the runner gave up.
  const iv = setInterval(() => existsSync(env.READY_FILE!) && writeFileSync(env.GO_FILE!, ""), 10);
  const result = await apexGrade();
  clearInterval(iv);
  out({ saw: readFileSync(env.SAW_FILE!, "utf8"), result });
} else if (scenario === "apex-two") {
  const a = await apexGrade();
  const b = await apexGrade();
  out({ a, b });
} else if (scenario === "import-apex") {
  const apex = await load("apex.ts");
  out({ preflight: apex.preflight() });
} else if (scenario === "import-sb2") {
  await load("sb2.ts");
  out({ imported: true });
} else if (scenario === "apex-dir") {
  const apex = await load("apex.ts");
  out({ dir: apex.gradingDir() });
} else if (scenario === "sb2-grade" || scenario === "sb2-batch" || scenario === "sb2-concurrent") {
  const sb2 = await load("sb2.ts");
  const opts = {
    dockerCmd: [process.execPath, join(here, "fake-docker.mjs")],
    compareCmd: [process.execPath, join(here, "fake-compare.mjs")],
    recalcTimeoutMs: Number(env.SB2_RECALC_TIMEOUT ?? 60_000),
    compareTimeoutMs: Number(env.SB2_COMPARE_TIMEOUT ?? 60_000),
  };
  const items = JSON.parse(env.SB2_ITEMS ?? "[]") as [string, string, string | null][];
  if (scenario === "sb2-grade") {
    out(await sb2.grade(items[0]![0], items[0]![1], opts));
  } else if (scenario === "sb2-batch") {
    out(await sb2.gradeBatch(items, 8, opts));
  } else {
    // Two batches at once, as score.ts runs containers: with a blocking grader they take twice as long.
    const t0 = Date.now();
    const [a, b] = await Promise.all([sb2.gradeBatch(items, 8, opts), sb2.gradeBatch(items, 8, opts)]);
    out({ elapsed: Date.now() - t0, a, b });
  }
} else {
  throw new Error(`unknown scenario ${scenario}`);
}
