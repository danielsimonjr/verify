import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// These tests run harness/scripts/jail_run.sh with stand-ins for unshare, mount, umount and setpriv.
// They check the script's logic: what it refuses, which mounts it asks for and in what order, how it
// hands the command over. They do NOT check what the kernel does with those mounts: that needs Linux
// with unprivileged user namespaces, and a host without them cannot run the real jail.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO, "harness", "scripts", "jail_run.sh");

const posix = (p: string): string =>
  process.platform === "win32" ? p.replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`).replaceAll("\\", "/") : p;

/** True when a POSIX bash is on PATH. On Windows that means Git Bash, not the WSL launcher. */
function haveBash(): boolean {
  const r = spawnSync("bash", ["-c", "uname -s"], { encoding: "utf8", timeout: 20_000 });
  if (r.status !== 0) return false;
  return process.platform !== "win32" || /^(MINGW|MSYS|CYGWIN)/.test(r.stdout.trim());
}

const shell = haveBash();
if (!shell) console.log("verify-driver-jail: skipped: no POSIX bash on PATH (on Windows run the tests from Git Bash)");
// A script run through Git Bash starts several processes; the default 5 s test limit is too short there.
const shellTest = (name: string, fn: () => void): void => {
  if (shell) test(name, fn, 90_000);
  else test.skip(name, fn);
};

// The jail refuses a workspace under /tmp, so the scratch tree must live elsewhere: runs/ is git-ignored.
const runsDir = join(REPO, "runs");
mkdirSync(runsDir, { recursive: true });
const root = mkdtempSync(join(runsDir, ".vd-jail-"));
const home = join(root, "home");
const harness = join(root, "fake", "harness");
const ws = join(root, "fake", "runs", "ws1");
const binDir = join(root, "bin");
for (const d of [home, join(harness, "scripts"), join(harness, "vendor"), join(harness, "pi-home"), join(harness, "skills"), ws, binDir]) {
  mkdirSync(d, { recursive: true });
}
const script = join(harness, "scripts", "jail_run.sh");
// A Windows checkout with core.autocrlf turns the script into CRLF, which bash cannot run: copy it as LF.
const scriptText = readFileSync(SCRIPT, "utf8").replaceAll("\r\n", "\n");
writeFileSync(script, scriptText);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  // The script makes its stage directory in the real /tmp before it covers it, and the stand-in mount
  // covers nothing, so empty directories stay behind. On Windows (Git Bash) nothing else uses them.
  if (shell && process.platform === "win32") {
    const dirs = ["ws", "gcloud", "vendor", "pihome", "skills", "worlds", "browsers"].map((d) => `/tmp/vh_stage/${d}`);
    spawnSync("bash", ["-c", `rmdir ${dirs.join(" ")} /tmp/vh_stage 2>/dev/null; true`]);
  }
  try {
    rmdirSync(runsDir); // only if this test created it and nothing else is in it
  } catch {
    /* not empty: someone else's runs live there */
  }
});

function stub(name: string, body: string, dir = binDir): void {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/bash\n${body}\n`);
  chmodSync(p, 0o755);
}

// unshare: record the flags, define mount and umount as functions that record their calls (a fresh bash
// per call is far too slow on Windows), then run what follows the flags (the jail's own bash) as the
// real one would. A call fails when it matches VH_FAIL_MOUNT.
stub(
  "unshare",
  `flags=()
while [ "$#" -gt 0 ] && [ "$1" != /bin/bash ]; do flags+=("$1"); shift; done
echo "unshare \${flags[*]}" >> "$VH_LOG"
mount() { echo "mount $*" >> "$VH_LOG"; if [ -n "\${VH_FAIL_MOUNT:-}" ] && [[ "$*" == *"$VH_FAIL_MOUNT"* ]]; then return 1; fi; }
umount() { echo "umount $*" >> "$VH_LOG"; }
export -f mount umount
exec "$@"`,
);
// setpriv: record each argument in brackets so argument boundaries show, and stop there.
stub(
  "setpriv",
  `line="setpriv"
for a in "$@"; do line="$line [$a]"; done
echo "$line" >> "$VH_LOG"`,
);

