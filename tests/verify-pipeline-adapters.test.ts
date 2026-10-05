import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as apex from "../harness/materialize/apex.ts";
import * as jb from "../harness/materialize/jb.ts";
import * as sb2 from "../harness/materialize/sb2.ts";
import * as wb from "../harness/materialize/wb.ts";
import * as wsb from "../harness/materialize/wsb.ts";
import type { Task } from "../harness/materialize/base.ts";

let root: string;
const saved: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vp-adapt-"));
  setEnv("VERIHARNESS_BENCH_ROOT", root);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

/** Write files (relative to `base`) from a path -> content map; objects are JSON. */
function tree(base: string, files: Record<string, unknown>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(base, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  }
}

async function collect(it: Iterable<Task> | AsyncIterable<Task>): Promise<Task[]> {
  const out: Task[] = [];
  for await (const t of it) out.push(t);
  return out;
}

const text = (v: string | (() => string)): string => (typeof v === "function" ? v() : v);

// ------------------------------------------------------------------------------------------ sb2
describe("sb2 adapter", () => {
  const SB2 = () => join(root, "benchmarks", "sb2");
  function fixture(id: string): void {
    const key = `Debugging__${id}`;
    tree(SB2(), {
      "official/data/Debugging/dataset.json": [
        { id, instruction: "fix the sheet", spreadsheet_path: `in/${id}.xlsx`, golden_response_path: "SECRET.xlsx", answer_position: "A1" },
      ],
      [`official/data/Debugging/in/${id}.xlsx`]: "input",
      "grades/grades.json": {
        [key]: { flash_high_s01: { accuracy: 1 }, flash_high_s02: { accuracy: 0 }, opus_high_s01: { accuracy: 1 } },
      },
      [`pools/flash_high_s01/${key}/${id}_output.xlsx`]: "o1",
      [`pools/flash_high_s01/${key}/${id}_output.xlsx.cells.tsv`]: "view",
      [`pools/flash_high_s01/${key}/grade.json`]: "ANSWER KEY",
      [`pools/flash_high_s02/${key}/${id}_output.xlsx`]: "o2",
      [`pools/flash_high_s02/${key}/traj/${id}.traj`]: { history: [{ role: "assistant", content: "hi" }] },
    });
  }

  test("yields the task with the spec, the input and each rollout's output", async () => {
    fixture("t1");
    const [t] = await collect(sb2.iterTasks("flash"));
    expect(t!.key).toBe("Debugging__t1");
    expect(t!.spec).toBe("fix the sheet");
    expect(t!.workspace.map(([, name]) => name)).toEqual(["t1.xlsx"]);
    expect(Object.keys(t!.rollouts)).toEqual(["flash_high_s01", "flash_high_s02"]);
    const r1 = t!.rollouts.flash_high_s01!;
    expect(r1.score).toBe(1);
    // ONLY `{tid}_output.*` moves; `grade.json` is the answer key. (The `.cells.tsv` view matches the glob too.)
    expect(r1.files.map(([, n]) => n)).toEqual(["t1_output.xlsx", "t1_output.xlsx.cells.tsv"]);
    expect(r1.traj).toBeNull();
    expect(text(t!.rollouts.flash_high_s02!.traj!)).toContain("<assistant>\nhi");
  });

  test("a task id that contains \"__\" keeps its whole id", async () => {
    fixture("t__1");
    const [t] = await collect(sb2.iterTasks("flash"));
    expect(t!.key).toBe("Debugging__t__1");
    expect(t!.rollouts.flash_high_s01!.files.map(([, n]) => n)).toEqual(["t__1_output.xlsx", "t__1_output.xlsx.cells.tsv"]);
    expect(t!.workspace.map(([, name]) => name)).toEqual(["t__1.xlsx"]);
  });

  test("a corrupt dataset.json is an error that names the file, not a silent skip", async () => {
    fixture("t1");
    writeFileSync(join(SB2(), "official/data/Debugging/dataset.json"), "{not json");
    await expect(collect(sb2.iterTasks("flash"))).rejects.toThrow(/dataset\.json/);
  });

  test("a missing grades.json is an error that names the file", async () => {
    fixture("t1");
    rmSync(join(SB2(), "grades/grades.json"));
    await expect(collect(sb2.iterTasks("flash"))).rejects.toThrow(/grades\.json/);
  });

  test("the workspace file name is the input's base name on any platform", async () => {
    fixture("t1");
    const [t] = await collect(sb2.iterTasks("flash"));
    const [src, name] = t!.workspace[0]!;
    expect(name).not.toMatch(/[\\/]/);
    expect(readFileSync(src, "utf8")).toBe("input");
  });
});

