import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KEPT_VARIABLES,
  PI_TO_CLAUDE_TOOL,
  SESSION_MARKERS,
  USAGE_LIMIT_EXIT,
  claudeArgs,
  claudeTools,
} from "../harness/claude/index.ts";
import * as config from "../harness/config.ts";
import * as materialize from "../harness/materialize/base.ts";
import { TEXT_VIEW_CAP } from "../harness/views.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");

const README = read("README.md");
const CLAUDE_DOC = read("docs", "claude-code.md");
const DRIVER = read("harness", "driver.ts");
const PROMPTS_DIR = join(ROOT, "harness", "prompts");
const PROMPTS = readdirSync(PROMPTS_DIR)
  .filter((f) => f.endsWith(".md"))
  .map((f) => ({ name: f, text: read("harness", "prompts", f) }));

/** The text of every heading of a markdown file, as GitHub makes its anchor. */
function anchors(markdown: string): Set<string> {
  const out = new Set<string>();
  for (const m of markdown.matchAll(/^#{1,6} +(.+)$/gm)) {
    out.add(
      m[1]!
        .toLowerCase()
        .replace(/`/g, "")
        .replace(/[^a-z0-9 _-]/g, "")
        .trim()
        .replace(/ /g, "-"),
    );
  }
  return out;
}

describe("README", () => {
  test("the adapter sentence names the TypeScript types, not a Python module path", () => {
    expect(README).not.toContain("materialize.base");
    expect(README).toContain("`iterTasks(pool)`");
    expect(typeof materialize.Task).toBe("function");
    expect(typeof materialize.Rollout).toBe("function");
    expect(typeof materialize.runCli).toBe("function");
    expect(existsSync(join(ROOT, "harness", "materialize", "sb2.ts"))).toBe(true);
    expect(read("harness", "materialize", "sb2.ts")).toContain("export function* iterTasks(pool: string)");
  });

  test("every contents entry points at a heading that exists", () => {
    const have = anchors(README);
    const toc = README.slice(README.indexOf("## Contents"), README.indexOf("## How it works"));
    const targets = [...toc.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]!);
    expect(targets.length).toBeGreaterThan(8);
    for (const t of targets) expect(have.has(t)).toBe(true);
    expect(targets).toContain("claude-code-as-the-verifier");
  });

  test("every relative link of the README and of the Claude Code page leads to a file", () => {
    for (const [text, base] of [
      [README, ROOT],
      [CLAUDE_DOC, join(ROOT, "docs")],
    ] as const) {
      for (const m of text.matchAll(/\]\((?!https?:|#|mailto:)([^)#]+)(#[^)]*)?\)/g)) {
        expect(existsSync(resolve(base, m[1]!))).toBe(true);
      }
    }
  });

  test("it names the commands, options and variables of the Claude Code provider that exist", () => {
    for (const part of ["--provider claude-code", "--lane-max haiku=4", "VERIHARNESS_CLAUDE_BIN", "docs/claude-code.md", "--env none"]) {
      expect(README).toContain(part);
    }
    expect(README).toContain(`${USAGE_LIMIT_EXIT}`);
    expect(config.LANES.haiku).toContain("claude-haiku-4-5-20251001");
    expect(README).toMatch(/^ {2}claude\/ +the Claude Code runtime/m);
    expect(existsSync(join(ROOT, "harness", "claude", "turn.ts"))).toBe(true);
  });
});

describe("docs/claude-code.md says what the code does", () => {
  test("it lists every session marker the driver removes, and every variable it keeps", () => {
    for (const name of [...SESSION_MARKERS, ...KEPT_VARIABLES]) expect(CLAUDE_DOC).toContain(`\`${name}\``);
  });

  test("the command line it shows has each isolation flag the driver passes", () => {
    const args = claudeArgs({
      model: "m",
      tools: claudeTools("read"),
      session: { mode: "new", id: "id" },
      charterFile: "c.md",
      addDirs: ["d"],
    });
    for (const flag of args.filter((a) => a.startsWith("--"))) expect(CLAUDE_DOC).toContain(flag);
    expect(CLAUDE_DOC).toContain("--resume");
  });

  test("the tool names, the exit code and the lane models match the code", () => {
    for (const claude of new Set(Object.values(PI_TO_CLAUDE_TOOL))) expect(CLAUDE_DOC).toContain(claude);
    expect(CLAUDE_DOC).toContain(`code ${USAGE_LIMIT_EXIT}`);
    expect(CLAUDE_DOC).toContain(config.LANES.haiku![3]!);
    expect(CLAUDE_DOC).toContain(config.LANES.sonnet![3]!);
    const backoff = /const RETRY_BACKOFF = \[([\d, ]+)\]/.exec(DRIVER);
    expect(backoff).not.toBeNull();
    const seconds = backoff![1]!.split(",").map((s) => s.trim());
    expect(CLAUDE_DOC).toContain(`Waits ${seconds.slice(0, -1).join(", ")} and ${seconds.at(-1)} seconds`);
  });

  test("it names the option set the driver refuses, and the environments", () => {
    for (const option of ["--thinking", "--base-url", "--context-size", "--temperature", "--max-tokens", "--top-p", "--request-timeout"]) {
      expect(CLAUDE_DOC).toContain(option);
    }
    for (const env of ["jail", "native", "native-full"]) expect(CLAUDE_DOC).toContain(env);
  });
});

