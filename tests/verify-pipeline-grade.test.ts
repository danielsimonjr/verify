import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import JSZip from "jszip";

const RT = process.execPath; // bun under `bun test`
const SCENARIO = join(import.meta.dir, "fixtures", "verify-pipeline", "grade-scenario.ts");

let root: string;
let deliverables: string;
let capture: string;

const TASKS = [
  {
    task_id: "t_law",
    domain: "Law",
    prompt: "Q?",
    world_id: "w1",
    rubric: [
      { verifier_id: "v1", criteria: "c1" },
      { verifier_id: "v2", criteria: "c2" },
    ],
  },
];

function put(rel: string, content: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vp-grade-"));
  deliverables = join(root, "deliverables");
  capture = join(root, "capture");
  put("tasks.json", JSON.stringify(TASKS));
  put("deliverables/answer.md", "the answer");
  put("deliverables/sub/b.txt", "artifact");
  put("deliverables/sheet.xlsx.cells.tsv", "a view");
  mkdirSync(join(root, "grading"));
  mkdirSync(join(root, "tmp"));
  mkdirSync(join(root, "data"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type Out = { status: number | null; json: any; stdout: string; stderr: string };

function scenario(name: string, extra: Record<string, string | undefined> = {}, unsetRoot = false): Out {
  const env: Record<string, string | undefined> = {
    ...process.env,
    VERIHARNESS_BENCH_ROOT: unsetRoot ? undefined : root,
    VERIHARNESS_TMP: join(root, "tmp"),
    VERIHARNESS_DATA: join(root, "data"),
    VERIHARNESS_APEX_TASKS: join(root, "tasks.json"),
    APEX_GRADING_DIR: join(root, "grading"),
    GEMINI_API_KEY: "key-a",
    APEX_JUDGE_MODEL: undefined,
    HF_TOKEN: undefined,
    CAPTURE_DIR: capture,
    SCENARIO_DELIVERABLES: deliverables,
    ...extra,
  };
  const r = spawnSync(RT, [SCENARIO, name], { env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 120_000 });
  const lines = (r.stdout ?? "").trim().split(/\r?\n/);
  let json: unknown = null;
  try {
    json = JSON.parse(lines[lines.length - 1] ?? "");
  } catch {
    /* the caller asserts on stdout/stderr */
  }
  return { status: r.status, json, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const calls = (): { key: string | null; cwd: string; flags: string[] }[] =>
  existsSync(join(capture, "calls.jsonl"))
    ? readFileSync(join(capture, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];

describe("apex grade", () => {
  test("scores the runner's verifier results and runs it in the grading directory", () => {
    const r = scenario("apex-grade", { FAKE_MODE: "ok" });
    expect(r.json.score).toBe(0.5);
    expect(r.json.detail).toMatchObject({ task_id: "t_law", n_verifiers: 2, passed: 1 });
    expect(r.json.rubrics.map((x: any) => x.criteria)).toEqual(["c1", "c2"]);
    const [call] = calls();
    expect(call!.cwd.toLowerCase()).toBe(join(root, "grading").toLowerCase());
    expect(call!.flags).toContain("--final-snapshot");
  });

  test("the final snapshot holds the bundle's artifacts, not answer.md and not the views", async () => {
    scenario("apex-grade", { FAKE_MODE: "ok" });
    const zipFile = readdirSync(capture).find((n) => n.startsWith("final-"))!;
    const zip = await JSZip.loadAsync(readFileSync(join(capture, zipFile)));
    expect(Object.keys(zip.files)).toEqual(["filesystem/sub/b.txt"]);
  });

  test("the event loop keeps running while the runner works (no spawnSync in the async worker)", () => {
    const r = scenario("apex-gap", { FAKE_MODE: "sleep" });
    expect(r.json.result.score).toBe(0.5);
    // spawnSync holds the loop for the whole 800 ms run: the largest gap would be >= 800 ms.
    expect(r.json.maxGap).toBeLessThan(400);
  });

  test("a timeout is an error that says so, and kills the runner's own children", () => {
    const pidFile = join(root, "gc.pid");
    let pid = 0;
    try {
      const r = scenario("apex-grade", { FAKE_MODE: "tree", PID_FILE: pidFile, SCENARIO_TIMEOUT: "2500" });
      expect(r.json.score).toBeNull();
      expect(r.json.error).toMatch(/timed out after/);
      expect(existsSync(pidFile)).toBe(true);
      pid = Number(readFileSync(pidFile, "utf8"));
      const dead = () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      };
      for (let i = 0; i < 50 && !dead(); i++) Bun.sleepSync(100);
      expect(dead()).toBe(true);
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL"); // never leave the probe running
        } catch {
          /* already gone */
        }
      }
    }
  });

  test("a runner that fails reports why: its stderr, not an empty string", () => {
    const r = scenario("apex-grade", { FAKE_MODE: "fail" });
    expect(r.json.score).toBeNull();
    expect(r.json.error).toMatch(/exit 2.*bad credentials/s);
  });

  test("a runner that dies silently still gives a non-empty error", () => {
    const r = scenario("apex-grade", { FAKE_MODE: "silent" });
    expect(r.json.score).toBeNull();
    expect(r.json.error).toBe("apex runner: exit 1");
  });

  test("a runner that writes grades.json and then exits nonzero is not scored", () => {
    const r = scenario("apex-grade", { FAKE_MODE: "done-then-fail" });
    expect(r.json.score).toBeNull();
    expect(r.json.error).toMatch(/exit 3.*crashed during shutdown/s);
  });

  test.skipIf(process.platform === "win32")("a runner that writes grades.json and is then killed is not scored", () => {
    const r = scenario("apex-grade", { FAKE_MODE: "done-then-kill" });
    expect(r.json.score).toBeNull();
    expect(r.json.error).toBe("apex runner: killed by SIGKILL");
  });

  test("the key counter is not wrapped: leave wrapping to the caller", async () => {
    // A pid above 1,000,000 (Linux allows 4,194,304) must seed the same start key as Python's count(pid).
    const { nextKey } = await import("../harness/grade/apex.ts");
    const first = nextKey();
    for (let i = 0; i < 1_000_000; i++) nextKey();
    expect(nextKey()).toBe(first + 1_000_001);
  });

  test("judge keys rotate, starting from the pid rather than always from the first key", () => {
    // Two keys, three keys...: the first key used is keys[pid % n], and the next call takes the next one.
    scenario("apex-two", { FAKE_MODE: "ok", GEMINI_API_KEY: "k0,k1,k2,k3,k4,k5,k6" });
    const used = calls().map((c) => c.key);
    expect(used).toHaveLength(2);
    const keys = ["k0", "k1", "k2", "k3", "k4", "k5", "k6"];
    const first = keys.indexOf(used[0]!);
    expect(keys[(first + 1) % 7]).toBe(used[1]!);
  });

  test("a one-shot process starts at keys[pid % n], not always at the first key", () => {
    const keys = ["k0", "k1", "k2", "k3", "k4", "k5", "k6"];
    // The old counter started at 0 in every process, so it only differs from pid % 7 when that is not 0.
    for (let attempt = 0; attempt < 6; attempt++) {
      rmSync(capture, { recursive: true, force: true });
      const r = scenario("apex-grade", { FAKE_MODE: "ok", GEMINI_API_KEY: keys.join(",") });
      if (r.json.pid % keys.length === 0) continue; // this pid cannot tell the two apart: try another process
      expect(calls()[0]!.key).toBe(keys[r.json.pid % keys.length]!);
      return;
    }
    throw new Error("six processes in a row had a pid divisible by 7");
  });

  test("a key outside the task list is a clear error", () => {
    const r = scenario("apex-grade", { FAKE_MODE: "ok", SCENARIO_KEY: "007_Law" });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/outside the 1 APEX tasks/);
  });
});

describe("apex grade setup", () => {
  test("preflight reports an unset bench root instead of failing the import", () => {
    const r = scenario("import-apex", { APEX_GRADING_DIR: undefined }, true);
    expect(r.status).toBe(0);
    expect(r.json.preflight).toMatch(/VERIHARNESS_BENCH_ROOT/);
  });

  test("the sb2 grader imports without a bench root too", () => {
    const r = scenario("import-sb2", {}, true);
    expect(r.status).toBe(0);
    expect(r.json).toEqual({ imported: true });
  });

  test("a relative APEX_GRADING_DIR becomes absolute, because the runner starts with it as its cwd", () => {
    const r = scenario("apex-dir", { APEX_GRADING_DIR: "rel/grading" });
    expect(r.json.dir).toMatch(/^([A-Za-z]:)?[\\/]/);
    expect(r.json.dir.replace(/\\/g, "/")).toMatch(/rel\/grading$/);
  });
});

describe("sb2 grade (docker and the cell comparison replaced by stand-ins)", () => {
  const SB2 = () => join(root, "benchmarks", "sb2", "official", "data", "Debugging");
  const dockerLog = (): { sub: string; name: string }[] =>
    existsSync(join(capture, "docker.jsonl"))
      ? readFileSync(join(capture, "docker.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
      : [];

  beforeEach(() => {
    mkdirSync(SB2(), { recursive: true });
    writeFileSync(
      join(SB2(), "dataset.json"),
      JSON.stringify([
        { id: "t__1", spreadsheet_path: "in/a.xlsx", golden_response_path: "g.xlsx", answer_position: "A1" },
        { id: "t2", spreadsheet_path: "in/b.xlsx", golden_response_path: "g2.xlsx", answer_position: "B2" },
      ]),
    );
    put("out1/t__1_output.xlsx", "workbook one");
    put("out2/t2_output.xlsx", "workbook two");
    mkdirSync(join(root, "empty"));
  });

  const items = (...rows: [string, string][]) => JSON.stringify(rows.map(([k, d]) => [k, join(root, d), null]));
  const one = (extra: Record<string, string> = {}, key = "Debugging__t__1", dir = "out1") =>
    scenario("sb2-grade", { SB2_ITEMS: items([key, dir]), ...extra });

  test("grades a task whose id contains '__' through recalc and the comparison", () => {
    const r = one();
    expect(r.json.score).toBe(1);
    expect(r.json.detail).toEqual({ id: "t__1", cat: "Debugging" });
    const log = dockerLog().filter((c) => c.sub === "run");
    expect(log).toHaveLength(1);
    expect(log[0]!.name).toMatch(/^vh-sb2-\d+-0-/);
  });

  test("the comparison is started with UTF-8 forced (Python on Windows reads stdin in the console code page)", () => {
    expect(one().json.utf8).toBe("1");
  });

  test("a recalc timeout is reported with its duration, and the container is stopped BY NAME", () => {
    const r = one({ FAKE_DOCKER_MODE: "hang", SB2_RECALC_TIMEOUT: "700" });
    expect(r.status).toBe(1); // grade() throws: score.ts turns that into an error result
    expect(r.stderr).toMatch(/recalc failed \(timed out after 700 ms/);
    const log = dockerLog();
    const run = log.find((c) => c.sub === "run")!;
    const kill = log.find((c) => c.sub === "kill");
    expect(kill).toBeDefined();
    expect(kill!.name).toBe(run.name);
  });

  // The grade CLI exits on the result. A result that came back before a slow `docker kill`
  // finished would end the kill and leave the container running. 11 s is longer than run()'s
  // default stop wait (10 s), so this needs sb2's own wait for the kill.
  test("a recalc timeout waits for a slow docker kill to finish", () => {
    const r = one({ FAKE_DOCKER_MODE: "hang", SB2_RECALC_TIMEOUT: "700", FAKE_KILL_MS: "11000" });
    expect(r.stderr).toMatch(/recalc failed \(timed out after 700 ms/);
    expect(dockerLog().some((c) => c.sub === "kill-done")).toBe(true);
  });

  test("a recalc that reports an error names the marker and the output", () => {
    const r = one({ FAKE_DOCKER_MODE: "bad" });
    expect(r.stderr).toMatch(/recalc failed \(exit 1, \["Error \["\]\).*could not open the workbook/s);
  });

  test("a recalc that exits without a word still says why", () => {
    const r = one({ FAKE_DOCKER_MODE: "silent" });
    expect(r.stderr).toMatch(/recalc failed \(exit 3, \[\]\)/);
  });

  test.each([
    ["empty", /sb2_compare\.py returned invalid JSON: \(nothing printed\)/],
    ["garbage", /sb2_compare\.py returned invalid JSON: this is not json/],
    ["noscore", /returned a result without a score/],
    ["fail", /sb2_compare\.py: exit 1: Traceback.*openpyxl/s],
  ])("a comparison that %s is a null score with a reason", (mode, re) => {
    const r = one({ FAKE_COMPARE_MODE: mode });
    expect(r.json.score).toBeNull();
    expect(r.json.error).toMatch(re);
  });

  test("a comparison that hangs is stopped and says it timed out", () => {
    const r = one({ FAKE_COMPARE_MODE: "hang", SB2_COMPARE_TIMEOUT: "600" });
    expect(r.json.score).toBeNull();
    expect(r.json.error).toBe("sb2_compare.py: timed out after 600 ms");
  });

  test("two batches at once overlap, as the containers score.ts runs at once must", () => {
    const r = scenario("sb2-concurrent", { SB2_ITEMS: items(["Debugging__t__1", "out1"]), DOCKER_SLEEP_MS: "900" });
    expect(r.json.a["Debugging__t__1"].score).toBe(1);
    expect(r.json.b["Debugging__t__1"].score).toBe(1);
    const log = dockerLog();
    const starts = log.filter((c: any) => c.sub === "run").map((c: any) => c.start);
    const ends = log.filter((c: any) => c.sub === "done").map((c: any) => c.end);
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2); // an empty list would make the comparison below true for nothing
    // A blocking grader starts the second container only after the first has finished.
    expect(Math.max(...starts)).toBeLessThan(Math.min(...ends));
  });

  test("a batch gives each key its own outcome", () => {
    const r = scenario("sb2-batch", {
      SB2_ITEMS: items(
        ["Debugging__t__1", "out1"],
        ["Debugging__t2", "empty"],
        ["Debugging__nope", "out1"],
        ["Visualization__x", "out1"],
        ["Debugging", "out1"],
      ),
    });
    const j = r.json;
    expect(j["Debugging__t__1"].score).toBe(1);
    expect(j["Debugging__t2"]).toMatchObject({ score: 0, error: "no t2_output.xlsx in deliverables" });
    expect(j["Debugging__nope"].error).toBe("unknown task id nope");
    expect(j["Visualization__x"].error).toMatch(/category Visualization not wrapped/);
    expect(j["Debugging"].error).toMatch(/bad sb2 key/);
    expect(dockerLog().filter((c) => c.sub === "run")).toHaveLength(1); // ONE container for the whole batch
  });

  test("a failing recalc marks every staged key and nothing else", () => {
    const r = scenario("sb2-batch", {
      SB2_ITEMS: items(["Debugging__t__1", "out1"], ["Debugging__t2", "out2"], ["Debugging__nope", "out1"]),
      FAKE_DOCKER_MODE: "bad",
    });
    expect(r.json["Debugging__t__1"].error).toMatch(/^recalc failed: .*recalc failed \(exit 1/s);
    expect(r.json["Debugging__t2"].error).toMatch(/^recalc failed:/);
    expect(r.json["Debugging__nope"].error).toBe("unknown task id nope");
  });
});