// ------------------------------------------------------------------------------------------- jb
describe("jb adapter", () => {
  const JB = () => join(root, "benchmarks", "jobbench");
  const lbl = "gemini-3-5-flash-s01";
  function fixture(): void {
    tree(JB(), {
      "job-bench-eval/dataset/main/profA/task1/task_folder/TASK_INSTRUCTIONS.txt": "do task one",
      "job-bench-eval/dataset/main/profA/task1/task_folder/input.txt": "in",
      "job-bench-eval/dataset/main/profA/task1/files_required_to_search/f.txt": "f",
      "job-bench-eval/dataset/main/profA/task2/task_folder/TASK_INSTRUCTIONS.txt": "do task two",
      // Not matched by the Python glob `*/task*/task_folder/TASK_INSTRUCTIONS.txt`:
      "job-bench-eval/dataset/main/profA/notatask/task_folder/TASK_INSTRUCTIONS.txt": "no",
      "job-bench-eval/dataset/main/extra/deep/x/task_folder/TASK_INSTRUCTIONS.txt": "no",
      [`results/judge/main/profA/task1/eval_result/eval_${lbl}/gemini-3-flash-preview_judge.json`]: { max_score: 10, total_score: 5 },
      [`results/output/main/profA/task1/model_output/${lbl}/out/report.txt`]: "report",
      [`results/traj/main/profA/task1/model_traj/${lbl}/a.jsonl`]: JSON.stringify({ type: "text", part: { text: "hello" } }),
    });
  }

  test("finds exactly the tasks the Python glob found", async () => {
    fixture();
    const tasks = await collect(jb.iterTasks("flash"));
    expect(tasks.map((t) => t.key)).toEqual(["profA__task1", "profA__task2"]);
    expect(tasks[0]!.spec).toBe("do task one");
    expect(tasks[0]!.trees.map(([, n]) => n)).toEqual(["task_folder", "files_required_to_search"]);
    expect(tasks[1]!.trees.map(([, n]) => n)).toEqual(["task_folder"]);
  });

  test("lists tasks profession by profession, as the Python glob ordered them", async () => {
    // Path-string order would put "a-b" ('-' < '/') before "a"; the glob compared path components.
    tree(JB(), {
      "job-bench-eval/dataset/main/a-b/task1/task_folder/TASK_INSTRUCTIONS.txt": "x",
      "job-bench-eval/dataset/main/a/task1/task_folder/TASK_INSTRUCTIONS.txt": "x",
    });
    expect((await collect(jb.iterTasks("flash"))).map((t) => t.key)).toEqual(["a__task1", "a-b__task1"]);
  });

  test("scores a rollout and lists its delivered files with posix relative names", async () => {
    fixture();
    const [t] = await collect(jb.iterTasks("flash"));
    const r = t!.rollouts[lbl]!;
    expect(r.score).toBe(0.5);
    expect(r.files.map(([, n]) => n)).toEqual(["out/report.txt"]);
    expect(text(r.traj!)).toBe("<assistant>\nhello");
  });
});

