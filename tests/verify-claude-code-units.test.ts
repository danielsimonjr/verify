import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  KEPT_VARIABLES,
  PI_TO_CLAUDE_TOOL,
  SESSION_MARKERS,
  SESSION_MARKER_PREFIXES,
  UNSUPPORTED_WITH_CLAUDE_CODE,
  claudeArgs,
  claudeConfigDir,
  claudeOwnRecord,
  claudeTools,
  classifyFailure,
  findPersisted,
  isClaudeCodeProvider,
  movePersisted,
  parseStream,
  withoutSessionMarkers,
} from "../harness/claude/index.ts";
import { defaultTmpDir } from "../harness/config.ts";
import { renderSkills, skillRoots } from "../harness/driver.ts";
import { runWithBudget } from "../harness/runtime.ts";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "vcc-unit-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const ID = "0f9d5c7e-2b41-4a6f-9c3d-5e8a1b7f6d20";

describe("the provider and its tools", () => {
  test("the provider name is matched without regard to case or padding", () => {
    expect(isClaudeCodeProvider("claude-code")).toBe(true);
    expect(isClaudeCodeProvider(" Claude-Code ")).toBe(true);
    expect(isClaudeCodeProvider("claude")).toBe(false);
    expect(isClaudeCodeProvider("ollama")).toBe(false);
    expect(isClaudeCodeProvider(undefined)).toBe(false);
  });

  test("the two contracts' pi tools map to Claude Code tools, find and ls to one Glob", () => {
    expect(claudeTools("read,bash,grep,find,ls")).toBe("Read,Bash,Grep,Glob");
    expect(claudeTools("read,bash,grep,find,ls,edit,write")).toBe("Read,Bash,Grep,Glob,Edit,Write");
    expect(claudeTools(" read , ,bash")).toBe("Read,Bash");
  });

  test("a pi tool with no Claude Code counterpart is an error, not a silent drop", () => {
    expect(() => claudeTools("read,webfetch")).toThrow(/no Claude Code tool for the pi tool 'webfetch'/);
  });

  test("every tool a pi contract can name has a mapping", () => {
    expect(Object.keys(PI_TO_CLAUDE_TOOL).sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
  });

  test("the options a local model needs are the ones this provider refuses", () => {
    expect([...UNSUPPORTED_WITH_CLAUDE_CODE].sort()).toEqual(
      ["base-url", "context-size", "max-tokens", "request-timeout", "temperature", "thinking", "top-p"].sort(),
    );
  });
});

describe("the command line of a turn", () => {
  const base = { model: "m", tools: "Read,Bash", charterFile: "/c.md", addDirs: [] as string[] };

  test("a new session is named with --session-id, a continuing one with --resume", () => {
    const fresh = claudeArgs({ ...base, session: { mode: "new", id: ID } });
    expect(fresh).toContain("--session-id");
    expect(fresh).not.toContain("--resume");
    const resumed = claudeArgs({ ...base, session: { mode: "resume", id: ID } });
    expect(resumed).toContain("--resume");
    expect(resumed).not.toContain("--session-id");
    expect(resumed[resumed.indexOf("--resume") + 1]).toBe(ID);
  });

  test("the isolation flags are on both kinds of turn", () => {
    for (const mode of ["new", "resume"] as const) {
      const args = claudeArgs({ ...base, session: { mode, id: ID } }).join("\u0000");
      for (const part of [
        ["--setting-sources", ""],
        ["--strict-mcp-config"],
        ["--settings", '{"disableAllHooks":true,"autoMemoryEnabled":false,"autoContinueAtUsageLimit":false}'],
        ["--tools", "Read,Bash"],
        ["--permission-mode", "bypassPermissions"],
        ["--append-system-prompt-file", "/c.md"],
      ]) {
        expect(args).toContain(part.join("\u0000"));
      }
    }
  });

  test("each directory outside the workspace is added with its own --add-dir", () => {
    const args = claudeArgs({ ...base, addDirs: ["/a", "/b"], session: { mode: "new", id: ID } });
    expect(args.filter((a) => a === "--add-dir")).toHaveLength(2);
    expect(args.join(" ")).toContain("--add-dir /a --add-dir /b");
  });

  test("the prompt is not an argument", () => {
    const args = claudeArgs({ ...base, session: { mode: "new", id: ID } });
    expect(args.at(-1)).toBe("/c.md");
    expect(args.some((a) => a.includes(" "))).toBe(false);
  });
});

describe("the variables of a session", () => {
  test("no marker is, or starts like, a variable that carries the login or the provider choice", () => {
    for (const marker of SESSION_MARKERS) {
      for (const kept of KEPT_VARIABLES) {
        expect(marker.toUpperCase()).not.toBe(kept.toUpperCase());
      }
    }
    for (const name of [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
    ]) {
      expect(SESSION_MARKERS).not.toContain(name);
      expect(KEPT_VARIABLES).toContain(name);
    }
    expect(SESSION_MARKERS.some((n) => n.startsWith("ANTHROPIC_"))).toBe(false);
    expect(SESSION_MARKERS.some((n) => /(_USE_|OAUTH|CONFIG_DIR)/.test(n))).toBe(false);
  });

  test("no kept variable, and no login or provider variable, starts with a stripped prefix", () => {
    const login = [...new Set([...KEPT_VARIABLES, "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR"])];
    for (const prefix of SESSION_MARKER_PREFIXES) {
      for (const name of login) expect(name.toUpperCase().startsWith(prefix)).toBe(false);
    }
    const out = withoutSessionMarkers(Object.fromEntries(login.map((n) => [n, "v"])));
    expect(Object.keys(out).sort()).toEqual([...login].sort());
  });

  test("the fresh-session clean-up names of Claude Code are stripped, by name and by prefix, in any case", () => {
    const stripped = [
      "CLAUDE_CODE_BRIDGE_SESSION_ID",
      "CLAUDE_CODE_BRIDGE_ANYTHING",
      "CLAUDE_CODE_HOST_WORKTREE",
      "CLAUDE_CODE_HOST_WORKTREE_FENCE",
      "CLAUDE_CODE_PLUGIN_DIRS",
      "CLAUDE_CODE_CHROME_MCP_ORG_DENIED",
      "CLAUDE_CODE_EVAL_RUN",
      "claude_code_eval_lower",
      "CLAUDE_BG_RV_AUTH",
      "CLAUDE_BG_PTY_AUTH",
      "CLAUDE_BG_SOCKET_TOKENS_PATH",
      "Claude_Bg_Other",
      "CLAUDE_CODE_SIMPLE",
      "CLAUDE_CODE_SAFE_MODE",
      "CLAUDE_CODE_RESTRICTED",
    ];
    const kept = ["CLAUDE_BGX", "CLAUDE_CODE_BRIDGE", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "PATH"];
    const out = withoutSessionMarkers(Object.fromEntries([...stripped, ...kept].map((n) => [n, "v"])));
    expect(Object.keys(out).sort()).toEqual([...kept].sort());
  });

  test("withoutSessionMarkers drops the markers, in any case, and nothing else", () => {
    const env = {
      CLAUDECODE: "1",
      claude_code_session_id: "s",
      Ai_Agent: "x",
      CLAUDE_CODE_MESSAGING_TOKEN: "t",
      PATH: "/bin",
      ANTHROPIC_API_KEY: "k",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "1",
    };
    const before = { ...env };
    const out = withoutSessionMarkers(env);
    expect(out).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "1" });
    expect(env).toEqual(before);
  });
});

