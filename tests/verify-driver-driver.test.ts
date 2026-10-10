import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canLinkFiles, linkDir } from "./fixtures/links.ts";
import { canDenyList, denyList } from "./fixtures/perms.ts";
import {
  JAIL_PROBE,
  agentEnv,
  changedFiles,
  completeBundle,
  hasSessionFile,
  lastStopReason,
  lastTurnCut,
  nudgeFor,
  sessionProgress,
  isTransient,
  parseDriverArgv,
  renderSkills,
  resolveSkills,
  rolloutDir,
  validateDelivery,
} from "../harness/driver.ts";

const scratch = mkdtempSync(join(tmpdir(), "vd-driver-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("isTransient", () => {
  test("recognises provider and transport faults", () => {
    expect(isTransient("HTTP 503 Service Unavailable")).toBe(true);
    expect(isTransient('{"error":{"code":429}}')).toBe(true);
    expect(isTransient("status 529.")).toBe(true);
    expect(isTransient("read ECONNRESET")).toBe(true);
    expect(isTransient("model is overloaded")).toBe(true);
  });

  test("a status code inside a larger number or a path is not a fault", () => {
    expect(isTransient("context was 41503 tokens, limit 32000")).toBe(false);
    expect(isTransient("score 0.429 on rubric")).toBe(false);
    expect(isTransient("wrote /tmp/run-1529/out.json")).toBe(false);
    expect(isTransient("TypeError: x is not a function")).toBe(false);
  });
});

describe("hasSessionFile", () => {
  test("a missing directory has no session, instead of throwing", () => {
    expect(hasSessionFile(join(scratch, "does-not-exist"))).toBe(false);
  });

  test("true only for a .jsonl file", () => {
    const dir = join(scratch, "session");
    mkdirSync(dir);
    expect(hasSessionFile(dir)).toBe(false);
    writeFileSync(join(dir, "notes.txt"), "x");
    expect(hasSessionFile(dir)).toBe(false);
    mkdirSync(join(dir, "nested.jsonl"));
    expect(hasSessionFile(dir)).toBe(false);
    writeFileSync(join(dir, "2026.jsonl"), "{}\n");
    expect(hasSessionFile(dir)).toBe(true);
  });
});

/** A workspace with rollout r1 (one file), an empty out/deliverables, and a file that sits OUTSIDE rollouts/. */
function makeWs(name: string): string {
  const ws = join(scratch, name);
  mkdirSync(join(ws, "rollouts", "r1", "deliverables"), { recursive: true });
  mkdirSync(join(ws, "out", "deliverables"), { recursive: true });
  mkdirSync(join(ws, "deliverables"), { recursive: true });
  writeFileSync(join(ws, "rollouts", "r1", "deliverables", "answer.txt"), "r1 answer");
  writeFileSync(join(ws, "deliverables", "outside.txt"), "not a rollout's file");
  return ws;
}

describe("rolloutDir", () => {
  const ws = makeWs("ws-rolloutdir");
  writeFileSync(join(ws, "rollouts", "afile"), "x");

  test("a real rollout directory is accepted", () => {
    expect(rolloutDir(ws, "r1")).toBe(join(ws, "rollouts", "r1"));
  });

  test.each(["", ".", "..", "r1/..", "../rollouts/r1", "r1/deliverables", "nope", "afile"])(
    "%j is not a rollout",
    (base) => {
      expect(rolloutDir(ws, base)).toBeNull();
    },
  );
});