// ------------------------------------------------------------------------------------------- wb
describe("wb adapter", () => {
  const WB = () => join(root, "benchmarks", "workbuddy");
  function fixture(extra: Record<string, unknown> = {}, seeds: Record<string, unknown> = {}): void {
    const run = join(root, "runs", "r1");
    const index = {
      "flash/code": {
        taskA: { s1: { dir: run, reward: 0.25 }, s2: { dir: run, reward: 1 }, ...seeds },
      },
    };
    tree(WB(), {
      "wb_index.json": index,
      "workbuddy-bench/datasets/wb-bench-code-v1.0/tasks/taskA/instruction.md": "instr",
      "workbuddy-bench/datasets/wb-bench-code-v1.0/tasks/taskA/environment/Dockerfile": "FROM x",
    });
    tree(run, { "verifier/agent.patch": "diff", "agent/trajectory.json": { steps: [{ source: "agent", step_id: 1, message: "hi" }] }, ...extra });
  }

  test("yields the task, its rollouts and a rendered trajectory", async () => {
    fixture();
    const tasks = await collect(wb.iterTasks("flash"));
    expect(tasks.map((t) => t.key)).toEqual(["code__taskA"]);
    const t = tasks[0]!;
    expect(t.spec).toBe("instr");
    expect(Object.keys(t.rollouts)).toEqual(["s1", "s2"]);
    expect(t.rollouts.s1!.score).toBe(0.25);
    expect(text(t.rollouts.s1!.traj!)).toBe("<agent 1>\nhi");
    expect(text(t.rollouts.s1!.texts[0]![1])).toBe("diff");
  });

  test("an unreadable trajectory.json is an error, not an empty trajectory", async () => {
    fixture();
    writeFileSync(join(root, "runs", "r1", "agent", "trajectory.json"), "{broken");
    const [t] = await collect(wb.iterTasks("flash"));
    expect(() => text(t!.rollouts.s1!.traj!)).toThrow(/trajectory\.json/);
  });

  test("a missing or corrupt index is an error that names the file", async () => {
    fixture();
    writeFileSync(join(WB(), "wb_index.json"), "nope");
    await expect(collect(wb.iterTasks("flash"))).rejects.toThrow(/wb_index\.json/);
  });

  test("a reward that is not a number is an error, not a null score", async () => {
    fixture({}, { s3: { dir: join(root, "runs", "r1"), reward: "high" } });
    await expect(collect(wb.iterTasks("flash"))).rejects.toThrow(/reward/);
  });

  test("a numeric string reward is read as float() reads it", async () => {
    fixture({}, { s3: { dir: join(root, "runs", "r1"), reward: "0.75" } });
    const [t] = await collect(wb.iterTasks("flash"));
    expect(t!.rollouts.s3!.score).toBe(0.75);
  });

  test("a string reward is accepted only in the forms that Python float() accepts", async () => {
    const read = async (reward: string) => {
      fixture({}, { s3: { dir: join(root, "runs", "r1"), reward } });
      const [t] = await collect(wb.iterTasks("flash"));
      return t!.rollouts.s3!.score;
    };
    for (const [text, value] of [[" 0.5 ", 0.5], ["+1", 1], [".5", 0.5], ["1.", 1], ["1e-1", 0.1], ["1_000", 1000], ["-2.5E1", -25]] as const) {
      expect(await read(text)).toBe(value);
    }
    for (const bad of ["0x10", "0b1", "0o7", "1e999", "Infinity", "inf", "nan", "1 2", "--1", "1__0", "_1", "1_", "1e", "e5", ".", "+"]) {
      fixture({}, { s3: { dir: join(root, "runs", "r1"), reward: bad } });
      await expect(collect(wb.iterTasks("flash"))).rejects.toThrow(/is not a number/);
    }
  });

  test("artifact names use forward slashes on every platform", async () => {
    fixture({ "verifier/raw_artifacts/a/b.xlsx": "x", "verifier/raw_artifacts/top.txt": "y" });
    const [t] = await collect(wb.iterTasks("flash"));
    expect(t!.rollouts.s1!.files.map(([, n]) => n)).toEqual(["artifacts/a/b.xlsx", "artifacts/top.txt"]);
  });

  test("seeds are ordered by code unit, not by the locale's collation", async () => {
    const dir = join(root, "runs", "r1");
    fixture({}, { B: { dir, reward: 1 }, a: { dir, reward: 1 } });
    const [t] = await collect(wb.iterTasks("flash"));
    // Python sorted(): "B" < "a" < "s1" < "s2". localeCompare puts "a" and "B" before "s1" in the other order.
    expect(Object.keys(t!.rollouts)).toEqual(["B", "a", "s1", "s2"]);
  });
});