describe("parseStream", () => {
  const init = {
    type: "system",
    subtype: "init",
    model: "claude-haiku-4-5-20251001",
    claude_code_version: "2.1.289",
    apiKeySource: "none",
    session_id: ID,
    cwd: "/w",
    tools: ["Read", "Bash"],
    mcp_servers: [{ name: "m", status: "connected" }],
    plugins: [{ name: "p" }],
  };
  const result = { type: "result", subtype: "success", is_error: false, result: "OK", num_turns: 3, total_cost_usd: 0.5 };
  const text = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

  test("reads the init event and the result event", () => {
    const seen = parseStream(text(init, { type: "assistant", message: {} }, result));
    expect(seen.init).toEqual({
      model: "claude-haiku-4-5-20251001",
      version: "2.1.289",
      apiKeySource: "none",
      sessionId: ID,
      cwd: "/w",
      tools: ["Read", "Bash"],
      mcpServers: ["m"],
      plugins: ["p"],
    });
    expect(seen.result).toEqual({ isError: false, subtype: "success", text: "OK", errors: [], numTurns: 3, costUsd: 0.5 });
  });

  test("the last result wins and the first init wins, across turns of one transcript", () => {
    const seen = parseStream(text(init, result, { ...init, model: "other" }, { ...result, is_error: true, result: "boom" }));
    expect(seen.init?.model).toBe("claude-haiku-4-5-20251001");
    expect(seen.result).toMatchObject({ isError: true, text: "boom" });
  });

  test("a turn with no result event has none, and garbage lines are skipped", () => {
    const seen = parseStream(`not json\n{"type":\n${JSON.stringify(init)}\n[1,2]\n`);
    expect(seen.result).toBeUndefined();
    expect(seen.init?.version).toBe("2.1.289");
    expect(parseStream("")).toEqual({ init: undefined, result: undefined });
  });
});

