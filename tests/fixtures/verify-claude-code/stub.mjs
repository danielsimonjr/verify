// A stand-in for the `claude` CLI, for tests. No network, no model, no login.
//
// Started as `node stub.mjs <claude arguments>`, which is how the harness's injectable command runs it.
// What it does is set by two environment variables:
//
//   STUB_DIR     a directory it records every call in: calls/<n>.json holds argv, stdin, cwd and the
//                environment. Required.
//   STUB_SCRIPT  a JSON file: { "rules": [ { "match": "<regex on stdin>", "times": N, "action": {...} } ] }.
//                The first rule whose regex matches the prompt and that has not yet fired `times` times
//                (default: always) decides the call. No rule: a plain success.
//
// An action: { "toolUses": [{ "name", "input" }]       assistant events the verifier "made"
//              "writes":   [{ "path", "content" }]     files to create under the cwd, as the tools would
//              "result":   { "is_error", "text" }      the final result event (default: success, "done")
//              "stderr":   "text",  "exit": 0,         what to print on stderr, and the exit code
//              "hang": true,                           print init, then never exit
//              "grandchild": "<path prefix>",          start a detached child; its pid goes to <prefix>.pid
//              "persist": false }                      do not save the session (default: save it)
//
// It also behaves like the real CLI where the harness depends on it: `--resume <id>` fails when no saved
// copy of that session exists, and a saved copy lives at <CLAUDE_CONFIG_DIR>/projects/<project>/<id>.jsonl.

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (argv.includes("--version")) {
  process.stdout.write(`${process.env.STUB_VERSION ?? "9.9.9"} (Claude Code stub)\n`);
  process.exit(0);
}

const stubDir = process.env.STUB_DIR;
if (!stubDir) {
  process.stderr.write("stub: STUB_DIR is not set\n");
  process.exit(99);
}

let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;

const callsDir = join(stubDir, "calls");
mkdirSync(callsDir, { recursive: true });
// Two stubs can start together (the two investigations run in parallel). Each claims its number by creating
// a file that must not exist yet, so no two share one.
function claim(dir, name) {
  for (let k = 0; ; k++) {
    try {
      writeFileSync(join(dir, name(k)), "", { flag: "wx" });
      return k;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
}

const n = claim(callsDir, (k) => `${String(k).padStart(3, "0")}.json`);
writeFileSync(
  join(callsDir, `${String(n).padStart(3, "0")}.json`),
  JSON.stringify({ argv, stdin, cwd: process.cwd(), env: process.env }, null, 1),
);

const script = process.env.STUB_SCRIPT ? JSON.parse(readFileSync(process.env.STUB_SCRIPT, "utf8")) : { rules: [] };
let action = {};
(script.rules ?? []).some((rule, i) => {
  if (rule.match !== undefined && !new RegExp(rule.match).test(stdin)) return false;
  const fired = readdirSync(stubDir).filter((f) => f.startsWith(`rule-${i}.`)).length;
  if (rule.times !== undefined && fired >= rule.times) return false;
  claim(stubDir, (k) => `rule-${i}.${k}.fired`);
  action = rule.action ?? {};
  return true;
});

const sessionId = flag("--session-id") ?? flag("--resume") ?? "00000000-0000-4000-8000-000000000000";
const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".claude");
const project = process.cwd().replace(/[^A-Za-z0-9]/g, "-");
const saved = join(configDir, "projects", project, `${sessionId}.jsonl`);
const savedAnywhere = () => {
  const projects = join(configDir, "projects");
  return existsSync(projects) && readdirSync(projects).some((d) => existsSync(join(projects, d, `${sessionId}.jsonl`)));
};

if (argv.includes("--resume") && !savedAnywhere()) {
  process.stderr.write(`No conversation found with session ID: ${sessionId}\n`);
  process.exit(1);
}
if (argv.includes("--session-id") && savedAnywhere()) {
  process.stderr.write(`Error: Session ID ${sessionId} is already in use.\n`);
  process.exit(1);
}

const emit = (event) => process.stdout.write(JSON.stringify({ session_id: sessionId, ...event }) + "\n");

emit({
  type: "system",
  subtype: "init",
  cwd: process.cwd(),
  model: flag("--model") ?? "stub-model",
  claude_code_version: process.env.STUB_VERSION ?? "9.9.9",
  apiKeySource: process.env.STUB_KEY_SOURCE ?? "none",
  permissionMode: flag("--permission-mode") ?? "default",
  tools: (flag("--tools") ?? "").split(",").filter(Boolean),
  mcp_servers: action.mcpServers ?? [],
  plugins: action.plugins ?? [],
});

if (action.grandchild) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  writeFileSync(`${action.grandchild}.pid`, String(child.pid));
  child.unref();
}

if (action.hang) {
  await new Promise(() => {});
}

for (const w of action.writes ?? []) {
  const target = resolve(process.cwd(), w.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, w.content);
}
for (const [i, tool] of (action.toolUses ?? []).entries()) {
  emit({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${n}_${i}`, name: tool.name, input: tool.input }] },
  });
}

if (action.persist !== false && !argv.includes("--no-session-persistence")) {
  mkdirSync(dirname(saved), { recursive: true });
  appendFileSync(saved, JSON.stringify({ type: "summary", call: n }) + "\n");
}

const result = action.result ?? {};
emit({
  type: "result",
  subtype: result.is_error ? "error_during_execution" : "success",
  is_error: result.is_error === true,
  result: result.text ?? "done",
  num_turns: (action.toolUses ?? []).length + 1,
  total_cost_usd: 0.0123,
});
if (action.stderr) process.stderr.write(action.stderr);
process.exit(action.exit ?? 0);
