import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(dirname(import.meta.dir));
const RUN_JS = join(ROOT, "harness", "skills", "_shared", "run.js");

/** Every .js file under harness/ (the skill entry scripts and their shared launcher). */
function harnessJsFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== "node_modules" && ent.name !== "vendor") walk(p);
      } else if (ent.name.endsWith(".js")) {
        out.push(p);
      }
    }
  };
  walk(join(ROOT, "harness"));
  return out.sort();
}

describe("harness .js files are plain JavaScript", () => {
  const files = harnessJsFiles();

  test("there are skill entry scripts to check", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain(RUN_JS);
  });

  // Node runs these files as-is; tsc does not compile them. A TypeScript annotation in one is a
  // SyntaxError for every documented production command ("node scripts/xlsx_dump.js").
  for (const file of files) {
    test(`node --check ${relative(ROOT, file).replace(/\\/g, "/")}`, () => {
      const r = spawnSync("node", ["--check", file], { encoding: "utf8" });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    });
  }
});

describe("launchSkill under Node", () => {
  let tmp: string;
  let script: string;

  // Mirror the repo layout: <root>/harness/skills/<skill>/scripts/<name>.js is the entry script and
  // <root>/dist/harness/skills/<skill>/scripts/<name>.js is its compiled form. The entry script
  // imports the REAL run.js; only the compiled target is a stand-in.
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "vc-entry-"));
    const entryDir = join(tmp, "harness", "skills", "demo", "scripts");
    const compiledDir = join(tmp, "dist", "harness", "skills", "demo", "scripts");
    mkdirSync(entryDir, { recursive: true });
    mkdirSync(compiledDir, { recursive: true });
    script = join(entryDir, "hello.js");
    writeFileSync(
      script,
      `import { launchSkill } from ${JSON.stringify(pathToFileURL(RUN_JS).href)};\n` +
        "await launchSkill(import.meta.url);\n",
    );
    writeFileSync(join(compiledDir, "hello.js"), 'console.log("compiled-skill-ran");\n');
    // The repo's package.json declares "type": "module". Without one here, Node walks up from the
    // temp dir to whatever package.json an ancestor holds and warns on stderr when it is typeless.
    writeFileSync(join(tmp, "package.json"), '{ "type": "module" }\n');
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("an entry script loads its compiled module", () => {
    const r = spawnSync("node", [script], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("compiled-skill-ran");
    expect(r.status).toBe(0);
  });
});