describe("claudeOwnRecord", () => {
  const record = "ledger_elim.json";
  const GOOD = JSON.stringify({ disagreements: [] });

  function transcript(name: string, ...blocks: unknown[]): void {
    const lines = blocks.map((content) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [content] } }));
    writeFileSync(join(scratch, name), lines.join("\n") + "\n");
  }
  const tool = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", id: "t", name, input });

  test("a Write of the record supplies its content", () => {
    transcript("a.jsonl", tool("Write", { file_path: `/ws/${record}`, content: GOOD }));
    expect(claudeOwnRecord(scratch, join("/ws", record))).toBe(GOOD);
  });

  test("a Windows path in the tool call names the record too", () => {
    transcript("a.jsonl", tool("Write", { file_path: `C:\\ws\\${record}`, content: GOOD }));
    expect(claudeOwnRecord(scratch, `C:\\ws\\${record}`)).toBe(GOOD);
  });

  test("a Write whose content is not JSON is no record", () => {
    transcript("a.jsonl", tool("Write", { file_path: `/ws/${record}`, content: "{ not json" }));
    expect(claudeOwnRecord(scratch, join("/ws", record))).toBeNull();
  });

  test("a file with a similar name does not count", () => {
    transcript("a.jsonl", tool("Write", { file_path: `/ws/my-${record}`, content: GOOD }), tool("Write", { file_path: `/ws/${record}.bak`, content: GOOD }));
    expect(claudeOwnRecord(scratch, join("/ws", record))).toBeNull();
  });

  test("a Bash command that names the record means the file on disk is the record, if it parses", () => {
    const onDisk = join(scratch, record);
    transcript("a.jsonl", tool("Bash", { command: `echo '{}' > ${record}` }));
    expect(claudeOwnRecord(scratch, onDisk)).toBeNull();
    writeFileSync(onDisk, GOOD);
    expect(claudeOwnRecord(scratch, onDisk)).toBe(GOOD);
    writeFileSync(onDisk, "{ broken");
    expect(claudeOwnRecord(scratch, onDisk)).toBeNull();
  });

  test("an Edit or a MultiEdit of the record is read back from disk", () => {
    const onDisk = join(scratch, record);
    writeFileSync(onDisk, GOOD);
    for (const name of ["Edit", "MultiEdit"]) {
      transcript("a.jsonl", tool(name, { file_path: onDisk }));
      expect(claudeOwnRecord(scratch, onDisk)).toBe(GOOD);
    }
  });

  test("the last call that names the record decides", () => {
    const onDisk = join(scratch, record);
    transcript(
      "a.jsonl",
      tool("Write", { file_path: onDisk, content: GOOD }),
      tool("Write", { file_path: onDisk, content: "{ broken" }),
    );
    expect(claudeOwnRecord(scratch, onDisk)).toBeNull();
    transcript(
      "a.jsonl",
      tool("Write", { file_path: onDisk, content: "{ broken" }),
      tool("Write", { file_path: onDisk, content: GOOD }),
    );
    expect(claudeOwnRecord(scratch, onDisk)).toBe(GOOD);
  });

  test("a file on disk that no tool call of this session wrote is not its own", () => {
    const onDisk = join(scratch, record);
    writeFileSync(onDisk, GOOD);
    transcript("a.jsonl", tool("Read", { file_path: onDisk }));
    expect(claudeOwnRecord(scratch, onDisk)).toBeNull();
  });

  test("the claude-persisted copy and non-transcript files are not read", () => {
    mkdirSync(join(scratch, "claude-persisted"));
    writeFileSync(
      join(scratch, "claude-persisted", "a.jsonl"),
      JSON.stringify({ type: "assistant", message: { content: [tool("Write", { file_path: `/ws/${record}`, content: GOOD })] } }) + "\n",
    );
    writeFileSync(join(scratch, "notes.txt"), JSON.stringify({ type: "assistant", message: { content: [tool("Write", { file_path: `/ws/${record}`, content: GOOD })] } }));
    expect(claudeOwnRecord(scratch, join("/ws", record))).toBeNull();
  });

  test("a session directory that does not exist has no record, without throwing", () => {
    expect(claudeOwnRecord(join(scratch, "absent"), join("/ws", record))).toBeNull();
  });
});

