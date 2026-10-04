import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { REPO } from "../harness/config.ts";

// The checkout root, derived from this test's own location and not from harness/config.ts,
// so a wrong REPO in config.ts cannot make the assertions below agree with themselves.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_CLI = join(ROOT, "dist", "harness", "cli.js");
const DIST_CONFIG = join(ROOT, "dist", "harness", "config.js");

function firstLine(path: string): string {
  return readFileSync(path, "utf8").split(/\r?\n/, 1)[0] ?? "";
}

describe("source layout", () => {
  test("REPO is the checkout root", () => {
    expect(REPO).toBe(ROOT);
  });

  test("cli.ts starts with a Node shebang", () => {
    expect(firstLine(join(ROOT, "harness", "cli.ts"))).toBe("#!/usr/bin/env node");
  });
});

// "bun run build" emits dist/harness/*.js, and package.json "bin" points at
// dist/harness/cli.js. These tests build the real thing and run it under Node.
describe("built layout (dist/harness)", () => {
  beforeAll(() => {
    const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
    const r = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`tsc failed:\n${r.stdout}\n${r.stderr}`);
  }, 120_000);

  test("tsc preserves the shebang as the first line of dist/harness/cli.js", () => {
    expect(existsSync(DIST_CLI)).toBe(true);
    // Strict about the terminator: a "\r" here makes Linux look for an interpreter named "node\r".
    expect(readFileSync(DIST_CLI, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  test("node dist/harness/cli.js --help runs", () => {
    const r = spawnSync("node", [DIST_CLI, "--help"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("usage: veriharness");
  });

  test("dist/harness/config.js resolves REPO to the checkout root, not dist/", () => {
    const r = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(pathToFileURL(DIST_CONFIG).href)}); ` +
          "console.log(JSON.stringify({ REPO: m.REPO, HARNESS_DIR: m.HARNESS_DIR, PROMPTS_DIR: m.PROMPTS_DIR, " +
          "SKILLS_DIR: m.SKILLS_DIR, SCRIPTS_DIR: m.SCRIPTS_DIR, PI_HOME: m.PI_HOME }));",
      ],
      { encoding: "utf8" },
    );
    expect(r.stderr).toBe("");
    const got = JSON.parse(r.stdout) as Record<string, string>;
    expect(got.REPO).toBe(ROOT);
    expect(got.HARNESS_DIR).toBe(join(ROOT, "harness"));
    expect(got.PROMPTS_DIR).toBe(join(ROOT, "harness", "prompts"));
    expect(got.SKILLS_DIR).toBe(join(ROOT, "harness", "skills"));
    expect(got.SCRIPTS_DIR).toBe(join(ROOT, "harness", "scripts"));
    expect(got.PI_HOME).toBe(join(ROOT, "harness", "pi-home"));
    // These assets are not emitted into dist/, so the paths above must name real files at the root.
    expect(existsSync(got.PROMPTS_DIR!)).toBe(true);
    expect(existsSync(got.SKILLS_DIR!)).toBe(true);
  });
});
