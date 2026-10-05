// Dependabot alert #1 (fast-xml-parser, GHSA-gh4j-gqv2-49f6), and the rule that keeps the two lockfiles
// honest: package-lock.json (npm) and bun.lock (bun) must resolve the same version of every direct
// dependency, and neither may hold a copy in an advisory range.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

/** Versions that an advisory marks vulnerable, as semver ranges (the GitHub advisory data). */
const VULNERABLE: Record<string, string> = {
  "fast-xml-parser": "<5.7.0",
};

type Resolved = { path: string; name: string; version: string };

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const direct = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });

/** Every installed package in package-lock.json, nested copies included. */
function npmLock(): Resolved[] {
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string }>;
  };
  return Object.entries(lock.packages)
    .filter(([path, p]) => path !== "" && p.version)
    .map(([path, p]) => ({
      path,
      name: path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length),
      version: p.version!,
    }));
}

/** Every package in bun.lock (JSONC): the key is the install path, entry [0] is "name@version". */
function bunLock(): Resolved[] {
  const lock = Bun.JSONC.parse(readFileSync(join(ROOT, "bun.lock"), "utf8")) as {
    packages: Record<string, [string, ...unknown[]]>;
  };
  return Object.entries(lock.packages).map(([path, entry]) => {
    const id = entry[0];
    const at = id.lastIndexOf("@");
    return { path, name: id.slice(0, at), version: id.slice(at + 1) };
  });
}

/** The version that node_modules actually holds for a top-level package. */
function installed(name: string): string {
  const p = JSON.parse(readFileSync(join(ROOT, "node_modules", name, "package.json"), "utf8"));
  return p.version as string;
}

describe("advisory ranges", () => {
  for (const [label, copies] of [
    ["package-lock.json", npmLock],
    ["bun.lock", bunLock],
  ] as const) {
    test(`${label} holds no copy in an advisory range`, () => {
      const bad = copies()
        .filter((c) => VULNERABLE[c.name] && Bun.semver.satisfies(c.version, VULNERABLE[c.name]!))
        .map((c) => `${c.path}@${c.version}`);
      expect(bad).toEqual([]);
    });
  }

  test("node_modules holds no copy in an advisory range", () => {
    for (const name of Object.keys(VULNERABLE)) {
      expect(Bun.semver.satisfies(installed(name), VULNERABLE[name]!)).toBe(false);
    }
  });
});

describe("the two lockfiles agree", () => {
  test("every direct dependency resolves to the same version in both", () => {
    const npm = new Map(npmLock().filter((c) => c.path === `node_modules/${c.name}`).map((c) => [c.name, c.version]));
    const bun = new Map(bunLock().filter((c) => c.path === c.name).map((c) => [c.name, c.version]));
    const npmView = Object.fromEntries(direct.map((d) => [d, npm.get(d)]));
    const bunView = Object.fromEntries(direct.map((d) => [d, bun.get(d)]));
    expect(npmView).toEqual(bunView);
    for (const d of direct) expect(npmView[d]).toBeDefined();
  });

  test("every direct dependency resolves inside its package.json range", () => {
    const npm = new Map(npmLock().filter((c) => c.path === `node_modules/${c.name}`).map((c) => [c.name, c.version]));
    const ranges = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const d of direct) expect(Bun.semver.satisfies(npm.get(d)!, ranges[d]!)).toBe(true);
  });
});
