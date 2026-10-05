// Bun on Windows throws EEXIST for a recursive mkdir of "." or ".." and ENOENT for "./"
// (oven-sh/bun#44576); Node succeeds. An output directory comes from the command line, so
// `--out .` is an ordinary thing to type. The skill scripts create their output directories through
// one helper that resolves the path first.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(import.meta.dir, "..");
const SKILLS = join(REPO, "harness", "skills");
const HELPER = join(SKILLS, "_shared", "dirs.ts");

const tmp = mkdtempSync(join(tmpdir(), "vh-outdir-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function fresh(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function bun(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, args, { cwd, encoding: "utf8", env, timeout: 60_000 });
}

describe("ensureDir (skills/_shared/dirs.ts)", () => {
  // A subprocess per case: the test process keeps its own working directory.
  const run = (cwd: string, arg: string) =>
    bun(
      [
        "-e",
        `import { ensureDir } from ${JSON.stringify(pathToFileURL(HELPER).href)}; ensureDir(process.argv[1]); console.log("done");`,
        "--",
        arg,
      ],
      cwd,
    );

  for (const arg of [".", "..", "./", ".\\", "./sub", "sub/./deeper", "../sibling-made-by-test"]) {
    test(`accepts ${JSON.stringify(arg)} as the working directory's own, its parent's, or a new path`, () => {
      const cwd = fresh(`cwd-${Buffer.from(arg).toString("hex")}`);
      const r = run(cwd, arg);
      expect(r.stderr).toBe("");
      expect(r.stdout.trim()).toBe("done");
      expect(statSync(resolve(cwd, arg)).isDirectory()).toBe(true);
    });
  }

  test("creates every missing parent", () => {
    const cwd = fresh("parents");
    expect(run(cwd, "a/b/c").stdout.trim()).toBe("done");
    expect(existsSync(join(cwd, "a", "b", "c"))).toBe(true);
  });

  // A recursive mkdir of a Windows drive root throws EPERM in Node and Bun. On Linux `mkdir -p /`
  // succeeds, so this case can fail only on Windows.
  test("accepts the filesystem root, which exists", () => {
    const cwd = fresh("root");
    const r = run(cwd, parse(cwd).root);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("done");
  });
});

describe("no skill script calls mkdirSync recursively on its own", () => {
  function scripts(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return scripts(p);
      return /\.ts$/.test(name) ? [p] : [];
    });
  }

  test("a recursive mkdirSync appears only in the shared helper", () => {
    const hits: string[] = [];
    for (const file of scripts(SKILLS)) {
      if (file === HELPER) continue;
      const text = readFileSync(file, "utf8");
      // mkdirSync(<anything>, { recursive: true }) over one or several lines
      for (const m of text.matchAll(/mkdirSync\([^;]*?recursive:\s*true/gs)) {
        const line = text.slice(0, m.index).split(/\r?\n/).length;
        hits.push(`${relative(REPO, file).replaceAll("\\", "/")}:${line}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("a script given a relative output directory", () => {
  const PAGEPROBE = join(SKILLS, "evidence-patch", "scripts", "pageprobe.ts");
  const PATCHLAB = join(SKILLS, "evidence-patch", "scripts", "patchlab.ts");

  // pageprobe needs a browser that playwright can launch; a hosted runner has none installed.
  const site = fresh("site");
  writeFileSync(join(site, "index.html"), "<!doctype html><title>t</title><body><p>hello</p></body>");
  const control = fresh("control");
  const probe = bun([PAGEPROBE, site, "--out", control], control);
  const haveBrowser = (() => {
    try {
      return Boolean((JSON.parse(probe.stdout) as { screenshot?: string }).screenshot);
    } catch {
      return false;
    }
  })();

  for (const out of [".", "..", "./"]) {
    test.skipIf(!haveBrowser)(`pageprobe --out ${out} writes the screenshot there`, () => {
      const cwd = fresh(`probe-${Buffer.from(out).toString("hex")}`);
      const nested = join(cwd, "nested");
      mkdirSync(nested);
      const r = bun([PAGEPROBE, site, "--out", out], nested);
      expect(r.stderr).not.toMatch(/EEXIST|ENOENT/);
      const rep = JSON.parse(r.stdout) as { screenshot: string; screenshot_error?: string };
      expect(rep.screenshot_error).toBeUndefined();
      expect(statSync(resolve(nested, rep.screenshot)).isFile()).toBe(true);
      expect(resolve(nested, rep.screenshot, "..")).toBe(resolve(nested, out));
    }, 90_000);
  }

  test("patchlab build --out ./lab and --out ../lab2 create the lab beside the base", () => {
    const cwd = fresh("lab");
    const base = join(cwd, "base");
    mkdirSync(base);
    writeFileSync(join(base, "a.txt"), "one\n");
    const patch = join(cwd, "p.patch");
    writeFileSync(patch, "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n");
    const inner = join(cwd, "inner");
    mkdirSync(inner);
    for (const [out, abs] of [
      ["./lab", join(inner, "lab")],
      ["../lab2", join(cwd, "lab2")],
    ] as const) {
      const r = bun([PATCHLAB, "build", "--base", base, "--out", out, `c=${patch}`], inner);
      expect(r.status).toBe(0);
      expect(existsSync(join(abs, "build.json"))).toBe(true);
    }
  }, 60_000); // two Bun starts plus two builds measure 5.0 s on Windows, at Bun's 5 s default
});
