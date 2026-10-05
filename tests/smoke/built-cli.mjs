// Smoke test of the BUILT package: run after `bun run build`, under plain Node, from a clean checkout.
//
//   node tests/smoke/built-cli.mjs
//
// `node dist/harness/cli.js --help` proves only that dist/ loads. The checks here also need the
// repository layout around dist/: the prompts, the skills and package.json are plain files that
// tsc does not emit, and the built code must find them from dist/harness/.
//   1. the driver reads CHARTER.md and MISSION.md from harness/prompts and writes the filled-in
//      MISSION.md into the workspace, then stops at a local model server that is not there;
//   2. a skill script started through its Node shim runs its compiled copy from dist/ and prints
//      what the fixture's expected output says.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "dist", "harness", "cli.js");
const failures = [];

function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failures.push(name);
    if (detail) console.log(detail.replace(/^/gm, "     "));
  }
}

function node(args, options = {}) {
  return spawnSync(process.execPath, args, { encoding: "utf8", cwd: ROOT, timeout: 60_000, ...options });
}

if (!existsSync(CLI)) {
  console.error(`${CLI} is missing: run "bun run build" first`);
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), "vh-smoke-"));
try {
  const help = node([CLI, "--help"]);
  check("cli --help prints the usage", help.status === 0 && help.stderr.includes("usage: veriharness"), help.stderr);

  // 1. prompts: a workspace with two rollouts. Nothing listens on port 1, so the driver stops with
  // exit 2 at the local provider, after it has written MISSION.md.
  const ws = join(scratch, "ws");
  mkdirSync(join(ws, "rollouts", "r1"), { recursive: true });
  mkdirSync(join(ws, "rollouts", "r2"), { recursive: true });
  const driver = node([
    CLI, "driver", ws, "--no-skills", "--env", "none",
    "--provider", "ollama", "--model", "smoke", "--base-url", "http://127.0.0.1:1", "--request-timeout", "2",
  ]);
  check("driver stops at the missing model server with exit 2", driver.status === 2, `${driver.status}\n${driver.stderr}`);
  const missionPath = join(ws, "MISSION.md");
  const mission = existsSync(missionPath) ? readFileSync(missionPath, "utf8") : "";
  check("driver wrote MISSION.md from harness/prompts", mission.length > 0);
  check("MISSION.md counts the two rollouts", /Rollouts: 2\b/.test(mission), mission.slice(0, 200));
  check("MISSION.md has no placeholder left", mission.length > 0 && !mission.includes("{{"), mission.slice(0, 200));

  // 2. a skill: the .js entry finds dist/harness/skills/<skill>/scripts/<script>.js. Without a compiled
  // copy the shim falls back to Bun and then to Node's type stripping, which would hide a missing build,
  // so the compiled file must exist and the shim runs with a PATH that holds Node and nothing else.
  const compiled = join(ROOT, "dist", "harness", "skills", "evidence-docx", "scripts", "docx_text.js");
  check("dist holds the compiled skill script", existsSync(compiled));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.PATH = dirname(process.execPath);
  const fixtures = join(ROOT, "tests", "fixtures", "verify-skills");
  const skill = node([join(ROOT, "harness", "skills", "evidence-docx", "scripts", "docx_text.js"), "view.docx"], {
    cwd: fixtures,
    env,
  });
  const expected = readFileSync(join(fixtures, "view.docx-text.expected.txt"), "utf8");
  const eol = (s) => s.replace(/\r\n/g, "\n").trimEnd();
  check(
    "docx_text.js prints the expected text for view.docx",
    skill.status === 0 && eol(skill.stdout) === eol(expected),
    `status ${skill.status}\n${skill.stderr}\n${skill.stdout.slice(0, 300)}`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} smoke check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke: all checks passed");
