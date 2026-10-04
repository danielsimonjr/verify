import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasSessionFile, isTransient } from "../harness/driver.ts";

const scratch = mkdtempSync(join(tmpdir(), "vd-driver-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("isTransient", () => {
  test("recognises provider and transport faults", () => {
    expect(isTransient("HTTP 503 Service Unavailable")).toBe(true);
    expect(isTransient('{"error":{"code":429}}')).toBe(true);
    expect(isTransient("status 529.")).toBe(true);
    expect(isTransient("read ECONNRESET")).toBe(true);
    expect(isTransient("model is overloaded")).toBe(true);
  });

  test("a status code inside a larger number or a path is not a fault", () => {
    expect(isTransient("context was 41503 tokens, limit 32000")).toBe(false);
    expect(isTransient("score 0.429 on rubric")).toBe(false);
    expect(isTransient("wrote /tmp/run-1529/out.json")).toBe(false);
    expect(isTransient("TypeError: x is not a function")).toBe(false);
  });
});

describe("hasSessionFile", () => {
  test("a missing directory has no session, instead of throwing", () => {
    expect(hasSessionFile(join(scratch, "does-not-exist"))).toBe(false);
  });

  test("true only for a .jsonl file", () => {
    const dir = join(scratch, "session");
    mkdirSync(dir);
    expect(hasSessionFile(dir)).toBe(false);
    writeFileSync(join(dir, "notes.txt"), "x");
    expect(hasSessionFile(dir)).toBe(false);
    mkdirSync(join(dir, "nested.jsonl"));
    expect(hasSessionFile(dir)).toBe(false);
    writeFileSync(join(dir, "2026.jsonl"), "{}\n");
    expect(hasSessionFile(dir)).toBe(true);
  });
});