let runNo = 0;
type Result = { status: number | null; stderr: string; log: string[] };

function runJail(args: string[], env: Record<string, string> = {}, path: string[] = []): Result {
  const log = join(root, `log${runNo++}.txt`);
  writeFileSync(log, "");
  const r = spawnSync("bash", [posix(script), ...args], {
    encoding: "utf8",
    timeout: 60_000,
    cwd: root, // a relative path in the hide list would be looked up here
    env: {
      ...process.env,
      HOME: posix(home),
      VH_LOG: posix(log),
      VERIHARNESS_JAIL_HIDE: "",
      PATH: [binDir, ...path, process.env.PATH ?? ""].join(delimiter),
      ...env,
    },
  });
  return { status: r.status, stderr: r.stderr, log: readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

function once<T>(fn: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = fn();
      done = true;
    }
    return value;
  };
}

const wsArg = posix(ws);
const lc = (lines: string[]): string[] => lines.map((l) => l.toLowerCase());
const at = (lines: string[], text: string): number => lc(lines).findIndex((l) => l === text.toLowerCase());

describe("jail_run.sh: syntax", () => {
  shellTest("the script and the script it hands to the jail both parse", () => {
    const inner = scriptText.match(/<<'JAIL'\n([\s\S]*?)\nJAIL\n/);
    expect(inner).not.toBeNull();
    const innerFile = join(root, "inner.sh");
    writeFileSync(innerFile, inner![1]!);
    for (const f of [script, innerFile]) {
      const r = spawnSync("bash", ["-n", posix(f)], { encoding: "utf8" });
      expect({ file: f, status: r.status, stderr: r.stderr }).toEqual({ file: f, status: 0, stderr: "" });
    }
  });
});

