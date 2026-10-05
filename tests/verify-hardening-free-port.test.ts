// CodeQL py/bind-socket-all-network-interfaces: the free-port probe of the WorkBuddy judge proxy
// bound "" (every interface) just to learn a port number. A probe needs only the loopback address.
// grade/wb.py and its TypeScript port grade/wb.ts each carry one probe, so each gets a test.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { python3 } from "../harness/runtime.ts";

const WB_PY = resolve(import.meta.dir, "../harness/grade/wb.py");
const BENCH_ROOT = resolve(import.meta.dir, "fixtures/verify-core/bench");
const PY_PROBE = join(import.meta.dir, "fixtures/verify-hardening/free_port_probe.py");
const TS_PROBE = join(import.meta.dir, "fixtures/verify-hardening/free-port-probe.ts");

describe("wb.py _free_port", () => {
  test("binds the loopback address only, and returns the port it bound", () => {
    const r = spawnSync(python3(), [PY_PROBE, WB_PY], { encoding: "utf8", windowsHide: true });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { bound: [string, number][]; port: number };
    expect(out.bound.map((b) => b[0])).toEqual(["127.0.0.1"]);
    expect(out.port).toBeGreaterThan(0);
  });
});

describe("wb.ts freePort", () => {
  test("listens on the loopback address only", () => {
    const r = spawnSync(process.execPath, [TS_PROBE], {
      encoding: "utf8",
      env: { ...process.env, VERIHARNESS_BENCH_ROOT: BENCH_ROOT },
    });
    const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "));
    if (!line) throw new Error(`probe gave no result (status ${r.status}):\n${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(line.slice("RESULT ".length)) as { listen: unknown[][]; port: number };
    expect(out.port).toBeGreaterThan(0);
    expect(out.listen).toHaveLength(1);
    expect(out.listen[0]).toContain("127.0.0.1");
  });
});