describe("the prompts and the code agree (a prompt may not name what the driver does not provide)", () => {
  const all = PROMPTS.map((p) => p.text).join("\n");

  test("every prompt file is used by the driver, and every file the driver loads exists", () => {
    for (const { name } of PROMPTS) expect(DRIVER).toContain(`"${name}"`);
    for (const m of DRIVER.matchAll(/"((?:INVESTIGATE|LEDGER)_[A-Z]+\.md|ADJUDICATE\.md|REPAIR\.md|MISSION\.md|CHARTER\.md)"/g)) {
      expect(existsSync(join(PROMPTS_DIR, m[1]!))).toBe(true);
    }
  });

  test("every file a prompt names is one the harness produces or reads", () => {
    const named = new Set([...all.matchAll(/[A-Za-z0-9_<>./-]+\.(?:json|md|tsv|txt)\b/g)].map((m) => m[0]));
    const known: Record<string, (src: string) => boolean> = {
      "MISSION.md": () => DRIVER.includes('join(ws, "MISSION.md")'),
      "elim/LEDGER.md": () => DRIVER.includes('join(ws, name, "LEDGER.md")') && DRIVER.includes('"elim"'),
      "fals/LEDGER.md": () => DRIVER.includes('join(ws, name, "LEDGER.md")') && DRIVER.includes('"fals"'),
      "ledger_elim.json": () => DRIVER.includes('"ledger_elim.json"'),
      "ledger_fals.json": () => DRIVER.includes('"ledger_fals.json"'),
      "finish.json": () => DRIVER.includes('join(agent.ws, "finish.json")'),
      "repair.json": () => DRIVER.includes('join(ws, "repair.json")'),
      "LEDGER.md": () => DRIVER.includes('"LEDGER.md"'),
      "SKILL.md": () => DRIVER.includes('"SKILL.md"'),
      "<name>.cells.tsv": () => read("harness", "views.ts").includes(".cells.tsv"),
      ".cells.tsv": () => read("harness", "views.ts").includes(".cells.tsv"),
      ".text.txt": () => read("harness", "views.ts").includes(".text.txt"),
      "<name>.text.txt": () => read("harness", "views.ts").includes(".text.txt"),
    };
    const unknown = [...named].filter((n) => known[n] === undefined);
    expect(unknown).toEqual([]);
    for (const n of named) expect(known[n]!(DRIVER)).toBe(true);
  });

  test("the directories a prompt names are the ones the materializer and the driver lay out", () => {
    const base = read("harness", "materialize", "base.ts");
    for (const dir of ["spec", "workspace", "rollouts", "deliverables", "trajectory"]) {
      expect(all).toContain(`${dir}/`);
      expect(base).toContain(`"${dir}"`);
    }
    expect(all).toContain("out/deliverables/");
    expect(DRIVER).toContain('"out", "deliverables"');
  });

  test("the fields a prompt's record format gives are the ones the driver reads", () => {
    const fields: [string, RegExp][] = [
      ["base", /\.base\b|baseOf\(/],
      ["work", /\.work\b/],
      ["open", /\.open\b/],
      ["applied", /\.applied\b/],
      ["changes", /\.changes\b/],
      ["disagreements", /disagreements/],
      ["challenges", /challenges/],
    ];
    for (const [field, reads] of fields) {
      expect(all).toContain(`"${field}"`);
      expect(reads.test(DRIVER)).toBe(true);
    }
  });

  test("the notes on the rendered views match what the renderers write", () => {
    const charter = PROMPTS.find((p) => p.name === "CHARTER.md")!.text;
    expect(charter).toContain(TEXT_VIEW_CAP.toLocaleString("en-US"));
    const renderers = read("harness", "materialize", "renderers.ts");
    expect(renderers).toContain("# sheets:");
    expect(renderers).toContain("# cut at");
    expect(charter).toContain("# sheets:");
    expect(charter).toContain("# cut at N cells");
  });

  test("a tool a prompt names in backticks is one the Claude Code runtime maps", () => {
    const named = new Set(
      [...all.matchAll(/`(read|bash|grep|find|ls|edit|write|glob|multiedit|webfetch|websearch|task|notebookedit)`/g)].map((m) => m[1]!),
    );
    for (const tool of named) expect(PI_TO_CLAUDE_TOOL[tool]).toBeDefined();
  });

  test("the charter's list of paths is the workspace the mission is staged in", () => {
    const charter = PROMPTS.find((p) => p.name === "CHARTER.md")!.text;
    const block = charter.slice(charter.indexOf("# The workspace"), charter.indexOf("Each phase's instructions"));
    const listed = [...block.matchAll(/^ {4,6}([A-Za-z_./<>]+)\s*(?:—.*)?$/gm)].map((m) => m[1]!);
    expect(listed).toEqual([
      "MISSION.md",
      "spec/",
      "workspace/",
      "rollouts/<name>/",
      "deliverables/",
      "trajectory/",
      "elim/LEDGER.md",
      "fals/LEDGER.md",
      "ledger_elim.json",
      "ledger_fals.json",
      "finish.json",
      "out/deliverables/",
    ]);
  });
});