describe("jail_run.sh: arguments", () => {
  shellTest("no arguments is a usage error, not an unbound-variable crash", () => {
    const r = runJail([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage");
    expect(r.log).toEqual([]);
  });

  shellTest("a workspace without a command is refused instead of mounting everything and doing nothing", () => {
    const r = runJail([wsArg]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage");
    expect(r.log).toEqual([]);
  });

  shellTest("a workspace under /tmp is refused: the jail hides /tmp after it has mounted the workspace", () => {
    const made = spawnSync("bash", ["-c", "mktemp -d /tmp/vd-jail-ws.XXXXXX"], { encoding: "utf8" });
    const tmpWs = made.stdout.trim();
    try {
      expect(tmpWs.startsWith("/tmp/")).toBe(true);
      const r = runJail([tmpWs, "true"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("/tmp");
      expect(r.log).toEqual([]);
    } finally {
      spawnSync("bash", ["-c", `rmdir "${tmpWs}"`]);
    }
  });
});

// One run answers several questions: the command line, the order of the mounts, the hide list, Node.
describe("jail_run.sh: a normal run", () => {
  const hideA = join(root, "hideA");
  const hideB = join(root, "hideB");
  const nodePrefix = join(root, "nodeprefix");
  for (const d of [hideA, hideB, join(nodePrefix, "bin")]) mkdirSync(d, { recursive: true });
  stub("node", "exit 0", join(nodePrefix, "bin"));
  // No quote or wildcard characters: Git Bash re-parses the Windows command line and would eat or expand them.
  const argv = ["echo", "a b", "", "--flag", "$HOME", "x;y"];
  const run = once(() =>
    runJail([wsArg, ...argv], { VERIHARNESS_JAIL_HIDE: [posix(hideA), posix(hideB)].join("\n") }, [join(nodePrefix, "bin")]),
  );

  shellTest("exits 0 and starts unshare with the isolation flags", () => {
    expect(run().status).toBe(0);
    expect(run().log[0]).toBe("unshare -r -m -p -f --mount-proc --kill-child");
  });

  shellTest("hands the command to setpriv unchanged, with every capability dropped", () => {
    expect(run().log.at(-1)).toBe(
      "setpriv [--bounding-set=-all] [--inh-caps=-all] [--no-new-privs] [--] [echo] [a b] [] [--flag] [$HOME] [x;y]",
    );
  });

  shellTest("drops privileges last: nothing is mounted after it, and it runs once", () => {
    const log = run().log;
    expect(log.filter((l) => l.startsWith("setpriv"))).toHaveLength(1);
    expect(log.findIndex((l) => l.startsWith("setpriv"))).toBe(log.length - 1);
  });

  shellTest("hides each listed directory before the workspace is mounted back", () => {
    const log = run().log;
    const a = at(log, `mount -t tmpfs tmpfs ${posix(hideA)}`);
    const b = at(log, `mount -t tmpfs tmpfs ${posix(hideB)}`);
    const back = lc(log).findIndex((l) => l.startsWith("mount --rbind /tmp/vh_stage/ws "));
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(back).toBeGreaterThan(b);
  });

  shellTest("binds Node's install directory read-only, as the header says", () => {
    const log = run().log;
    const p = posix(nodePrefix);
    const bound = at(log, `mount --rbind ${p} ${p}`);
    expect(bound).toBeGreaterThan(-1);
    expect(at(log, `mount -o remount,bind,ro ${p}`)).toBeGreaterThan(bound);
  });
});

describe("jail_run.sh: what it must not cover or change", () => {
  const inHome = join(home, "inhome");
  mkdirSync(inHome, { recursive: true });
  mkdirSync(join(root, "reldir"), { recursive: true }); // exists, so only the "absolute paths only" rule keeps it out

  shellTest("skips /, a relative path, a missing directory and anything under $HOME; leaves a prefix of /usr alone", () => {
    const pyDir = join(root, "pybin-usr");
    mkdirSync(pyDir, { recursive: true });
    stub("python3", "echo /usr", pyDir);
    const list = ["/", "reldir", posix(join(root, "missing")), posix(inHome), ""].join("\n");
    const r = runJail([wsArg, "true"], { VERIHARNESS_JAIL_HIDE: list }, [pyDir]);
    expect(r.status).toBe(0);
    const covers = r.log.filter((l) => l.startsWith("mount -t tmpfs tmpfs "));
    expect(covers).not.toContain("mount -t tmpfs tmpfs /");
    expect(covers.filter((l) => /reldir|missing|inhome/.test(l))).toEqual([]);
    expect(r.log).not.toContain("mount --rbind /usr /usr");
  });

  shellTest("binds Python's prefix read-only", () => {
    const prefix = join(root, "pyprefix");
    const pyDir = join(root, "pybin");
    mkdirSync(prefix, { recursive: true });
    mkdirSync(pyDir, { recursive: true });
    stub("python3", `echo "${posix(prefix)}"`, pyDir);
    const r = runJail([wsArg, "true"], {}, [pyDir]);
    const p = posix(prefix);
    const bound = at(r.log, `mount --rbind ${p} ${p}`);
    expect(bound).toBeGreaterThan(-1);
    expect(at(r.log, `mount -o remount,bind,ro ${p}`)).toBeGreaterThan(bound);
  });
});

describe("jail_run.sh: a read-only remount that fails", () => {
  shellTest("is reported on stderr and the run carries on", () => {
    mkdirSync(join(home, ".config", "gcloud"), { recursive: true });
    const r = runJail([wsArg, "true"], { VH_FAIL_MOUNT: "remount,bind,ro" });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("gcloud");
    expect(r.stderr).toContain("could not be made read-only");
    expect(r.log.at(-1)!.startsWith("setpriv")).toBe(true);
  });
});
