// JavaScript's split(sep, n) is not Python's split(sep, maxsplit) or partition: the limit TRUNCATES the
// result, so "a=b=c".split("=", 2) is ["a", "b"] and "=c" is lost. The ports must split once at the
// first separator instead (fsutil.partition, or pytext.splitFirst in the skill scripts).
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const tmp = mkdtempSync(join(tmpdir(), "vh-partition-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("patchlab build keeps everything after the first '=' of NAME=PATCH", () => {
  test("a patch path that contains '=' is read whole", () => {
    const base = join(tmp, "base");
    mkdirSync(base);
    writeFileSync(join(base, "a.txt"), "one\n");
    // Windows and POSIX both allow '=' in a file name. The old split("=", 2) read "…/fix" and stopped.
    const patch = join(tmp, "fix=1=final.patch");
    writeFileSync(
      patch,
      ["diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-one", "+two", ""].join("\n"),
    );
    const out = join(tmp, "lab");
    const script = join(REPO, "harness/skills/evidence-patch/scripts/patchlab.ts");
    const r = spawnSync(process.execPath, [script, "build", "--base", base, "--out", out, `cand=${patch}`], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const built = JSON.parse(readFileSync(join(out, "build.json"), "utf8")) as Record<
      string,
      { applied: boolean; files: string[]; stderr: string }
    >;
    expect(Object.keys(built)).toEqual(["cand"]);
    expect(built.cand!.stderr).toBe("");
    expect(built.cand!.applied).toBe(true);
    expect(built.cand!.files).toEqual(["a.txt"]);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "node_modules" || name === "vendor" || name === "dist") return [];
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|js|mjs)$/.test(name) ? [p] : [];
  });
}

describe("no TypeScript or JavaScript split(sep, n) that truncates", () => {
  // split(sep, 1)[0] is the first piece and is correct; any other limit drops text.
  const LIMITED_SPLIT = /\.split\(\s*(?:"[^"]*"|'[^']*'|`[^`]*`|\/(?:\\.|[^/\\\n])+\/[a-z]*)\s*,\s*[0-9a-zA-Z_.]+\s*\)(?!\s*\[0\])/;

  test("the harness has none", () => {
    const hits: string[] = [];
    for (const file of sourceFiles(join(REPO, "harness"))) {
      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          const code = line.trimStart();
          if (code.startsWith("*") || code.startsWith("//")) return; // prose that names the pitfall
          if (LIMITED_SPLIT.test(line)) hits.push(`${relative(REPO, file).replaceAll("\\", "/")}:${i + 1}: ${code}`);
        });
    }
    expect(hits).toEqual([]);
  });

  test("the pattern catches the shapes it is meant to", () => {
    for (const bad of [
      'x.split("=", 2)',
      "x.split('__', 2)",
      "x.split(/=/, 2)",
      'x.split("=", n)',
      'const [k, v] = line.split(":", 2);',
      "x.split(/\\s+/, 2)", // a regex literal with an escape in it
      "x.split(/\\//, 2)", // an escaped slash does not end the literal
    ]) {
      expect(LIMITED_SPLIT.test(bad)).toBe(true);
    }
    for (const fine of [
      'x.split("=")',
      'x.split(/[?#]/, 1)[0]',
      'x.split(",").map(f)',
      "x.split(a, b)",
      "x.split(/\\s+/)[0]",
      "x.split(/\\r?\\n/)",
    ]) {
      expect(LIMITED_SPLIT.test(fine)).toBe(false);
    }
  });

  test("the pattern runs in linear time on a long run of dots (CodeQL js/redos)", () => {
    const hostile = ".split(/" + ".".repeat(50_000);
    const t0 = performance.now();
    expect(LIMITED_SPLIT.test(hostile)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
