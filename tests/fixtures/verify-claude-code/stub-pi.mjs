// A stand-in for the `pi` agent runtime, for tests. No network, no model.
//
// Started as `node stub-pi.mjs <pi arguments>`, the way the harness's injectable pi command runs it.
// It is driven by the same two environment variables as stub.mjs:
//
//   STUB_DIR     where it records calls/<n>.json: argv, stdin, the message as pi would see it, cwd, how the
//                message arrived (`argv`, `stdin` or `file`), and the length of the longest argument.
//   STUB_SCRIPT  { "rules": [ { "match": "<regex on the message>", "times": N, "action": {...} } ] }
//
// An action: { "toolUses": [{ "name", "arguments" }]  toolCall lines it writes to its session transcript
//              "writes":   [{ "path", "content" }]    files to create under the cwd
//              "stderr": "text", "exit": 0            what to print on stderr, and the exit code
//              "removeSessionDir": true }             delete the --session-dir first (a failed start)
//
// pi's own transcript is `<session-dir>/<timestamp>_<id>.jsonl`, one JSON object per line, and a tool call is
// `{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","name","arguments"}]}}`.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const stubDir = process.env.STUB_DIR;
if (!stubDir) {
  process.stderr.write("stub-pi: STUB_DIR is not set\n");
  process.exit(99);
}

let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;

// The message is stdin, then what follows `--`; an `@file` argument is replaced by that file's text.
const dashes = argv.indexOf("--");
const tail = dashes >= 0 ? argv.slice(dashes + 1).join("\n") : "";
let via = "argv";
let message = tail;
if (tail.startsWith("@") && existsSync(tail.slice(1))) {
  via = "file";
  message = readFileSync(tail.slice(1), "utf8");
} else if (stdin !== "") {
  via = "stdin";
  message = stdin + (tail === "" ? "" : "\n" + tail);
}

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
  JSON.stringify(
    { argv, stdin, message, via, cwd: process.cwd(), longestArgument: Math.max(0, ...argv.map((a) => a.length)) },
    null,
    1,
  ),
);

const script = process.env.STUB_SCRIPT ? JSON.parse(readFileSync(process.env.STUB_SCRIPT, "utf8")) : { rules: [] };
let action = {};
(script.rules ?? []).some((rule, i) => {
  if (rule.match !== undefined && !new RegExp(rule.match).test(message)) return false;
  const fired = readdirSync(stubDir).filter((f) => f.startsWith(`rule-${i}.`)).length;
  if (rule.times !== undefined && fired >= rule.times) return false;
  claim(stubDir, (k) => `rule-${i}.${k}.fired`);
  action = rule.action ?? {};
  return true;
});

const sessionDir = flag("--session-dir");
if (action.removeSessionDir && sessionDir) rmSync(sessionDir, { recursive: true, force: true });
if (action.stderr) process.stderr.write(action.stderr);
if (action.exit) process.exit(action.exit);

for (const w of action.writes ?? []) {
  const target = resolve(process.cwd(), w.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, w.content);
}
if (sessionDir) {
  mkdirSync(sessionDir, { recursive: true });
  const transcript = join(sessionDir, "2026-01-01T00-00-00-000Z_stub.jsonl");
  appendFileSync(transcript, JSON.stringify({ type: "session", id: "stub" }) + "\n");
  for (const [i, tool] of (action.toolUses ?? []).entries()) {
    appendFileSync(
      transcript,
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", id: `call_${n}_${i}`, name: tool.name, arguments: tool.arguments }] },
      }) + "\n",
    );
  }
}
if (action.delayMs) await new Promise((done) => setTimeout(done, Number(action.delayMs)));
process.exit(0);