describe("parseStream, the errors of a result event", () => {
  const line = (extra: Record<string, unknown>) =>
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK", ...extra }) + String.fromCharCode(10);

  test("a non-empty errors array makes the result an error and puts its text in the reason", () => {
    const { result } = parseStream(line({ errors: ["No conversation found", { message: "second" }, 7] }));
    expect(result!.isError).toBe(true);
    expect(result!.errors).toEqual(["No conversation found", "second", "7"]);
    expect(result!.text).toContain("OK");
    expect(result!.text).toContain("No conversation found");
    expect(result!.text).toContain("second");
  });

  test("an empty or absent errors array changes nothing, and is_error true stays an error", () => {
    expect(parseStream(line({ errors: [] })).result!.isError).toBe(false);
    expect(parseStream(line({})).result).toMatchObject({ isError: false, errors: [], text: "OK" });
    const failed = parseStream(line({ is_error: true, result: "boom", errors: ["why"] })).result!;
    expect(failed.isError).toBe(true);
    expect(failed.text).toBe("boom" + String.fromCharCode(10) + "why");
  });
});

describe("classifyFailure", () => {
  test("a usage limit, in the several ways Claude Code says it", () => {
    for (const text of [
      "Claude usage limit reached",
      "You've hit your weekly limit",
      "You\u2019ve hit your monthly spend limit",
      "you have reached your weekly usage limit",
      "You reached your 5-hour usage limit",
    ]) {
      expect(classifyFailure(text)).toBe("usage-limit");
    }
  });

  test("every usage-limit message of Claude Code is a usage limit, with a straight or a curly apostrophe", () => {
    const messages = [
      "You've reached your monthly limit",
      "You've reached your usage limit for Opus",
      "You've reached your extra usage limit",
      "You're out of usage credits",
      "You're out of extra usage",
      "Your org is out of usage",
      "Your seat type doesn't include usage",
      "Your usage allocation has been disabled by your admin",
    ];
    for (const message of messages) {
      expect(classifyFailure(message)).toBe("usage-limit");
      expect(classifyFailure(message.replaceAll("'", "’"))).toBe("usage-limit");
      expect(classifyFailure(`Error: ${message}. Resets at 5pm`)).toBe("usage-limit");
    }
  });

  test("a usage limit beats a rate-limit word in the same text", () => {
    expect(classifyFailure("API Error: 429 rate_limit_error: you've hit your weekly limit")).toBe("usage-limit");
  });

  test("provider and transport faults are transient", () => {
    for (const text of [
      "API Error: 529 overloaded_error",
      "API Error 503 Service Unavailable",
      "request failed with 429",
      "Overloaded",
      "rate_limit_error",
      '{"type":"api_error"}',
      "RESOURCE_EXHAUSTED",
      "read ECONNRESET",
      "socket hang up",
    ]) {
      expect(classifyFailure(text)).toBe("transient");
    }
  });

  test("a status code counts only as a whole number", () => {
    for (const text of ["41503 tokens used", "ratio 0.429", "id 15290", "Invalid API key", "", "max turns reached"]) {
      expect(classifyFailure(text)).toBe("fatal");
    }
  });
});