describe("a base that is not a rollout name never reads from outside rollouts/", () => {
  test("completeBundle copies nothing for '..' (it used to restore files from <ws>/deliverables)", () => {
    const ws = makeWs("ws-complete");
    expect(completeBundle(ws, "..")).toEqual([]);
    expect(existsSync(join(ws, "out", "deliverables", "outside.txt"))).toBe(false);
  });

  test("validateDelivery names the problem instead of comparing against the wrong directory", () => {
    const ws = makeWs("ws-validate");
    const verdict = validateDelivery(ws, "..");
    expect(verdict.valid).toBe(false);
    expect(String(verdict.reason)).toContain("rollout");
  });

  test("a genuine base is still completed and validated", () => {
    const ws = makeWs("ws-genuine");
    expect(completeBundle(ws, "r1")).toEqual(["answer.txt"]);
    expect(validateDelivery(ws, "r1")).toMatchObject({ valid: true, n_base: 1, n_out: 1 });
    expect(changedFiles(ws, "r1")).toEqual([]);
  });
});

// The verifier can write out/ inside the jail. The driver completes and checks the bundle on the
// host after the turn, so a link there would turn the view cleanup, the restore and the file
// listings into a delete, a write and a listing of a host directory.
describe("a link under out/ is never followed on the host", () => {
  /** A host directory with a view-named file and a file named like a secret. */
  function hostDir(dir: string): string {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "keep.text.txt"), "a host file whose name looks like a view");
    writeFileSync(join(dir, "secret-name.txt"), "x");
    return dir;
  }

  /** The names in `dir`, sorted. */
  const names = (dir: string) => readdirSync(dir).sort();

  // [where the link is, where the bundle then resolves under the link's target]
  test.each([
    ["out/deliverables", ""],
    ["out", "deliverables"],
  ])("a link at %s: nothing is deleted or written there", (rel, under) => {
    const tag = rel.replace("/", "-");
    const ws = makeWs(`ws-link-${tag}`);
    const target = join(scratch, `host-${tag}`);
    const host = hostDir(join(target, under));
    const at = join(ws, ...rel.split("/"));
    rmSync(at, { recursive: true, force: true });
    linkDir(target, at);
    const before = names(host);
    expect(completeBundle(ws, "r1")).toEqual([]);
    expect(names(host)).toEqual(before);
    expect(changedFiles(ws, "r1")).toEqual([]);
    const verdict = validateDelivery(ws, "r1");
    expect(verdict.valid).toBe(false);
    expect(String(verdict.reason)).toContain(`delivery path: ${rel}`);
    expect(JSON.stringify(verdict)).not.toContain("secret-name");
  });

  test.skipIf(!canLinkFiles)("a file link inside out/deliverables is not written through", () => {
    const ws = makeWs("ws-link-file");
    const host = hostDir(join(scratch, "host-link-file"));
    // Dangling: the restore would create the host file it points at.
    symlinkSync(join(host, "planted.txt"), join(ws, "out", "deliverables", "answer.txt"), "file");
    expect(completeBundle(ws, "r1")).toEqual([]);
    expect(existsSync(join(host, "planted.txt"))).toBe(false);
    expect(String(validateDelivery(ws, "r1").reason)).toContain("delivery path: out/deliverables/answer.txt");
  });
});

// A verifier that can write out/ can also make a directory there that the host cannot list. The
// check then fails, and the driver must refuse the bundle rather than throw and lose the finish step.
describe("a delivery path that cannot be checked", () => {
  test.skipIf(!canDenyList)("is refused, and nothing throws", () => {
    const ws = makeWs("ws-unlistable");
    const locked = join(ws, "out", "deliverables", "locked");
    mkdirSync(locked);
    const undo = denyList(locked);
    try {
      expect(completeBundle(ws, "r1")).toEqual([]);
      expect(changedFiles(ws, "r1")).toEqual([]);
      const verdict = validateDelivery(ws, "r1");
      expect(verdict.valid).toBe(false);
      expect(String(verdict.reason)).toContain("the delivery path cannot be checked");
    } finally {
      undo();
    }
  });
});

