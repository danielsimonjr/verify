import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseDriverArgv } from "../harness/driver.ts";
import { STUB_PI, happyRules, makeRig, piHappyRules, type Call, type Rig } from "./fixtures/verify-claude-code/rig.ts";

let rig: Rig;
beforeEach(() => {
  rig = makeRig();
});
afterEach(() => rig.cleanup());

const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";
const HAIKU = "claude-haiku-5-5";
const ARGS = ["--provider", "claude-code", "--model", SONNET, "--env", "none", "--no-skills"];

function after(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** The Claude Code calls (the stand-in pi records calls in the same directory, without a session id). */
function claudeCalls(): Call[] {
  return rig.calls().filter((c) => c.argv.includes("--session-id") || c.argv.includes("--resume"));
}

function claudeCallWith(text: string): Call {
  const call = claudeCalls().find((c) => c.stdin.includes(text));
  if (!call) throw new Error(`no Claude Code call with ${text}`);
  return call;
}

function sessionOf(call: Call): { id: string; mode: "new" | "resume" } {
  const fresh = after(call.argv, "--session-id");
  if (fresh !== undefined) return { id: fresh, mode: "new" };
  return { id: after(call.argv, "--resume")!, mode: "resume" };
}

describe("each role on its own model", () => {
  test("--role gives one role its model; the others keep the main model", async () => {
    rig.script(happyRules(rig.ws));
    expect(await rig.run([...ARGS, "--role", `checker=claude-code:${HAIKU}`])).toBe(0);
    expect(after(claudeCallWith("# Discrimination").argv, "--model")).toBe(HAIKU);
    expect(after(claudeCallWith("# Falsification").argv, "--model")).toBe(SONNET);
    expect(after(claudeCallWith("# Adjudication").argv, "--model")).toBe(SONNET);
    expect(after(claudeCallWith("# Repair").argv, "--model")).toBe(SONNET);
    expect(rig.log()).toContain(`roles: checker=claude-code:${HAIKU} challenger=claude-code:${SONNET}`);
  });

  test("a fixer with no --role follows the reviewer and resumes its session", async () => {
    rig.script(happyRules(rig.ws));
    expect(await rig.run([...ARGS, "--role", `reviewer=claude-code:${OPUS}`])).toBe(0);
    const adjudicate = claudeCallWith("# Adjudication");
    const repair = claudeCallWith("# Repair");
    expect(after(adjudicate.argv, "--model")).toBe(OPUS);
    expect(after(repair.argv, "--model")).toBe(OPUS);
    expect(sessionOf(repair)).toEqual({ id: sessionOf(adjudicate).id, mode: "resume" });
  });

  test("a fixer on another model starts a fresh session, briefed to read the work order", async () => {
    rig.script(happyRules(rig.ws));
    const code = await rig.run([...ARGS, "--role", `reviewer=claude-code:${OPUS}`, "--role", `fixer=claude-code:${HAIKU}`]);
    expect(code).toBe(0);
    const adjudicate = claudeCallWith("# Adjudication");
    const repair = claudeCallWith("# Repair");
    expect(after(repair.argv, "--model")).toBe(HAIKU);
    expect(sessionOf(repair).mode).toBe("new");
    expect(sessionOf(repair).id).not.toBe(sessionOf(adjudicate).id);
    expect(repair.stdin).toContain("The adjudication ran in another session");
    expect(rig.log()).toContain("fresh session");
    const finish = JSON.parse(readFileSync(join(rig.ws, "finish.json"), "utf8"));
    expect(finish.repair.written).toBe(true);
  });

  test("a fixer set to the reviewer's own model is the same session", async () => {
    rig.script(happyRules(rig.ws));
    await rig.run([...ARGS, "--role", `reviewer=claude-code:${OPUS}`, "--role", `fixer=claude-code:${OPUS}`]);
    expect(sessionOf(claudeCallWith("# Repair")).mode).toBe("resume");
  });

  test("a provider alias names the same model: a fixer on the main model by alias still resumes", async () => {
    rig.script(happyRules(rig.ws));
    await rig.run([...ARGS.map((a) => (a === "claude-code" ? "Claude-Code" : a)), "--role", `fixer=claude-code:${SONNET}`]);
    expect(sessionOf(claudeCallWith("# Repair")).mode).toBe("resume");
    // A local alias too: the main provider takes the canonical name that --role gives a role.
    const local = parseDriverArgv(["ws", "--provider", "llama.cpp", "--model", "m.gguf"]);
    expect("args" in local && local.args.provider).toBe("llamacpp");
  });

  test("pi investigations and a Claude Code reviewer and fixer in one task", async () => {
    // Each stub reads its own transcript format: pi rules for the investigations, Claude Code rules for the rest.
    rig.script([...happyRules(rig.ws).slice(0, 2), ...piHappyRules(rig.ws).slice(2)]);
    const piCommand = [process.execPath, STUB_PI];
    const code = await rig.run(
      [...ARGS, "--role", "checker=anthropic:pi-model", "--role", "challenger=anthropic:pi-model"],
      {},
      { piCommand },
    );
    expect(code).toBe(0);
    const pi = rig.piCalls().filter((c) => c.argv.includes("--session-dir"));
    expect(pi).toHaveLength(2);
    for (const call of pi) {
      expect(after(call.argv, "--provider")).toBe("anthropic");
      expect(after(call.argv, "--model")).toBe("pi-model");
    }
    expect(claudeCalls().map((c) => after(c.argv, "--model"))).toEqual([SONNET, SONNET]);
    expect(existsSync(join(rig.ws, "elim", "ledger_elim.json"))).toBe(true);
    expect(existsSync(join(rig.ws, "fals", "ledger_fals.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(rig.ws, "finish.json"), "utf8")).repair.written).toBe(true);
  });
});

describe("a usage limit in one Claude Code role", () => {
  test("stops the roles on other Claude Code models too, and the driver exits 75", async () => {
    const limit = { is_error: true, text: "You've hit your weekly usage limit" };
    rig.script([{ match: "# Adjudication", action: { result: limit, exit: 1 } }, ...happyRules(rig.ws)]);
    const code = await rig.run([...ARGS, "--role", `reviewer=claude-code:${OPUS}`, "--role", `fixer=claude-code:${HAIKU}`]);
    expect(code).toBe(75);
    expect(claudeCalls().filter((c) => c.stdin.includes("# Repair"))).toHaveLength(0);
  });
});

describe("the role options on the command line", () => {
  test("a Claude Code role needs --env none, whatever the main provider", () => {
    const r = parseDriverArgv(["ws", "--provider", "anthropic", "--model", "m", "--role", `reviewer=claude-code:${OPUS}`]);
    expect("error" in r && r.error).toMatch(/reviewer.*needs --env none/);
    const ok = parseDriverArgv(["ws", "--provider", "anthropic", "--model", "m", "--env", "none", "--role", `reviewer=claude-code:${OPUS}`]);
    expect("error" in ok).toBe(false);
  });

  test("pi tuning options are refused only when no role runs pi", () => {
    const all = parseDriverArgv(["ws", ...ARGS, "--temperature", "0.2"]);
    expect("error" in all && all.error).toMatch(/--temperature not supported with --provider claude-code/);
    const mixed = parseDriverArgv(["ws", ...ARGS, "--temperature", "0.2", "--role", "checker=anthropic:m"]);
    expect("error" in mixed).toBe(false);
  });

  test("--base-url and --context-size describe the main model, so a Claude Code main model refuses them", () => {
    for (const flag of [["--base-url", "http://h:1"], ["--context-size", "8192"]]) {
      const r = parseDriverArgv(["ws", ...ARGS, ...flag, "--role", "checker=ollama:m"]);
      expect("error" in r && r.error).toMatch(new RegExp(`${flag[0]} not supported with --provider claude-code`));
    }
  });

  test("a bad --role is an argument error", () => {
    const r = parseDriverArgv(["ws", ...ARGS, "--role", "boss=claude-code:x"]);
    expect("error" in r && r.error).toMatch(/unknown role 'boss'/);
  });
});
