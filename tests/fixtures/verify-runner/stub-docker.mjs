// Stand-in for the docker CLI in env-derive tests. It contacts no daemon.
//
//   node stub-docker.mjs [--sleep-ms=N] [--barrier=N] [--existing=a,b] [--fail=a,b] --log=FILE <docker args...>
//
//   image inspect <tag>        exit 0 when <tag> is listed in --existing, else exit 1
//   build -q -t <tag> -        read the Dockerfile from stdin, wait at the barrier, sleep, exit 1
//                              when <tag> is in --fail (with a message on stderr), else exit 0
//
// Every build appends start and end events (with this process's pid) to --log, one JSON per line.
//
// --barrier=N holds each build after its start event until N start events are in the log, so no
// build ends before N have started. A pool that runs N builds at once then always shows N open,
// whatever the host's speed. A pool that runs fewer can never reach N: the first build to wait
// BARRIER_MS logs a gave-up event, and every later build skips the wait, so the run still ends.
import { appendFileSync, readFileSync } from "node:fs";

const BARRIER_MS = 10_000;

const opts = {};
const rest = [];
for (const arg of process.argv.slice(2)) {
  const m = /^--([a-z-]+)=(.*)$/.exec(arg);
  if (m && rest.length === 0) opts[m[1]] = m[2];
  else rest.push(arg);
}
const list = (v) => (v ? v.split(",") : []);
const log = (event) => appendFileSync(opts.log, JSON.stringify({ pid: process.pid, t: Date.now(), ...event }) + "\n");

/** The parsed log events. A line that another build is still appending does not parse and is skipped. */
function logged() {
  const out = [];
  for (const line of readFileSync(opts.log, "utf8").split("\n")) {
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/** Calls done once N builds have started, or once some build has given up waiting. */
function barrier(n, done) {
  const deadline = Date.now() + BARRIER_MS;
  const poll = () => {
    const evs = logged();
    if (evs.some((e) => e.ev === "gave-up") || evs.filter((e) => e.ev === "start").length >= n) return done();
    if (Date.now() >= deadline) {
      log({ ev: "gave-up" });
      return done();
    }
    setTimeout(poll, 10);
  };
  poll();
}

if (rest[0] === "image" && rest[1] === "inspect") {
  process.exit(list(opts.existing).includes(rest[2]) ? 0 : 1);
}

if (rest[0] === "build") {
  const tag = rest[rest.indexOf("-t") + 1];
  let dockerfile = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (dockerfile += d));
  process.stdin.on("end", () => {
    log({ ev: "start", tag, dockerfile });
    barrier(Number(opts.barrier ?? 0), () =>
      setTimeout(() => {
        log({ ev: "end", tag });
        if (list(opts.fail).includes(tag)) {
          process.stderr.write(`step 1/2 failed\n${"x".repeat(300)}\nboom: ${tag}\n`);
          process.exit(1);
        }
        process.exit(0);
      }, Number(opts["sleep-ms"] ?? 0)),
    );
  });
} else {
  process.stderr.write(`stub-docker: unsupported command: ${rest.join(" ")}\n`);
  process.exit(2);
}