describe("Claude Code's configuration directory", () => {
  test("CLAUDE_CONFIG_DIR when set, else ~/.claude", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: scratch })).toBe(scratch);
    expect(claudeConfigDir({})).toBe(join(homedir(), ".claude"));
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "" })).toBe(join(homedir(), ".claude"));
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "~/elsewhere" })).toBe(join(homedir(), "elsewhere"));
  });

  function save(project: string, name: string, text = "x"): string {
    const dir = join(scratch, "projects", project);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, text);
    return file;
  }

  test("a saved copy is found in whichever project directory holds it", () => {
    save("-some-project", "11111111-1111-4111-8111-111111111111.jsonl");
    const mine = save("-my-project", `${ID}.jsonl`);
    expect(findPersisted(scratch, ID)).toBe(mine);
    expect(findPersisted(scratch, "22222222-2222-4222-8222-222222222222")).toBeNull();
    expect(findPersisted(join(scratch, "no-config-dir"), ID)).toBeNull();
  });

  test("anything that is not a UUID finds nothing, so a name cannot reach another file", () => {
    save("p", "secret.jsonl");
    for (const bad of ["secret", "../p/secret", "*", "", `${ID}/..`, `${ID}.jsonl`]) {
      expect(findPersisted(scratch, bad)).toBeNull();
    }
  });

  test("the move takes the one file, leaves its neighbours, and removes only an empty project directory", () => {
    const keep = save("p", "11111111-1111-4111-8111-111111111111.jsonl", "theirs");
    const dir = join(scratch, "projects", "p");
    mkdirSync(join(dir, ID, "tool-results"), { recursive: true });
    writeFileSync(join(dir, ID, "tool-results", "big.txt"), "sibling");
    save("p", `${ID}.jsonl`, "mine");

    const dest = join(scratch, "dest");
    const to = movePersisted(scratch, ID, dest);
    expect(to).toBe(join(dest, `${ID}.jsonl`));
    expect(readFileSync(to!, "utf8")).toBe("mine");
    expect(existsSync(join(dir, `${ID}.jsonl`))).toBe(false);
    expect(readFileSync(keep, "utf8")).toBe("theirs");
    expect(readFileSync(join(dir, ID, "tool-results", "big.txt"), "utf8")).toBe("sibling");

    // Alone in its project directory, the copy takes the directory with it.
    const lone = "33333333-3333-4333-8333-333333333333";
    save("lonely", `${lone}.jsonl`);
    expect(movePersisted(scratch, lone, dest)).toBe(join(dest, `${lone}.jsonl`));
    expect(existsSync(join(scratch, "projects", "lonely"))).toBe(false);
    expect(existsSync(join(scratch, "projects"))).toBe(true);
  });

  test("a session with no saved copy moves nothing and says so", () => {
    expect(movePersisted(scratch, ID, join(scratch, "dest"))).toBeNull();
    expect(existsSync(join(scratch, "dest"))).toBe(false);
  });
});

