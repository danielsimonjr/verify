// The strict compiler flags keep the dead code of item 6 and the missing returns out, and `bun run
// typecheck` must reach tests/ too: it used to read only harness/**/*.ts, so a type error in a test
// was never reported. These checks read the configs, so dropping a flag or the tests include fails here.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const read = (name: string) => JSON.parse(readFileSync(join(REPO, name), "utf8"));

describe("tsconfig.json", () => {
  const { compilerOptions } = read("tsconfig.json") as { compilerOptions: Record<string, unknown> };

  test("turns on the unused-code and implicit-return checks", () => {
    expect(compilerOptions.noUnusedLocals).toBe(true);
    expect(compilerOptions.noUnusedParameters).toBe(true);
    expect(compilerOptions.noImplicitReturns).toBe(true);
  });
});

describe("tsconfig.test.json", () => {
  const cfg = read("tsconfig.test.json") as {
    extends: string;
    include: string[];
    compilerOptions: Record<string, unknown>;
  };

  test("inherits the strict flags and checks tests/ without emitting", () => {
    expect(cfg.extends).toBe("./tsconfig.json");
    expect(cfg.include).toContain("tests/**/*.ts");
    expect(cfg.compilerOptions.noEmit).toBe(true);
  });

  test("gives the tests Bun's types, which the production build does not get", () => {
    expect(cfg.compilerOptions.types).toContain("bun");
    expect((read("tsconfig.json").compilerOptions.types as string[]) ?? []).not.toContain("bun");
  });

  test("lists every test file when the compiler is asked which files it checks", () => {
    const r = spawnSync(process.execPath, [join(REPO, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.test.json", "--listFilesOnly"], {
      cwd: REPO,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const listed = new Set(r.stdout.split(/\r?\n/).map((l) => resolve(l.trim()).toLowerCase()));
    const tests = readdirSync(join(REPO, "tests"), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => join(e.parentPath, e.name));
    expect(tests.length).toBeGreaterThan(40);
    expect(tests.filter((f) => !listed.has(resolve(f).toLowerCase()))).toEqual([]);
  });
});

describe("package.json typecheck script", () => {
  test("runs the production config and the test config", () => {
    const script = read("package.json").scripts.typecheck as string;
    expect(script).toContain("tsconfig.json");
    expect(script).toContain("tsconfig.test.json");
  });

  test("build still uses only the production config, so tests are not compiled into dist", () => {
    expect(read("package.json").scripts.build).toBe("tsc -p tsconfig.json");
  });
});
