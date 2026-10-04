// Stand-in for the docker CLI in env-derive tests. It contacts no daemon.
//
//   node stub-docker.mjs [--sleep-ms=N] [--existing=a,b] [--fail=a,b] --log=FILE <docker args...>
//
//   image inspect <tag>        exit 0 when <tag> is listed in --existing, else exit 1
//   build -q -t <tag> -        read the Dockerfile from stdin, sleep, exit 1 when <tag> is in
//                              --fail (with a message on stderr), else exit 0
//
// Every build appends start and end events (with this process's pid) to --log, one JSON per line.
import { appendFileSync } from "node:fs";

const opts = {};
const rest = [];
for (const arg of process.argv.slice(2)) {
  const m = /^--([a-z-]+)=(.*)$/.exec(arg);
  if (m && rest.length === 0) opts[m[1]] = m[2];
  else rest.push(arg);
}
const list = (v) => (v ? v.split(",") : []);
const log = (event) => appendFileSync(opts.log, JSON.stringify({ pid: process.pid, t: Date.now(), ...event }) + "\n");

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
    setTimeout(() => {
      log({ ev: "end", tag });
      if (list(opts.fail).includes(tag)) {
        process.stderr.write(`step 1/2 failed\n${"x".repeat(300)}\nboom: ${tag}\n`);
        process.exit(1);
      }
      process.exit(0);
    }, Number(opts["sleep-ms"] ?? 0));
  });
} else {
  process.stderr.write(`stub-docker: unsupported command: ${rest.join(" ")}\n`);
  process.exit(2);
}