describe("parseDriverArgv: numbers that become timers", () => {
  const argsOf = (...flags: string[]) => parseDriverArgv(["ws", ...flags]);

  test("defaults are unchanged", () => {
    expect(argsOf()).toMatchObject({ args: { turnTimeout: 1800, nudgeTimeout: 600, taskTimeout: 3600, env: "jail" } });
  });

  test.each([
    ["--turn-timeout", "abc"],
    ["--turn-timeout", "0"],
    ["--turn-timeout", "-5"],
    ["--turn-timeout", ""],
    ["--turn-timeout", "Infinity"],
    ["--nudge-timeout", "abc"],
    ["--nudge-timeout", "0"],
    ["--task-timeout", "NaN"],
    ["--task-timeout", "-1"],
  ])("%s %j is refused (a NaN budget used to kill the turn after 1 ms)", (flag, value) => {
    const parsed = argsOf(flag, value);
    expect(parsed).toHaveProperty("error");
    expect((parsed as { error: string }).error).toContain(flag.slice(2));
  });

  test("a positive number of seconds, fractional or not, is accepted", () => {
    expect(argsOf("--turn-timeout", "0.5", "--nudge-timeout", "30")).toMatchObject({
      args: { turnTimeout: 0.5, nudgeTimeout: 30 },
    });
  });
});

describe("parseDriverArgv: --env and --skill", () => {
  test.each(["jail", "none", "native", "native-full"])("--env %s is accepted", (env) => {
    expect(parseDriverArgv(["ws", "--env", env])).toMatchObject({ args: { env } });
  });

  test("an unknown --env is refused instead of silently meaning the jail", () => {
    const parsed = parseDriverArgv(["ws", "--env", "nonee"]);
    expect((parsed as { error: string }).error).toContain("--env");
  });

  test("--skill needs a value", () => {
    expect((parseDriverArgv(["ws", "--skill"]) as { error: string }).error).toContain("--skill");
    expect((parseDriverArgv(["ws", "--skill", "--no-skills"]) as { error: string }).error).toContain("--skill");
  });

  test("--skill=NAME is the same option as --skill NAME, as for every other driver option", () => {
    expect(parseDriverArgv(["ws", "--skill=a", "--skill", "b"])).toMatchObject({ args: { skill: ["a", "b"] } });
    expect((parseDriverArgv(["ws", "--skill="]) as { error: string }).error).toContain("--skill");
    expect((parseDriverArgv(["ws", "--skill=--no-skills"]) as { error: string }).error).toContain("--skill");
  });

  test("repeated --skill values are kept in order", () => {
    expect(parseDriverArgv(["ws", "--skill", "a", "--skill", "b"])).toMatchObject({ args: { skill: ["a", "b"] } });
  });
});

describe("resolveSkills", () => {
  test("a bare name is a skill of the harness", () => {
    expect(resolveSkills(["evidence-xlsx"])[0]).toMatch(/harness[\\/]skills[\\/]evidence-xlsx$/);
  });

  test("a path is made absolute, because pi runs with the workspace as its cwd", () => {
    const out = resolveSkills(["rel/skill", join(scratch, "abs", "skill")]);
    expect(out[0]).toBe(resolve("rel/skill"));
    expect(isAbsolute(out[0]!)).toBe(true);
    expect(out[1]).toBe(join(scratch, "abs", "skill"));
  });

  test("a Windows-style path is a path, not a name under the skills directory", () => {
    if (process.platform !== "win32") return; // on POSIX a backslash is an ordinary file-name character
    const winPath = join(scratch, "winskill").replaceAll("/", "\\");
    expect(resolveSkills([winPath])[0]).toBe(winPath);
  });
});

