import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SESSION_MARKERS } from "../harness/claude/index.ts";
import { SKILLS_DIR } from "../harness/config.ts";
import { parseDriverArgv } from "../harness/driver.ts";
import { ELIM, happyRules, makeRig, writeRule, type Call, type Rig, type Rule } from "./fixtures/verify-claude-code/rig.ts";

let rig: Rig;
beforeEach(() => {
  rig = makeRig();
});
afterEach(() => rig.cleanup());

const MODEL = "claude-haiku-4-5-20251001";
const ARGS = ["--provider", "claude-code", "--model", MODEL, "--env", "none", "--no-skills"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The value after `flag` in a recorded argv, or undefined. */
function after(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** The calls whose prompt (stdin) contains `text`, in order. */
function callsWith(text: string): Call[] {
  return rig.calls().filter((c) => c.stdin.includes(text));
}

/** The session id of a call, and whether it started or resumed it. */
function sessionOf(call: Call): { id: string; mode: "new" | "resume" } {
  const fresh = after(call.argv, "--session-id");
  if (fresh !== undefined) return { id: fresh, mode: "new" };
  return { id: after(call.argv, "--resume")!, mode: "resume" };
}

/** `rules`, each with `extra` added to what its call does (here: what the init event reports). */
function withInit(rules: Rule[], extra: Record<string, unknown>): Rule[] {
  return rules.map((r) => ({ ...r, action: { ...r.action, ...extra } }));
}

/** What a run wrote to stderr, with the exit code. */
async function runCapturingStderr(argv: string[], deps = {}): Promise<{ code: number; stderr: string }> {
  const real = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await rig.run(argv, {}, deps), stderr };
  } finally {
    process.stderr.write = real;
  }
}

describe("a whole task through the stub claude", () => {
  test("every phase runs, the records land, and the exit code is 0", async () => {
    rig.script(happyRules(rig.ws));
    const code = await rig.run(ARGS);
    expect(code).toBe(0);
    expect(existsSync(join(rig.ws, "elim", "ledger_elim.json"))).toBe(true);
    expect(existsSync(join(rig.ws, "fals", "ledger_fals.json"))).toBe(true);
    const finish = JSON.parse(readFileSync(join(rig.ws, "finish.json"), "utf8"));
    expect(finish.base).toBe("r1");
    expect(finish.repair.written).toBe(true);
    expect(finish.repair.valid).toBe(true);
    // elim, fals, adjudication, repair: four turns, no nudge.
    expect(rig.calls()).toHaveLength(4);
  });

  test("a pick-only contract stops after the adjudication and enables no editing tool", async () => {
    rig.script(happyRules(rig.ws));
    expect(await rig.run([...ARGS, "--contract", "pick-only"])).toBe(0);
    const calls = rig.calls();
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(after(call.argv, "--tools")).toBe("Read,Bash,Grep,Glob");
    expect(callsWith("# Repair")).toHaveLength(0);
  });
});

