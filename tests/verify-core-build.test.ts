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
// dist/harness/cli.js. The tests below build the real thing (the same tsc call as the "build"
// script; dist/ is gitignored) and run it under Node.
beforeAll(() => {
  const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  const r = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`tsc failed:\n${r.stdout}\n${r.stderr}`);
}, 120_000);

describe("built layout (dist/harness)", () => {
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

// A package script that names a file or glob matching nothing "runs" without testing anything:
// `node --test dist/harness/**/*.test.js` exited 0 with zero tests under Node, and errored under
// bun's shell. Build first (the dist/ paths in "start" and "bin" need it), then check every path.
describe("package.json scripts and bin point at real files", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
    bin: Record<string, string>;
  };

  test("every harness/, dist/ or tests/ path in a script exists (globs must match something)", () => {
    const checked: string[] = [];
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      for (const token of cmd.split(/\s+/)) {
        if (!/^(harness|dist|tests)\//.test(token)) continue;
        checked.push(`${name}: ${token}`);
        const found = token.includes("*")
          ? [...new Bun.Glob(token).scanSync({ cwd: ROOT })].length > 0
          : existsSync(join(ROOT, token));
        expect(found, `script "${name}" names ${token}, which matches nothing`).toBe(true);
      }
    }
    expect(checked.length).toBeGreaterThan(5);
  });

  test("every bin target exists after a build", () => {
    for (const target of Object.values(pkg.bin)) {
      expect(existsSync(join(ROOT, target)), target).toBe(true);
    }
  });
});

// The package is the scoped @danielsimonjr/verify: the plain name `verify` on npm belongs to another package. The command
// is veriharness: cmd.exe runs its built-in VERIFY command before it searches PATH, so a `verify` command would never run there.
describe("package name and command", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    name: string;
    bin: Record<string, string>;
  };

  test("the package is @danielsimonjr/verify, and its only command is veriharness", () => {
    expect(pkg.name).toBe("@danielsimonjr/verify");
    expect(Object.keys(pkg.bin)).toEqual(["veriharness"]);
  });

  test("both lockfiles name the same package", () => {
    const npmLock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as {
      name: string;
      packages: Record<string, { name?: string }>;
    };
    expect([npmLock.name, npmLock.packages[""]?.name]).toEqual([pkg.name, pkg.name]);
    // bun.lock allows trailing commas, so read the root workspace's name with a pattern, not JSON.parse.
    const bunLock = readFileSync(join(ROOT, "bun.lock"), "utf8");
    expect(/"workspaces":\s*\{\s*"":\s*\{\s*"name":\s*"([^"]+)"/.exec(bunLock)?.[1]).toBe(pkg.name);
  });
});