// ------------------------------------------------------------------------------------------ wsb
describe("wsb adapter", () => {
  const WSB = () => join(root, "benchmarks", "wsb_lite", "official", "evaluation");
  const run = "ClaudeCode--Gemini-3.5-Flash--s01";
  function fixture(judge: unknown): void {
    tree(WSB(), {
      "tasks/tA/metadata.json": { task: "do A", output_files: ["a.xlsx"], rubrics: [{}, {}] },
      "tasks/tA/data/in.txt": "in",
      [`output/${run}/.s_done`]: "",
      [`output/${run}/tA/rubrics_judge--claude-opus-4-8.json`]: judge,
      [`output/${run}/tA/output/a.xlsx`]: "x",
      [`output/${run}/tA/agent.json`]: { trace: { executionTrace: [] } },
    });
  }

  test("scores passed rubrics over the rubric count", async () => {
    fixture({ rubrics: [{ index: 0, passed: true }, { index: 1, passed: false }] });
    const [t] = await collect(wsb.iterTasks("flash"));
    expect(t!.key).toBe("tA");
    expect(t!.spec).toBe("do A\n\nRequired output files: a.xlsx");
    expect(t!.rollouts.s01!.score).toBe(0.5);
    expect(t!.rollouts.s01!.files.map(([, n]) => n)).toEqual(["a.xlsx"]);
  });

  test("a rubric with no index does not count as rubric 0", async () => {
    fixture({ rubrics: [{ index: 0, passed: false }, { index: null, passed: true }] });
    const [t] = await collect(wsb.iterTasks("flash"));
    expect(t!.rollouts.s01!.score).toBe(0);
  });

  test("string and float indexes are read as the integers Python's int() reads", async () => {
    fixture({ rubrics: [{ index: "0", passed: true }, { index: 1.0, passed: true }] });
    const [t] = await collect(wsb.iterTasks("flash"));
    expect(t!.rollouts.s01!.score).toBe(1);
  });

  test("a failed judge scores null, not zero", async () => {
    fixture({ judge: { error: "boom" }, rubrics: [{ index: 0, passed: false }, { index: 1, passed: false }] });
    const [t] = await collect(wsb.iterTasks("flash"));
    expect(t!.rollouts.s01!.score).toBeNull();
  });

  test("the task metadata is read again when the bench root changes", async () => {
    fixture({ rubrics: [{ index: 0, passed: true }, { index: 1, passed: true }] });
    expect((await collect(wsb.iterTasks("flash")))[0]!.rollouts.s01!.score).toBe(1);
    // A second root whose task has four rubrics: a cache that outlives the root would still say two.
    const other = mkdtempSync(join(tmpdir(), "vp-adapt2-"));
    try {
      setEnv("VERIHARNESS_BENCH_ROOT", other);
      tree(join(other, "benchmarks", "wsb_lite", "official", "evaluation"), {
        "tasks/tA/metadata.json": { task: "do A", rubrics: [{}, {}, {}, {}] },
        [`output/${run}/.s_done`]: "",
        [`output/${run}/tA/rubrics_judge--claude-opus-4-8.json`]: { rubrics: [{ index: 0, passed: true }, { index: 1, passed: true }] },
      });
      expect((await collect(wsb.iterTasks("flash")))[0]!.rollouts.s01!.score).toBe(0.5);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("a corrupt metadata.json is an error that names the file", async () => {
    fixture({ rubrics: [] });
    writeFileSync(join(WSB(), "tasks/tA/metadata.json"), "{not json");
    await expect(collect(wsb.iterTasks("flash"))).rejects.toThrow(/metadata\.json/);
  });

  test("a corrupt judge file is an error that names the file", async () => {
    fixture("{not json");
    writeFileSync(join(WSB(), `output/${run}/tA/rubrics_judge--claude-opus-4-8.json`), "{not json");
    await expect(collect(wsb.iterTasks("flash"))).rejects.toThrow(/rubrics_judge/);
  });
});

// ------------------------------------------------------------------------------------------ apex
describe("apex adapter", () => {
  const APEX = () => join(root, "benchmarks", "apex");
  const tasks = (domain = "Law") => [{ task_id: "task_abc", domain, prompt: "the prompt" }];
  function fixture(): void {
    tree(APEX(), {
      "dissolve/digest_cache_1_flash/task_abc.json": {
        flash_high_s01: { answer: "A1" },
        flash_high_s02: { answer: "A2" },
        flash_high_s03: { answer: "   " },
      },
      "results/examples/flash_high_s01/output/idx0_x/grades.json": { verifier_results: [{ score: 1 }, { score: 0 }] },
      "results/examples/flash_high_s01/output/idx0_x/initial_messages.json": [{ role: "user", content: "ctx" }],
      "results/examples/flash_high_s01/output/idx0_x/trajectory.json": { messages: [{ role: "assistant", content: "done" }] },
    });
  }

  test("yields the task with answers, archived score and rendered trajectory", async () => {
    fixture();
    const [t] = await collect(apex.iterTasks("flash", tasks()));
    expect(t!.key).toBe("000_Law");
    expect(t!.spec).toBe("the prompt");
    expect(Object.keys(t!.rollouts)).toEqual(["flash_high_s01", "flash_high_s02"]);
    expect(t!.rollouts.flash_high_s01!.score).toBe(0.5);
    expect(t!.rollouts.flash_high_s02!.score).toBe(0);
    expect(text(t!.rollouts.flash_high_s01!.traj!)).toBe("<assistant>\ndone");
    expect(t!.workspaceTexts[0]![0]).toBe("initial_messages.md");
    expect(text(t!.workspaceTexts[0]![1])).toContain("## user\n\nctx");
  });

  test("a task_id that is not one path segment is an error", async () => {
    fixture();
    const bad = [{ task_id: "../x", domain: "Law", prompt: "p" }];
    await expect(collect(apex.iterTasks("flash", bad))).rejects.toThrow(/single path segment/);
  });

  test("a domain the adapter does not know is an error, not a task key built from raw input", async () => {
    fixture();
    await expect(collect(apex.iterTasks("flash", tasks("../../Escape")))).rejects.toThrow(/unknown domain/);
  });

  test("no digest cache is a clear error", async () => {
    mkdirSync(join(APEX(), "dissolve"), { recursive: true });
    await expect(collect(apex.iterTasks("flash", tasks()))).rejects.toThrow(/digest_cache_\*_flash/);
  });

  test("a corrupt initial_messages.json in one run falls through to the next run", async () => {
    fixture();
    tree(APEX(), {
      "results/examples/flash_high_s02/output/idx0_y/grades.json": { verifier_results: [{ score: 1 }] },
      "results/examples/flash_high_s02/output/idx0_y/initial_messages.json": [{ role: "user", content: "second" }],
    });
    writeFileSync(join(APEX(), "results/examples/flash_high_s01/output/idx0_x/initial_messages.json"), "{broken");
    const [t] = await collect(apex.iterTasks("flash", tasks()));
    expect(text(t!.workspaceTexts[0]![1])).toContain("second");
  });

  test("an unreadable trajectory.json is an error, not an empty trajectory", async () => {
    fixture();
    writeFileSync(join(APEX(), "results/examples/flash_high_s01/output/idx0_x/trajectory.json"), "{broken");
    const [t] = await collect(apex.iterTasks("flash", tasks()));
    expect(() => text(t!.rollouts.flash_high_s01!.traj!)).toThrow(/trajectory\.json/);
  });

  test("an idx run directory with a grade but no number is an error, as int() was in the Python", async () => {
    fixture();
    tree(join(APEX(), "results/examples/flash_high_s02/output"), {
      "idxabc_bad/grades.json": { verifier_results: [{ score: 1 }] },
    });
    await expect(collect(apex.iterTasks("flash", tasks()))).rejects.toThrow(/idxabc_bad/);
  });

  test("an idx directory without a grade is not a run and is ignored", async () => {
    fixture();
    tree(join(APEX(), "results/examples/flash_high_s02/output"), { "idxabc_bad/notes.txt": "x" });
    const [t] = await collect(apex.iterTasks("flash", tasks()));
    expect(Object.keys(t!.rollouts)).toEqual(["flash_high_s01", "flash_high_s02"]);
  });

  test("a symlinked run directory is followed, as the Python glob followed it", async () => {
    fixture();
    const real = join(root, "elsewhere", "idx0_real");
    tree(real, { "grades.json": { verifier_results: [{ score: 1 }] } });
    const out = join(APEX(), "results/examples/flash_high_s02/output");
    mkdirSync(out, { recursive: true });
    try {
      // A junction needs no privilege on Windows; Dirent reports it as a link, not a directory.
      symlinkSync(real, join(out, "idx0_link"), process.platform === "win32" ? "junction" : "dir");
    } catch (e) {
      console.log(`SKIP apex symlink case: cannot create a directory symlink here (${(e as Error).message})`);
      return;
    }
    const [t] = await collect(apex.iterTasks("flash", tasks()));
    // s02 has an answer and no other run directory: a score of 1 can only come from the link.
    expect(t!.rollouts.flash_high_s02!.score).toBe(1);
  });

  test("a verifier score that is not a number is an error, not string concatenation", async () => {
    fixture();
    writeFileSync(
      join(APEX(), "results/examples/flash_high_s01/output/idx0_x/grades.json"),
      JSON.stringify({ verifier_results: [{ score: "1" }, { score: 0 }] }),
    );
    await expect(collect(apex.iterTasks("flash", tasks()))).rejects.toThrow(/grades\.json/);
  });

  test("an answer that is not text is an error, not the string [object Object]", async () => {
    fixture();
    writeFileSync(join(APEX(), "dissolve/digest_cache_1_flash/task_abc.json"), JSON.stringify({ flash_high_s01: { answer: { a: 1 } } }));
    await expect(collect(apex.iterTasks("flash", tasks()))).rejects.toThrow(/not text/);
  });
});

describe("apex tasks download", () => {
  const body = JSON.stringify([{ task_id: "t", domain: "Law", prompt: "p" }]);
  const cachePath = () => join(root, "cache", "tasks.json");
  const ok = (b: string, seen: { headers?: Record<string, string>; url?: string } = {}) =>
    (async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.url = url;
      seen.headers = init?.headers;
      return new Response(b, { status: 200 });
    }) as unknown as typeof fetch;

  test("downloads once, validates, and caches atomically", async () => {
    const seen: { headers?: Record<string, string>; url?: string } = {};
    const got = await apex.loadTasks({ fetchImpl: ok(body, seen), cachePath: cachePath(), token: undefined });
    expect(got).toHaveLength(1);
    expect(readFileSync(cachePath(), "utf8")).toBe(body);
    expect(readdirSync(dirname(cachePath()))).toEqual(["tasks.json"]); // no temp file left behind
    expect(seen.url).toContain("mercor/apex-agents");
    expect(seen.headers?.Authorization).toBeUndefined();
  });

  test("an HF token is sent as a bearer token", async () => {
    const seen: { headers?: Record<string, string> } = {};
    await apex.loadTasks({ fetchImpl: ok(body, seen), cachePath: cachePath(), token: "hf_secret" });
    expect(seen.headers?.Authorization).toBe("Bearer hf_secret");
  });

  test("a non-OK status is an error and nothing is cached", async () => {
    const f = (async () => new Response("denied", { status: 401, statusText: "Unauthorized" })) as unknown as typeof fetch;
    await expect(apex.loadTasks({ fetchImpl: f, cachePath: cachePath(), token: undefined })).rejects.toThrow(/401/);
    expect(existsSync(cachePath())).toBe(false);
  });

  test("a 200 body that is not the task list (an HTML error page) is not cached", async () => {
    await expect(apex.loadTasks({ fetchImpl: ok("<html>oops</html>"), cachePath: cachePath(), token: undefined })).rejects.toThrow(
      /APEX tasks/,
    );
    expect(existsSync(cachePath())).toBe(false);
    await expect(apex.loadTasks({ fetchImpl: ok("[]"), cachePath: cachePath(), token: undefined })).rejects.toThrow(/APEX tasks/);
    expect(existsSync(cachePath())).toBe(false);
  });

  test("a corrupt cache file is replaced by a fresh download, not trusted for ever", async () => {
    mkdirSync(dirname(cachePath()), { recursive: true });
    writeFileSync(cachePath(), '[{"task_id": "trunc');
    const got = await apex.loadTasks({ fetchImpl: ok(body), cachePath: cachePath(), token: undefined });
    expect(got).toHaveLength(1);
    expect(readFileSync(cachePath(), "utf8")).toBe(body);
  });

  test("a good cache is used without any request", async () => {
    mkdirSync(dirname(cachePath()), { recursive: true });
    writeFileSync(cachePath(), body);
    const f = (async () => {
      throw new Error("must not fetch");
    }) as unknown as typeof fetch;
    expect(await apex.loadTasks({ fetchImpl: f, cachePath: cachePath(), token: undefined })).toHaveLength(1);
  });
});

describe("apex default task source", () => {
  const tasksBody = JSON.stringify([{ task_id: "t", domain: "Law", prompt: "p" }]);
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("one download serves both pools, a failure is not remembered, and HF_TOKEN is sent", async () => {
    // The cache path comes from the environment, so the real data directory is untouched.
    const cache = join(root, "cache", "tasks.json");
    setEnv("VERIHARNESS_APEX_TASKS", cache);
    setEnv("HF_TOKEN", "hf_from_env");
    setEnv("HUGGING_FACE_HUB_TOKEN", undefined);
    for (const dir of ["digest_cache_1_flash", "digest_cache_1_opus_high"]) {
      mkdirSync(join(root, "benchmarks", "apex", "dissolve", dir), { recursive: true });
    }
    const calls: (string | undefined)[] = [];
    let fail = true;
    globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      calls.push(init?.headers?.Authorization);
      return fail ? new Response("busy", { status: 503, statusText: "Unavailable" }) : new Response(tasksBody, { status: 200 });
    }) as unknown as typeof fetch;

    await expect(collect(apex.iterTasks("flash"))).rejects.toThrow(/503/);
    fail = false;
    await collect(apex.iterTasks("flash"));
    await collect(apex.iterTasks("opus"));
    expect(calls).toEqual(["Bearer hf_from_env", "Bearer hf_from_env"]); // 1 failed + 1 good; opus reused the list
    expect(readFileSync(cache, "utf8")).toBe(tasksBody);
  });
});