describe("agentEnv: what the verifier session inherits", () => {
  const host = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    GEMINI_API_KEY: "provider-key-the-agent-may-need",
    GOOGLE_CLOUD_PROJECT: "proj",
    VERIHARNESS_DATA: "/data",
    VERIHARNESS_OLLAMA_BASE_URL: "http://127.0.0.1:11434",
    JB_JUDGE_API_KEY: "judge-secret",
    JB_JUDGE_API_BASE: "http://judge",
    JB_JUDGE_MODEL: "m",
    APEX_JUDGE_MODEL: "m",
    APEX_GRADING_DIR: "/bench/apex/grading",
    JUDGE_API_KEY: "judge-secret-2",
    JUDGE_BASE_URL: "http://judge",
    JUDGE_MODEL: "m",
    WB_LITELLM_API_KEY: "wb-secret",
    WB_LITELLM_BASE_URL: "http://wb",
    VERIHARNESS_BENCH_ROOT: "/bench",
    VERIHARNESS_WB_INDEX: "/bench/wb_index.json",
    VERIHARNESS_IMAGE_SB2_GRADER: "img",
  };

  test("grader names are matched in any case, as Windows ignores case in variable names", () => {
    const env = agentEnv({ judge_api_key: "s", Apex_Token: "s", jb_judge_model: "s", wb_litellm_api_key: "s", PATH: "/bin" });
    expect(env.judge_api_key).toBeUndefined();
    expect(env.Apex_Token).toBeUndefined();
    expect(env.jb_judge_model).toBeUndefined();
    expect(env.wb_litellm_api_key).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });

  test("grader credentials and answer-key locations do not reach the session", () => {
    const env = agentEnv(host);
    for (const name of [
      "JB_JUDGE_API_KEY",
      "JB_JUDGE_API_BASE",
      "JB_JUDGE_MODEL",
      "APEX_JUDGE_MODEL",
      "APEX_GRADING_DIR",
      "JUDGE_API_KEY",
      "JUDGE_BASE_URL",
      "JUDGE_MODEL",
      "WB_LITELLM_API_KEY",
      "WB_LITELLM_BASE_URL",
      "VERIHARNESS_BENCH_ROOT",
      "VERIHARNESS_WB_INDEX",
      "VERIHARNESS_IMAGE_SB2_GRADER",
    ]) {
      expect(name in env).toBe(false);
    }
  });

  test("what the session needs is kept, and the caller's environment is not modified", () => {
    const before = { ...host };
    const env = agentEnv(host);
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/u",
      GEMINI_API_KEY: "provider-key-the-agent-may-need",
      GOOGLE_CLOUD_PROJECT: "proj",
      VERIHARNESS_DATA: "/data",
      VERIHARNESS_OLLAMA_BASE_URL: "http://127.0.0.1:11434",
    });
    expect(host).toEqual(before);
  });

  // The jail hides the data root and the repo, but a run-output directory or benchmark checkout that
  // lives elsewhere stays readable unless the jail is told about it. The checkout's path is read here,
  // from the host environment, because the line above removes it from the session's.
  describe("the directories the jail is told to hide", () => {
    const hidden = (env: NodeJS.ProcessEnv): string[] => (env.VERIHARNESS_JAIL_HIDE ?? "").split("\n").filter(Boolean);

    test("lists the run outputs and the benchmark checkout, as absolute paths", () => {
      const env = agentEnv(host, resolve("/work/runs"));
      expect(hidden(env)).toEqual([resolve("/work/runs"), resolve("/bench")]);
      expect(hidden(env).every((p) => isAbsolute(p))).toBe(true);
    });

    test("without a benchmark checkout it lists only the run outputs", () => {
      const { VERIHARNESS_BENCH_ROOT: _unused, ...noBench } = host;
      expect(hidden(agentEnv(noBench, resolve("/work/runs")))).toEqual([resolve("/work/runs")]);
    });

    test("a relative or ~ checkout path is resolved the way the config resolves it", () => {
      const rel = agentEnv({ ...host, VERIHARNESS_BENCH_ROOT: "bench/here" }, resolve("/r"));
      expect(hidden(rel)).toContain(resolve("bench/here"));
      const tilde = agentEnv({ ...host, VERIHARNESS_BENCH_ROOT: "~/bench" }, resolve("/r"));
      expect(hidden(tilde)).toContain(join(homedir(), "bench"));
    });

    test("directories the caller already listed are kept, once", () => {
      const env = agentEnv({ ...host, VERIHARNESS_JAIL_HIDE: `${resolve("/extra")}\n${resolve("/bench")}` }, resolve("/work/runs"));
      expect(hidden(env)).toEqual([resolve("/extra"), resolve("/bench"), resolve("/work/runs")]);
    });
  });
});

