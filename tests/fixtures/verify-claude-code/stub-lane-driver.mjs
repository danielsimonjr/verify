// A stand-in for the driver in runner tests of the Claude Code lanes. It contacts no model.
//
//   node stub-lane-driver.mjs <ws> <sleep-ms> <flags-json>
//
// It records the flags the runner gave the driver and when it started, waits, and then does what the
// environment says for this task (the task key is the name of the workspace directory):
//
//   STUB_LIMIT_KEYS  comma-separated task keys that end on a usage limit: exit code 75, no finish.json
//   STUB_FAIL_KEYS   comma-separated task keys that end with exit code 1 and no finish.json
//
// Every other task writes finish.json, as the real driver does when a task completes.
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [ws, sleepMs, flagsJson] = process.argv.slice(2);
const key = basename(ws);
const listed = (name) => (process.env[name] ?? "").split(",").filter(Boolean);

writeFileSync(join(ws, "launch.json"), JSON.stringify({ startedAt: Date.now(), flags: JSON.parse(flagsJson) }));
setTimeout(() => {
  if (listed("STUB_LIMIT_KEYS").includes(key)) process.exit(75);
  if (listed("STUB_FAIL_KEYS").includes(key)) process.exit(1);
  writeFileSync(join(ws, "finish.json"), JSON.stringify({ finishedAt: Date.now() }));
}, Number(sleepMs));
