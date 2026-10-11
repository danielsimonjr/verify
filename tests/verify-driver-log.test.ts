import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { log, logStamp } from "../harness/driver.ts";

describe("driver.log time stamp", () => {
  test("a stamp is local time with its UTC offset, so it reads the same as the clock on the wall", () => {
    const at = new Date("2026-10-11T11:56:02Z");
    expect(logStamp(at, -300)).toBe("2026-10-11 06:56:02-05:00");
    expect(logStamp(at, 0)).toBe("2026-10-11 11:56:02+00:00");
    expect(logStamp(at, 330)).toBe("2026-10-11 17:26:02+05:30");
  });

  test("a stamp that crosses midnight moves the date with the offset", () => {
    const at = new Date("2026-10-11T02:30:00Z");
    expect(logStamp(at, -300)).toBe("2026-10-10 21:30:00-05:00");
    expect(logStamp(at, 600)).toBe("2026-10-11 12:30:00+10:00");
  });

  describe("log()", () => {
    let ws: string;
    beforeEach(() => {
      ws = mkdtempSync(join(tmpdir(), "vlog-"));
    });
    afterEach(() => rmSync(ws, { recursive: true, force: true }));

    test("a line starts with a stamp that names the instant it was written", () => {
      const before = Date.now();
      log(ws, "hello");
      const after = Date.now();
      const line = readFileSync(join(ws, "driver.log"), "utf8").trimEnd();
      const m = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})([+-]\d{2}:\d{2})\] hello$/.exec(line);
      expect(m).not.toBeNull();
      const at = Date.parse(`${m![1]}T${m![2]}${m![3]}`);
      // The stamp has whole seconds: it may be up to a second before the call began.
      expect(at).toBeGreaterThanOrEqual(before - 1000);
      expect(at).toBeLessThanOrEqual(after);
    });
  });
});
