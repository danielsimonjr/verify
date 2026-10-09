import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assertTagMatchesPackageVersion, versionFromTag } from "../scripts/publish-version-guard.mjs";

const SCRIPT = join(import.meta.dir, "..", "scripts", "publish-version-guard.mjs");
const VERSION = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version as string;

describe("publish version guard", () => {
  test("a v* tag or its refs/tags form gives the version; anything else gives null", () => {
    expect(versionFromTag("v1.2.3")).toBe("1.2.3");
    expect(versionFromTag("refs/tags/v1.2.3")).toBe("1.2.3");
    for (const bad of ["", "v", "1.2.3", "main", "refs/heads/main"]) expect(versionFromTag(bad)).toBeNull();
  });

  test("the tag must name package.json's version", () => {
    expect(assertTagMatchesPackageVersion("v1.2.3", "1.2.3").ok).toBe(true);
    expect(assertTagMatchesPackageVersion("v1.2.4", "1.2.3").ok).toBe(false);
    expect(assertTagMatchesPackageVersion("main", "1.2.3").ok).toBe(false);
  });

  test("the script exits 0 for this checkout's version and 1 for another", () => {
    expect(spawnSync(process.execPath, [SCRIPT, `v${VERSION}`]).status).toBe(0);
    expect(spawnSync(process.execPath, [SCRIPT, "v0.0.0-not-this"]).status).toBe(1);
  });
});