describe("the command line of every turn", () => {
  test("the prompt is on stdin, never on the command line", async () => {
    rig.script(happyRules(rig.ws));
    await rig.run(ARGS);
    for (const call of rig.calls()) {
      expect(call.stdin.length).toBeGreaterThan(1000);
      expect(call.argv.some((a) => a.length > 400)).toBe(false);
      expect(call.argv.join(" ")).not.toContain("# Discrimination");
    }
    expect(callsWith("# Discrimination")).toHaveLength(1);
  });

  test("the isolation flags, the model and the permission mode are on every call", async () => {
    rig.script(happyRules(rig.ws));
    await rig.run(ARGS);
    const charter = join(rig.ws, "session", "charter.md");
    for (const { argv } of rig.calls()) {
      expect(argv[0]).toBe("-p");
      expect(after(argv, "--output-format")).toBe("stream-json");
      expect(argv).toContain("--verbose");
      expect(after(argv, "--model")).toBe(MODEL);
      expect(after(argv, "--setting-sources")).toBe("");
      expect(argv).toContain("--strict-mcp-config");
      expect(JSON.parse(after(argv, "--settings")!)).toEqual({
        disableAllHooks: true,
        autoMemoryEnabled: false,
        autoContinueAtUsageLimit: false,
      });
      expect(after(argv, "--tools")).toBe("Read,Bash,Grep,Glob,Edit,Write");
      expect(after(argv, "--permission-mode")).toBe("bypassPermissions");
      expect(after(argv, "--append-system-prompt-file")).toBe(charter);
    }
    expect(readFileSync(charter, "utf8")).toMatch(/^You are a verifier/);
  });

  test("auto-memory is off in the environment of every call", async () => {
    rig.script(happyRules(rig.ws));
    await rig.run(ARGS, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" });
    expect(rig.calls().length).toBeGreaterThan(0);
    for (const { env } of rig.calls()) expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
  });

  test("the skill library is added with --add-dir, and not when there are no skills", async () => {
    rig.script(happyRules(rig.ws));
    await rig.run(ARGS);
    expect(rig.calls().every((c) => !c.argv.includes("--add-dir"))).toBe(true);

    const second = makeRig();
    try {
      second.script(happyRules(second.ws));
      await second.run(ARGS.filter((a) => a !== "--no-skills"));
      for (const { argv } of second.calls()) expect(after(argv, "--add-dir")).toBe(SKILLS_DIR);
    } finally {
      second.cleanup();
    }
  });
});

describe("sessions and transcripts", () => {
  test("each investigation and the adjudication get their own session; the repair resumes the adjudication", async () => {
    rig.script(happyRules(rig.ws));
    await rig.run(ARGS);
    const [elim, fals, adjudicate, repair] = [
      callsWith("# Discrimination")[0]!,
      callsWith("# Falsification")[0]!,
      callsWith("# Adjudication")[0]!,
      callsWith("# Repair")[0]!,
    ].map(sessionOf);
    for (const s of [elim!, fals!, adjudicate!]) {
      expect(s.mode).toBe("new");
      expect(s.id).toMatch(UUID);
    }
    expect(new Set([elim!.id, fals!.id, adjudicate!.id]).size).toBe(3);
    expect(repair).toEqual({ id: adjudicate!.id, mode: "resume" });
  });

  test("the stream of each turn is kept in session/<name>/<uuid>.jsonl", async () => {
    rig.script(happyRules(rig.ws));
    await rig.run(ARGS);
    const id = sessionOf(callsWith("# Discrimination")[0]!).id;
    const text = readFileSync(join(rig.ws, "session", "elim", `${id}.jsonl`), "utf8");
    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"type":"result"');
    // The adjudication transcript holds both its turn and the repair turn.
    const adj = sessionOf(callsWith("# Adjudication")[0]!).id;
    const lines = readFileSync(join(rig.ws, "session", "adjudicate", `${adj}.jsonl`), "utf8")
      .split("\n")
      .filter((l) => l.includes('"type":"result"'));
    expect(lines).toHaveLength(2);
  });

  test("a nudge continues the same session, and its record counts", async () => {
    rig.script([
      { match: "# Discrimination", times: 1, action: {} },
      writeRule(rig.ws, "ledger_elim.json yet", "ledger_elim.json", ELIM),
      ...happyRules(rig.ws),
    ]);
    expect(await rig.run(ARGS)).toBe(0);
    const [first, nudge] = [callsWith("# Discrimination")[0]!, callsWith("ledger_elim.json yet")[0]!];
    expect(sessionOf(first).mode).toBe("new");
    expect(sessionOf(nudge)).toEqual({ id: sessionOf(first).id, mode: "resume" });
    expect(rig.calls()).toHaveLength(5);
  });

  test("a record the verifier did not write itself is not accepted", async () => {
    // The turn leaves ledger_elim.json on disk but makes no tool call that wrote it.
    const rule = writeRule(rig.ws, "# Discrimination", "ledger_elim.json", ELIM);
    (rule.action as { toolUses?: unknown }).toolUses = [];
    rig.script([rule, ...happyRules(rig.ws).filter((r) => r.match !== "# Discrimination")]);
    expect(await rig.run(ARGS)).toBe(1);
    expect(rig.log()).toContain("no ledger_elim.json of its own after nudge");
  });
});

describe("the saved copies in Claude Code's configuration directory", () => {
  test("each copy this task created is moved to session/<name>/claude-persisted/", async () => {
    rig.script(happyRules(rig.ws));
    await rig.run(ARGS);
    for (const [name, text] of [
      ["elim", "# Discrimination"],
      ["fals", "# Falsification"],
      ["adjudicate", "# Adjudication"],
    ] as const) {
      const id = sessionOf(callsWith(text)[0]!).id;
      expect(existsSync(join(rig.ws, "session", name, "claude-persisted", `${id}.jsonl`))).toBe(true);
    }
    // Nothing is left behind, and the empty project directory is gone.
    expect(readdirSync(join(rig.configDir, "projects"))).toEqual([]);
  });

  test("only this task's own files are touched: other sessions and a non-empty project directory stay", async () => {
    // The stub names the project directory after its working directory, which is the real path of the workspace.
    const project = realpathSync(rig.ws).replace(/[^A-Za-z0-9]/g, "-");
    const mine = join(rig.configDir, "projects", project);
    const other = join(rig.configDir, "projects", "someone-elses-project");
    mkdirSync(mine, { recursive: true });
    mkdirSync(other, { recursive: true });
    const strangers = [
      join(mine, "11111111-1111-4111-8111-111111111111.jsonl"),
      join(mine, "notes.txt"),
      join(other, "22222222-2222-4222-8222-222222222222.jsonl"),
    ];
    for (const f of strangers) writeFileSync(f, "theirs");
    rig.script(happyRules(rig.ws));
    expect(await rig.run(ARGS)).toBe(0);
    for (const f of strangers) expect(readFileSync(f, "utf8")).toBe("theirs");
    // This task's own copies left the shared project directory; the directory stays because it is not empty.
    expect(readdirSync(mine).sort()).toEqual(["11111111-1111-4111-8111-111111111111.jsonl", "notes.txt"]);
  });

  test("the copies are moved when the task fails, too", async () => {
    rig.script([{ match: "# Discrimination", action: { result: { is_error: true, text: "Invalid API key" }, exit: 1 } }, ...happyRules(rig.ws)]);
    expect(await rig.run(ARGS)).toBe(1);
    expect(readdirSync(join(rig.configDir, "projects"))).toEqual([]);
    const id = sessionOf(callsWith("# Discrimination")[0]!).id;
    expect(existsSync(join(rig.ws, "session", "elim", "claude-persisted", `${id}.jsonl`))).toBe(true);
  });
});

describe("the environment of the verifier", () => {
  const MARKERS: Record<string, string> = Object.fromEntries(SESSION_MARKERS.map((n) => [n, "marker-value"]));
  const KEPT = {
    ANTHROPIC_API_KEY: "sk-ant-fake-key-for-test",
    ANTHROPIC_AUTH_TOKEN: "fake-auth-token",
    CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth-token",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "12345",
  };

  test("session markers are removed, and the login and the provider choice are kept", async () => {
    rig.script(happyRules(rig.ws));
    expect(await rig.run(ARGS, { ...MARKERS, ...KEPT })).toBe(0);
    for (const { env } of rig.calls()) {
      for (const name of SESSION_MARKERS) expect(env[name]).toBeUndefined();
      for (const [name, value] of Object.entries(KEPT)) expect(env[name]).toBe(value);
      expect(env.CLAUDE_CONFIG_DIR).toBe(rig.configDir);
    }
  });

  test("a marker is removed whatever its case (Windows ignores case in names)", async () => {
    rig.script(happyRules(rig.ws));
    // On Windows process.env is case-insensitive, so the name is stored once; on Linux both spellings exist.
    expect(await rig.run(ARGS, { claudecode: "1", Claude_Code_Session_Id: "x" })).toBe(0);
    for (const { env } of rig.calls()) {
      const names = Object.keys(env).map((n) => n.toUpperCase());
      expect(names).not.toContain("CLAUDECODE");
      expect(names).not.toContain("CLAUDE_CODE_SESSION_ID");
    }
  });

  test("grader-only variables are removed as for every provider", async () => {
    rig.script(happyRules(rig.ws));
    await rig.run(ARGS, { JUDGE_API_KEY: "grader-secret", APEX_TOKEN: "grader-secret" });
    for (const { env } of rig.calls()) {
      expect(env.JUDGE_API_KEY).toBeUndefined();
      expect(env.APEX_TOKEN).toBeUndefined();
    }
  });

  test("no credential reaches driver.log", async () => {
    rig.script(happyRules(rig.ws));
    await rig.run(ARGS, KEPT);
    const log = rig.log();
    for (const value of Object.values(KEPT).filter((v) => v.length > 3)) expect(log).not.toContain(value);
  });
});

describe("what the log says about the session", () => {
  test("one warning per task says that the answer keys are not protected", async () => {
    rig.script(happyRules(rig.ws));
    await rig.run(ARGS);
    const lines = rig.log().split(String.fromCharCode(10)).filter((l) => l.includes("WARNING: no jail"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/answer keys/);
    expect(lines[0]).toMatch(/other tasks' results/);
  });

  test("the model, version, key source and tools of the first init event", async () => {
    rig.script(happyRules(rig.ws));
    await rig.run(ARGS);
    const log = rig.log();
    expect(log).toContain(`claude-code 9.9.9: model=${MODEL} keySource=none tools=Read,Bash,Grep,Glob,Edit,Write`);
    // Announced once per task, not once per turn.
    expect(log.split("claude-code 9.9.9:")).toHaveLength(2);
  });

  test("an MCP server or a plugin in the session is a warning", async () => {
    // Every call reports it: the first init event the driver sees is the one it logs, and the two investigations run together.
    rig.script(withInit(happyRules(rig.ws), { mcpServers: ["leaky"], plugins: ["extra"] }));
    await rig.run(ARGS);
    expect(rig.log()).toContain("WARNING: the session is not isolated: mcp server leaky, plugin extra");
  });

  test("the plugins built into Claude Code are logged, and are not a warning", async () => {
    rig.script(withInit(happyRules(rig.ws), { plugins: ["cc-plugin-agents-md", "cc-plugin-telemetry"] }));
    await rig.run(ARGS);
    const log = rig.log();
    expect(log).toContain("built-in plugins, which Claude Code loads with any settings: cc-plugin-agents-md, cc-plugin-telemetry");
    expect(log).not.toContain("WARNING: the session is not isolated");
  });
});

describe("retries", () => {
  const overloaded = { is_error: true, text: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}' };

  test("a transient failure is retried by resuming the saved session", async () => {
    rig.script([
      { match: "# Discrimination", times: 2, action: { result: overloaded, exit: 1 } },
      ...happyRules(rig.ws),
    ]);
    expect(await rig.run(ARGS)).toBe(0);
    const attempts = callsWith("# Discrimination");
    expect(attempts).toHaveLength(3);
    const id = sessionOf(attempts[0]!).id;
    expect(attempts.map(sessionOf)).toEqual([
      { id, mode: "new" },
      { id, mode: "resume" },
      { id, mode: "resume" },
    ]);
    expect(rig.log()).toContain("transient provider error; retrying in 0s");
  });

  test("when the failed attempt saved nothing, the retry starts the same session id again", async () => {
    rig.script([
      { match: "# Discrimination", times: 1, action: { result: overloaded, exit: 1, persist: false } },
      ...happyRules(rig.ws),
    ]);
    expect(await rig.run(ARGS)).toBe(0);
    const attempts = callsWith("# Discrimination");
    expect(attempts.map((c) => sessionOf(c).mode)).toEqual(["new", "new"]);
    expect(sessionOf(attempts[1]!).id).toBe(sessionOf(attempts[0]!).id);
  });

  test("a rate limit that never clears gives up after the backoff is used", async () => {
    rig.script([{ match: "# Discrimination", action: { result: overloaded, exit: 1 } }, ...happyRules(rig.ws)]);
    expect(await rig.run(ARGS)).toBe(1);
    // The first attempt and one retry per backoff entry.
    expect(callsWith("# Discrimination")).toHaveLength(4);
  });

  test("a failure that is not transient is not retried", async () => {
    rig.script([
      { match: "# Discrimination", action: { result: { is_error: true, text: "Invalid API key" }, exit: 1 } },
      ...happyRules(rig.ws),
    ]);
    expect(await rig.run(ARGS)).toBe(1);
    expect(callsWith("# Discrimination")).toHaveLength(1);
    expect(rig.log()).toContain("Invalid API key");
  });

  test("a turn that exits 0 with an error result is a failure", async () => {
    rig.script([
      { match: "# Discrimination", action: { result: { is_error: true, text: "max turns" } } },
      ...happyRules(rig.ws),
    ]);
    await rig.run(ARGS);
    expect(rig.log()).toContain("is_error=true");
  });
});

describe("a usage limit", () => {
  const limit = { is_error: true, text: "You've hit your weekly usage limit" };

  test("is not retried, starts no further turn, and the driver exits 75", async () => {
    rig.script([{ match: "# Discrimination", action: { result: limit, exit: 1 } }, ...happyRules(rig.ws)]);
    expect(await rig.run(ARGS)).toBe(75);
    expect(callsWith("# Discrimination")).toHaveLength(1);
    // No nudge for the failed turn, and no adjudication after the investigation.
    expect(callsWith("ledger_elim.json yet")).toHaveLength(0);
    expect(callsWith("# Adjudication")).toHaveLength(0);
    expect(rig.log()).toContain("usage-limit: You've hit your weekly usage limit; this lane stops");
    expect(existsSync(join(rig.ws, "finish.json"))).toBe(false);
  });

  test("in the repair turn it leaves the adjudication in finish.json and says why the repair is missing", async () => {
    rig.script([{ match: "# Repair", action: { result: limit, exit: 1 } }, ...happyRules(rig.ws)]);
    expect(await rig.run(ARGS)).toBe(75);
    const finish = JSON.parse(readFileSync(join(rig.ws, "finish.json"), "utf8"));
    expect(finish.base).toBe("r1");
    expect(finish.repair.error).toBe("usage-limit");
    expect(callsWith("# Repair")).toHaveLength(1);
    expect(callsWith("repair.json yet")).toHaveLength(0);
  });

  test("is told from a rate limit by its wording, whatever the exit code", async () => {
    rig.script([
      { match: "# Discrimination", action: { result: { is_error: true, text: "You have reached your 5-hour usage limit" }, exit: 0 } },
      ...happyRules(rig.ws),
    ]);
    expect(await rig.run(ARGS)).toBe(75);
  });
});

describe("a turn that hangs", () => {
  /** True while a process with this pid runs. A killed process nobody has reaped yet (a zombie) does not run. */
  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
    } catch {
      return true;
    }
  }

  test("is killed at its budget with every process it started", async () => {
    const prefix = join(rig.root, "grandchild");
    rig.script([
      { match: "# Discrimination", action: { hang: true, grandchild: prefix } },
      ...happyRules(rig.ws),
    ]);
    const started = Date.now();
    const code = await rig.run([...ARGS, "--turn-timeout", "2", "--nudge-timeout", "2"]);
    expect(code).toBe(1);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(rig.log()).toContain("claude turn timed out after 2s (process tree killed)");
    const pid = Number(readFileSync(`${prefix}.pid`, "utf8"));
    expect(pid).toBeGreaterThan(0);
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
  }, 60_000);
});

describe("starting claude", () => {
  test("a missing program stops the task before any turn, with a message that says what to do", async () => {
    const { code, stderr } = await runCapturingStderr(ARGS, { claudeCommand: ["no-such-claude-program-for-test"] });
    expect(code).toBe(2);
    expect(stderr).toContain("cannot run Claude Code");
    expect(stderr).toContain("VERIHARNESS_CLAUDE_BIN");
    expect(existsSync(join(rig.ws, "session", "charter.md"))).toBe(false);
  });
});

describe("the options of the claude-code provider", () => {
  const ws = "task";
  const parse = (...flags: string[]) => parseDriverArgv([ws, "--provider", "claude-code", ...flags]);

  test("a valid command line is accepted with --env none and a model", () => {
    expect(parse("--model", MODEL, "--env", "none")).toMatchObject({ args: { provider: "claude-code", model: MODEL, env: "none" } });
  });

  test("any other environment is refused, the default one included", () => {
    for (const env of [["--env", "jail"], ["--env", "native"], ["--env", "native-full"], []]) {
      const parsed = parse("--model", MODEL, ...env);
      expect(parsed).toHaveProperty("error");
      expect((parsed as { error: string }).error).toContain("--provider claude-code needs --env none");
    }
  });

  test("a model is required", () => {
    expect((parse("--env", "none") as { error: string }).error).toContain("--model is required");
    expect((parse("--env", "none", "--model", "  ") as { error: string }).error).toContain("--model is required");
  });

  test("options that configure pi or a local server are refused by name", () => {
    const refused: [string[], string][] = [
      [["--thinking", "high"], "--thinking"],
      [["--base-url", "http://x"], "--base-url"],
      [["--context-size", "8192"], "--context-size"],
      [["--temperature", "0.2"], "--temperature"],
      [["--max-tokens", "100"], "--max-tokens"],
      [["--top-p", "0.9"], "--top-p"],
      [["--request-timeout", "5"], "--request-timeout"],
    ];
    for (const [flags, name] of refused) {
      const parsed = parse("--model", MODEL, "--env", "none", ...flags);
      expect((parsed as { error: string }).error).toContain(`${name} not supported with --provider claude-code`);
    }
  });

  test("the provider name is not case sensitive", () => {
    const parsed = parseDriverArgv([ws, "--provider", "Claude-Code", "--model", MODEL, "--env", "none"]);
    expect(parsed).toMatchObject({ args: { provider: "claude-code" } });
  });

  test("through main, a refused combination exits 2 and starts nothing", async () => {
    const { code, stderr } = await runCapturingStderr(["--provider", "claude-code", "--model", MODEL, "--env", "jail"]);
    expect(code).toBe(2);
    expect(stderr).toContain("needs --env none");
    expect(rig.calls()).toHaveLength(0);
  });
});
