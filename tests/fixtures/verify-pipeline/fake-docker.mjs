// A stand-in for the docker CLI as sb2.ts calls it: `run ... --name NAME ... -v HOST:/stage ...` and
// `kill NAME`. Records every call, then behaves as FAKE_DOCKER_MODE says. Test fixture only.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [sub, ...rest] = process.argv.slice(2);
const capture = process.env.CAPTURE_DIR;
mkdirSync(capture, { recursive: true });
const name = sub === "kill" ? rest[0] : rest[rest.indexOf("--name") + 1];
appendFileSync(join(capture, "docker.jsonl"), JSON.stringify({ sub, name, args: rest, start: Date.now() }) + "\n");

if (sub === "kill") {
  // FAKE_KILL_MS: a daemon that is slow to stop the container. "kill-done" records that it finished.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_KILL_MS ?? 0));
  appendFileSync(join(capture, "docker.jsonl"), JSON.stringify({ sub: "kill-done", name, end: Date.now() }) + "\n");
  process.exit(0);
}

const mode = process.env.FAKE_DOCKER_MODE ?? "ok";
const sleep = Number(process.env.DOCKER_SLEEP_MS ?? 0);
const ok = () => {
  appendFileSync(join(capture, "docker.jsonl"), JSON.stringify({ sub: "done", name, end: Date.now() }) + "\n");
  process.stdout.write("LibreOffice service started\n");
  process.exit(0);
};
if (mode === "ok") setTimeout(ok, sleep);
else if (mode === "hang") setTimeout(() => {}, 60000);
else if (mode === "bad") {
  process.stdout.write("Error [boom] could not open the workbook\n");
  process.exit(1);
} else if (mode === "silent") process.exit(3);
