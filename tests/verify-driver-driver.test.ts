import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { changedFiles, completeBundle, hasSessionFile, isTransient, rolloutDir, validateDelivery } from "../harness/driver.ts";

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

/** A workspace with rollout r1 (one file), an empty out/deliverables, and a file that sits OUTSIDE rollouts/. */
function makeWs(name: string): string {
  const ws = join(scratch, name);
  mkdirSync(join(ws, "rollouts", "r1", "deliverables"), { recursive: true });
  mkdirSync(join(ws, "out", "deliverables"), { recursive: true });
  mkdirSync(join(ws, "deliverables"), { recursive: true });
  writeFileSync(join(ws, "rollouts", "r1", "deliverables", "answer.txt"), "r1 answer");
  writeFileSync(join(ws, "deliverables", "outside.txt"), "not a rollout's file");
  return ws;
}

describe("rolloutDir", () => {
  const ws = makeWs("ws-rolloutdir");
  writeFileSync(join(ws, "rollouts", "afile"), "x");

  test("a real rollout directory is accepted", () => {
    expect(rolloutDir(ws, "r1")).toBe(join(ws, "rollouts", "r1"));
  });

  test.each(["", ".", "..", "r1/..", "../rollouts/r1", "r1/deliverables", "nope", "afile"])(
    "%j is not a rollout",
    (base) => {
      expect(rolloutDir(ws, base)).toBeNull();
    },
  );
});

describe("a base that is not a rollout name never reads from outside rollouts/", () => {
  test("completeBundle copies nothing for '..' (it used to restore files from <ws>/deliverables)", () => {
    const ws = makeWs("ws-complete");
    expect(completeBundle(ws, "..")).toEqual([]);
    expect(existsSync(join(ws, "out", "deliverables", "outside.txt"))).toBe(false);
  });

  test("validateDelivery names the problem instead of comparing against the wrong directory", () => {
    const ws = makeWs("ws-validate");
    const verdict = validateDelivery(ws, "..");
    expect(verdict.valid).toBe(false);
    expect(String(verdict.reason)).toContain("rollout");
  });

  test("a genuine base is still completed and validated", () => {
    const ws = makeWs("ws-genuine");
    expect(completeBundle(ws, "r1")).toEqual(["answer.txt"]);
    expect(validateDelivery(ws, "r1")).toMatchObject({ valid: true, n_base: 1, n_out: 1 });
    expect(changedFiles(ws, "r1")).toEqual([]);
  });
});