describe("runWithBudget: a message on stdin, a stdout file, and a cut stderr", () => {
  const node = (script: string): string[] => [process.execPath, "-e", script];

  test("the input reaches the child's stdin and its stdout is appended to the file", async () => {
    const out = join(scratch, "out.txt");
    writeFileSync(out, "before\n");
    const run = await runWithBudget(node("process.stdin.pipe(process.stdout)"), {
      cwd: scratch,
      env: process.env,
      budgetMs: 30_000,
      input: "hello \u00e9\u20ac\n",
      stdoutFile: out,
    });
    expect(run.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("before\nhello \u00e9\u20ac\n");
  });

  test("an input larger than a pipe holds goes through whole", async () => {
    const out = join(scratch, "big.txt");
    const input = "line of text\n".repeat(200_000);
    const run = await runWithBudget(node("process.stdin.pipe(process.stdout)"), {
      cwd: scratch,
      env: process.env,
      budgetMs: 60_000,
      input,
      stdoutFile: out,
    });
    expect(run.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(input);
  });

  test("a child that never reads its stdin is not an error of the caller", async () => {
    const run = await runWithBudget(node("process.exit(3)"), {
      cwd: scratch,
      env: process.env,
      budgetMs: 30_000,
      input: "x".repeat(5_000_000),
    });
    expect(run.code).toBe(3);
    expect(run.spawnError).toBeUndefined();
  });

  test("without input the child's stdin is closed at once", async () => {
    const run = await runWithBudget(node("process.stdin.on('data',()=>{}).on('end',()=>process.exit(0))"), {
      cwd: scratch,
      env: process.env,
      budgetMs: 30_000,
    });
    expect(run.code).toBe(0);
  });

  test("a stdout file that cannot be opened is a start failure, not a throw", async () => {
    const run = await runWithBudget(node("0"), {
      cwd: scratch,
      env: process.env,
      budgetMs: 30_000,
      stdoutFile: join(scratch, "no-such-dir", "out.txt"),
    });
    expect(run.code).toBeNull();
    expect(run.spawnError).toContain("cannot open");
  });

  test("stderr that fits is whole and not marked cut", async () => {
    const run = await runWithBudget(node("process.stderr.write('short message')"), { cwd: scratch, env: process.env, budgetMs: 30_000 });
    expect(run.stderr).toBe("short message");
    expect(run.stderrCut).toBe(false);
  });

  test("a long stderr keeps its end, at the cap, and says the start is gone", async () => {
    const script =
      "const line = 'x'.repeat(1023) + '\\n';" +
      "for (let i = 0; i < 5000; i++) process.stderr.write(line);" +
      "process.stderr.write('THE-END');";
    const run = await runWithBudget(node(script), { cwd: scratch, env: process.env, budgetMs: 60_000 });
    expect(run.code).toBe(0);
    expect(run.stderrCut).toBe(true);
    expect(run.stderr.length).toBe(262_144);
    expect(run.stderr.endsWith("THE-END")).toBe(true);
  });

  test("a multi-byte character split by a chunk boundary is kept whole", async () => {
    // 300,000 bytes of a 3-byte character: no pipe chunk size divides that evenly at every boundary.
    const run = await runWithBudget(node("process.stderr.write('\\u20ac'.repeat(100000))"), {
      cwd: scratch,
      env: process.env,
      budgetMs: 60_000,
    });
    expect(run.stderr).not.toContain("\ufffd");
    expect(run.stderr.length).toBe(100_000);
    expect(run.stderrCut).toBe(false);
  });
});

describe("the temporary directory default", () => {
  test("/var/tmp where it exists, the operating system's directory where it does not", () => {
    expect(defaultTmpDir(true, "C:\\Temp")).toBe("/var/tmp");
    expect(defaultTmpDir(false, "C:\\Temp")).toBe("C:\\Temp");
    expect(defaultTmpDir(false)).toBe(tmpdir());
  });
});

describe("the skill directories of a Claude Code turn", () => {
  test("every skill of the library is covered by the library directory, once", () => {
    const dir = mkdtempSync(join(scratch, "lib-"));
    for (const name of ["a", "b"]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "SKILL.md"), "---\nname: x\n---\nbody");
    }
    expect(skillRoots([join(dir, "a"), join(dir, "b")], dir)).toEqual([dir]);
  });

  test("a skill outside the library gets its own directory, a file skill its parent's", () => {
    const outside = mkdtempSync(join(scratch, "out-"));
    mkdirSync(join(outside, "s"));
    writeFileSync(join(outside, "s", "SKILL.md"), "x");
    writeFileSync(join(outside, "loose.md"), "x");
    const lib2 = mkdtempSync(join(scratch, "lib2-"));
    expect(skillRoots([join(outside, "s"), join(outside, "loose.md")], lib2).sort()).toEqual([join(outside, "s"), outside].sort());
    expect(skillRoots([], lib2)).toEqual([]);
  });
});

describe("the words of the skills block for each runtime", () => {
  function library(): { skills: string[]; ws: string } {
    const ws = join(scratch, "ws");
    mkdirSync(join(ws, "rollouts", "r1", "deliverables"), { recursive: true });
    const dir = join(scratch, "skills", "evidence-x");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: evidence-x\ndescription: reads x\n---\nUse the tool.");
    return { skills: [dir], ws };
  }

  test("mounted skills say where they are for each runtime", () => {
    const { skills, ws } = library();
    expect(renderSkills(skills, ws, "elim", "mounted", "pi")).toContain("listed in your system prompt");
    const claude = renderSkills(skills, ws, "elim", "mounted", "claude-code");
    expect(claude).toContain("The skills for this turn, in full");
    expect(claude).not.toContain("system prompt");
    expect(claude).toContain("Use the tool.");
  });

  test("auto-mode skills name the tool by the runtime's own name", () => {
    const { skills, ws } = library();
    expect(renderSkills(skills, ws, "elim", "auto", "pi")).toContain("with the read tool");
    expect(renderSkills(skills, ws, "elim", "auto", "claude-code")).toContain("with the Read tool");
  });

  test("the pi wording is the default", () => {
    const { skills, ws } = library();
    expect(renderSkills(skills, ws, "elim", "mounted")).toBe(renderSkills(skills, ws, "elim", "mounted", "pi"));
  });
});