describe("JAIL_PROBE: the availability check runs the jail's own command chain", () => {
  // Parsed from the script, not copied from the constant, so the two cannot drift apart unnoticed.
  const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "harness", "scripts", "jail_run.sh"), "utf8").replaceAll("\r\n", "\n");
  const unshareFlags = text.match(/^exec unshare (.+?) \/bin\/bash -s /m)?.[1]?.split(" ");
  const setprivFlags = text.match(/^exec setpriv (.+?) -- "\$@"$/m)?.[1]?.split(" ");

  test("the script has the two lines this test reads", () => {
    expect(unshareFlags).toBeDefined();
    expect(setprivFlags).toBeDefined();
  });

  test("probes unshare with the script's flags, then setpriv with the script's flags, then a no-op", () => {
    expect([...JAIL_PROBE]).toEqual([...unshareFlags!, "setpriv", ...setprivFlags!, "--", "true"]);
  });
});

describe("renderSkills: which skills mount", () => {
  function skill(root: string, name: string, front: string): string {
    const dir = join(root, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\n${front}\n---\nBODY-${name}\n`);
    return dir;
  }
  function wsWith(root: string, files: string[]): string {
    const ws = join(root, "ws");
    for (const f of files) {
      const parts = f.split("/");
      mkdirSync(join(ws, "rollouts", ...parts.slice(0, -1)), { recursive: true });
      writeFileSync(join(ws, "rollouts", ...parts), "x");
    }
    return ws;
  }

  test("applies-to is matched against the files rollouts delivered", () => {
    const root = join(scratch, "skills-a");
    const ws = wsWith(root, ["r1/deliverables/data.xlsx"]);
    const xl = skill(root, "xl", "description: d\napplies-to: *.xlsx");
    const dx = skill(root, "dx", "description: d\napplies-to: *.docx");
    const text = renderSkills([xl, dx], ws, "elim");
    expect(text).toContain("BODY-xl");
    expect(text).not.toContain("BODY-dx");
  });

  test("a trajectory file is not a deliverable, even when the workspace path says 'deliverables'", () => {
    const root = join(scratch, "deliverables", "skills-b");
    const ws = wsWith(root, ["r1/trajectory/agent.json", "r1/deliverables/answer.md"]);
    const json = skill(root, "js", "description: d\napplies-to: *.json");
    const md = skill(root, "md", "description: d\napplies-to: *.md");
    const text = renderSkills([json, md], ws, "elim");
    expect(text).toContain("BODY-md");
    expect(text).not.toContain("BODY-js");
  });

  test("a harness view (.text.txt, .cells.tsv) is not a delivered file", () => {
    const root = join(scratch, "skills-c");
    const ws = wsWith(root, ["r1/deliverables/report.docx", "r1/deliverables/report.docx.text.txt"]);
    const txt = skill(root, "tx", "description: d\napplies-to: *.txt");
    const docx = skill(root, "dx", "description: d\napplies-to: *.docx");
    const text = renderSkills([txt, docx], ws, "elim");
    expect(text).toContain("BODY-dx");
    expect(text).not.toContain("BODY-tx");
  });

  test("a nested deliverable counts, and phase restricts the turn", () => {
    const root = join(scratch, "skills-d");
    const ws = wsWith(root, ["r2/deliverables/sub/dir/deep.pdf"]);
    const pdf = skill(root, "pdf", "description: d\napplies-to: *.pdf\nphase: repair");
    expect(renderSkills([pdf], ws, "repair")).toContain("BODY-pdf");
    expect(renderSkills([pdf], ws, "elim")).toBe("");
  });
});

describe("lastStopReason", () => {
  const line = (role: string, stopReason?: string) =>
    JSON.stringify({ type: "message", message: { role, content: [], ...(stopReason ? { stopReason } : {}) } });

  test("is the stop reason of the last assistant message of the newest session file", () => {
    const dir = join(scratch, "stops");
    mkdirSync(dir);
    writeFileSync(join(dir, "2026-01.jsonl"), [line("assistant", "length")].join("\n") + "\n");
    writeFileSync(join(dir, "2026-02.jsonl"), [line("assistant", "toolUse"), line("toolResult"), line("assistant", "length"), line("toolResult")].join("\n") + "\n");
    expect(lastStopReason(dir)).toBe("length");
    writeFileSync(join(dir, "2026-03.jsonl"), [line("assistant", "stop")].join("\n") + "\n");
    expect(lastStopReason(dir)).toBe("stop");
  });

  test("is empty for a missing directory, no session file, or no assistant message", () => {
    expect(lastStopReason(join(scratch, "nowhere"))).toBe("");
    const dir = join(scratch, "bare");
    mkdirSync(dir);
    expect(lastStopReason(dir)).toBe("");
    writeFileSync(join(dir, "s.jsonl"), line("user") + "\nnot json\n");
    expect(lastStopReason(dir)).toBe("");
  });
});

describe("sessionProgress", () => {
  const msg = (content: unknown[]) => JSON.stringify({ type: "message", message: { role: "assistant", content } });

  test("counts the assistant messages and tool calls and names the last tool", () => {
    const dir = join(scratch, "progress");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "s.jsonl"),
      [msg([{ type: "toolCall", name: "read" }]), JSON.stringify({ type: "message", message: { role: "toolResult" } }), msg([{ type: "toolCall", name: "grep" }, { type: "text", text: "x" }])].join("\n") + "\n",
    );
    expect(sessionProgress(dir)).toMatch(/^2 assistant messages, 2 tool calls \(last: grep\), session \d+ KB$/);
  });

  test("says so when there is no session file yet", () => {
    expect(sessionProgress(join(scratch, "nowhere"))).toBe("no session file yet");
    const dir = join(scratch, "empty-progress");
    mkdirSync(dir);
    expect(sessionProgress(dir)).toBe("no session file yet");
  });
});

describe("a nudge after a cut message", () => {
  const msg = (content: unknown[], stopReason = "stop") =>
    JSON.stringify({ type: "message", message: { role: "assistant", content, stopReason } }) + "\n";

  test("lastTurnCut: a limit stop or thought alone is cut; text or a tool call is not", () => {
    const dir = join(scratch, "cut");
    mkdirSync(dir);
    const at = (name: string, text: string) => {
      writeFileSync(join(dir, name), text);
      return lastTurnCut(dir);
    };
    expect(at("1.jsonl", msg([{ type: "thinking", thinking: "hmm" }]))).toBe(true);
    expect(at("2.jsonl", msg([{ type: "text", text: "part" }], "length"))).toBe(true);
    expect(at("3.jsonl", msg([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "done" }]))).toBe(false);
    expect(at("4.jsonl", msg([{ type: "thinking", thinking: "hmm" }, { type: "toolCall", name: "write" }], "toolUse"))).toBe(false);
    expect(lastTurnCut(join(scratch, "nowhere"))).toBe(false);
  });

  test("nudgeFor adds the warning against more thinking only when the last message was cut", () => {
    const agent = (cut: boolean) => ({ endedCut: () => cut }) as unknown as Parameters<typeof nudgeFor>[0];
    expect(nudgeFor(agent(false), "You have not written x.json yet.")).toBe("You have not written x.json yet.");
    expect(nudgeFor(agent(true), "You have not written x.json yet.")).toBe(
      "Your last message was cut off or held only thinking, so no file was written. Do not think further: you have not written x.json yet.",
    );
  });
});
