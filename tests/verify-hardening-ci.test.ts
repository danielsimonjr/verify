// The CI workflow is code: these checks keep it from losing what it was given.
//   - every action is pinned to a commit SHA (Dependabot moves the pins; a tag could be moved by anyone);
//   - the build job runs on Linux AND Windows, does not stop one when the other fails, builds, and
//     smoke-runs the built CLI;
//   - the jail job runs the real-kernel check on Linux, and that check really is in the repo.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const WORKFLOWS = join(REPO, ".github", "workflows");

type Step = { name?: string; uses?: string; run?: string };
type Job = { "runs-on": string; strategy?: { "fail-fast"?: boolean; matrix?: { os?: string[] } }; steps: Step[] };
const ci = Bun.YAML.parse(readFileSync(join(WORKFLOWS, "ci.yml"), "utf8")) as { jobs: Record<string, Job> };

describe("workflows", () => {
  test("every `uses:` is pinned to a 40-character commit SHA", () => {
    const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    const unpinned: string[] = [];
    for (const file of files) {
      for (const [i, line] of readFileSync(join(WORKFLOWS, file), "utf8").split(/\r?\n/).entries()) {
        const m = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(line);
        if (m && !/^\.\//.test(m[1]!) && !/@[0-9a-f]{40}$/.test(m[1]!)) unpinned.push(`${file}:${i + 1} ${m[1]}`);
      }
    }
    expect(unpinned).toEqual([]);
  });
});

describe("ci.yml build job", () => {
  const job = ci.jobs.build!;
  const commands = job.steps.map((s) => s.run ?? "");

  test("runs on Linux and Windows, and one failing does not cancel the other", () => {
    expect(job.strategy?.matrix?.os).toEqual(expect.arrayContaining(["ubuntu-latest", "windows-latest"]));
    expect(job.strategy?.["fail-fast"]).toBe(false);
    expect(job["runs-on"]).toContain("matrix.os");
  });

  test("typechecks, tests, builds, then smoke-runs the built CLI", () => {
    const at = (needle: string) => commands.findIndex((c) => c.includes(needle));
    expect(at("bun install --frozen-lockfile")).toBeGreaterThanOrEqual(0);
    expect(at("bun run typecheck")).toBeGreaterThan(at("bun install"));
    expect(at("bun run test")).toBeGreaterThan(at("bun run typecheck"));
    expect(at("bun run build")).toBeGreaterThan(at("bun run test"));
    expect(at("node tests/smoke/built-cli.mjs")).toBeGreaterThan(at("bun run build"));
  });

  // The suite's test timeout is the --timeout flag in the `test` script; a bare `bun test` runs
  // without it, at Bun's 5 s default.
  test("no step in any job runs a bare `bun test`", () => {
    const all = Object.values(ci.jobs).flatMap((j) => j.steps.map((s) => s.run ?? ""));
    expect(all.filter((run) => /(^|[\n;&|]\s*)bun test\b/.test(run))).toEqual([]);
  });

  test("installs the Node the built CLI runs on", () => {
    expect(job.steps.some((s) => (s.uses ?? "").startsWith("actions/setup-node@"))).toBe(true);
  });

  test("the smoke script it runs exists", () => {
    expect(existsSync(join(REPO, "tests", "smoke", "built-cli.mjs"))).toBe(true);
  });
});

describe("ci.yml jail job", () => {
  const job = ci.jobs.jail!;

  test("runs the real-kernel check on Linux", () => {
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job.steps.some((s) => (s.run ?? "").includes("tests/jail/check.sh"))).toBe(true);
    expect(existsSync(join(REPO, "tests", "jail", "check.sh"))).toBe(true);
    expect(existsSync(join(REPO, "tests", "jail", "probe.sh"))).toBe(true);
  });

  test("lifts the user-namespace restriction before the check, not after", () => {
    const runs = job.steps.map((s) => s.run ?? "");
    const sysctl = runs.findIndex((c) => c.includes("apparmor_restrict_unprivileged_userns=0"));
    expect(sysctl).toBeGreaterThanOrEqual(0);
    expect(runs.findIndex((c) => c.includes("tests/jail/check.sh"))).toBeGreaterThan(sysctl);
  });
});

describe("tests/jail/check.sh", () => {
  const script = readFileSync(join(REPO, "tests", "jail", "check.sh"), "utf8");
  const probe = readFileSync(join(REPO, "tests", "jail", "probe.sh"), "utf8");

  test("asks every question of the probe that it expects an answer to", () => {
    const asked = [...probe.matchAll(/^r (\w+) /gm)].map((m) => m[1]!);
    expect(asked.length).toBeGreaterThanOrEqual(8);
    for (const key of [...asked, "capeff", "nnp"]) expect(script).toContain(`expect "$OUT" ${key} `);
  });

  test("has a control that proves the probe can see a broken jail", () => {
    expect(script).toContain("remount_spec_rw yes");
    expect(script).toContain("umount_cover yes");
  });
});
