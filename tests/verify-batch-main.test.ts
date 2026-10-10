import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../harness/batch/main.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vbatch-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const RULE = "heading:^### TODO line (\\d+)$";
/** Four items of 360 characters each: 100 tokens at 3.6 characters per token. */
const ITEMS = ["7", "8", "9", "10"]
  .map((id) => `### TODO line ${id}\n` + "x".repeat(360 - `### TODO line ${id}\n`.length - 1) + "\n")
  .join("");

function files(items = ITEMS, spec = "Check each row.\n") {
  const itemsPath = join(root, "todo.md");
  const specPath = join(root, "spec.md");
  const shared = join(root, "CHANGELOG.md");
  writeFileSync(itemsPath, items);
  writeFileSync(specPath, spec);
  writeFileSync(shared, "# Changelog\n");
  return { itemsPath, specPath, shared, out: join(root, "out") };
}

async function batch(argv: string[], fetch?: (input: string | URL) => Promise<Response>) {
  const errReal = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((c: string | Uint8Array) => ((stderr += String(c)), true)) as typeof process.stderr.write;
  try {
    const code = await main(argv, fetch ? { fetch, retryDelayMs: 0 } : {});
    return { code, stderr };
  } finally {
    process.stderr.write = errReal;
  }
}

const manifest = (out: string) => JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
const base = (f: ReturnType<typeof files>) => ["--items", f.itemsPath, "--split", RULE, "--spec", f.specPath, "--out", f.out];
/** Fixed part: the spec (16) and CHANGELOG.md (12) are 28 characters, 8 tokens; overhead 0. Two items fit in 250. */
const FIT_TWO = ["--shared", "", "--batch-tokens", "250", "--overhead-tokens", "0"];
const withShared = (f: ReturnType<typeof files>, extra: string[]) => extra.map((a) => (a === "" ? f.shared : a));

function ollamaLoaded(window: number) {
  return async (input: string | URL): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (path === "/api/tags") return json({ models: [{ name: "m" }] });
    if (path === "/api/show") return json({ capabilities: ["completion", "tools"], parameters: "num_ctx 32768" });
    if (path === "/api/ps") return json({ models: [{ name: "m", context_length: window }] });
    return new Response("not found", { status: 404 });
  };
}

describe("veriharness batch", () => {
  test("explicit budget", async () => {
    const f = files();
    const r = await batch([...base(f), ...withShared(f, FIT_TWO)]);
    expect(r.code).toBe(0);
    expect(readdirSync(f.out).sort()).toEqual(["b01", "b02", "manifest.json"]);
    for (const b of ["b01", "b02"]) {
      expect(readFileSync(join(f.out, b, "spec", "task.md"), "utf8")).toBe("Check each row.\n");
      expect(readFileSync(join(f.out, b, "workspace", "CHANGELOG.md"), "utf8")).toBe("# Changelog\n");
      expect(readdirSync(join(f.out, b, "rollouts"))).toEqual([]);
    }
    const first = readFileSync(join(f.out, "b01", "workspace", "items.md"), "utf8");
    expect(first.indexOf("### TODO line 7")).toBe(0);
    expect(first.indexOf("### TODO line 8")).toBeGreaterThan(0);
    expect(first).not.toContain("### TODO line 9");
    const m = manifest(f.out);
    expect(m.budget).toBe(250);
    expect(m.budgetSource).toBe("explicit");
    expect(m.shared).toEqual(["CHANGELOG.md"]);
    expect(m.window).toBeUndefined();
    expect(m.split).toBe(RULE);
    expect(m.batches).toEqual([
      { name: "b01", items: ["7", "8"], estTokens: 208, overBudget: false },
      { name: "b02", items: ["9", "10"], estTokens: 208, overBudget: false },
    ]);
  });

  test("half window", async () => {
    const f = files();
    const argv = [...base(f), "--provider", "ollama", "--model", "m", "--base-url", "http://127.0.0.1:11434"];
    const r = await batch(argv, ollamaLoaded(65536));
    expect(r.code).toBe(0);
    const m = manifest(f.out);
    expect(m.budget).toBe(32768);
    expect(m.budgetSource).toBe("half-window");
    expect(m.window).toBe(65536);
    expect(m.windowSource).toBe("loaded");
    expect(m.charsPerToken).toBe(3.6);
    expect(m.overheadTokens).toBe(2000);
    expect(m.itemTokens).toBe(0);
  });

  test("no budget", async () => {
    const f = files();
    const r = await batch(base(f));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--batch-tokens");
    expect(r.stderr).toContain("--model");
    expect(existsSync(f.out)).toBe(false);
  });

  test("no items", async () => {
    const f = files("nothing here\n");
    const r = await batch([...base(f), ...withShared(f, FIT_TWO)]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/no items/);
    expect(existsSync(f.out)).toBe(false);
  });

  test("out not empty", async () => {
    const f = files();
    mkdirSync(f.out);
    writeFileSync(join(f.out, "keep.txt"), "x");
    const r = await batch([...base(f), ...withShared(f, FIT_TWO)]);
    expect(r.code).toBe(2);
    expect(readdirSync(f.out)).toEqual(["keep.txt"]);
  });

  test("an empty out is used", async () => {
    const f = files();
    mkdirSync(f.out);
    const r = await batch([...base(f), ...withShared(f, FIT_TWO)]);
    expect(r.code).toBe(0);
    expect(existsSync(join(f.out, "manifest.json"))).toBe(true);
  });

  test("prompt copied", async () => {
    const f = files();
    const prompt = join(root, "prompt.md");
    writeFileSync(prompt, "Do the work.\n");
    const r = await batch([...base(f), ...withShared(f, FIT_TWO), "--prompt", prompt]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(f.out, "worker_prompt.md"), "utf8")).toBe("Do the work.\n");
  });

  test("a missing prompt file is an input error, and nothing is written", async () => {
    const f = files();
    const r = await batch([...base(f), ...withShared(f, FIT_TWO), "--prompt", join(root, "absent.md")]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("absent.md");
    expect(existsSync(f.out)).toBe(false);
    expect(readdirSync(root).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  test("jsonl items-name default", async () => {
    const f = files('{"id":"a"}\n{"id":"b"}\n');
    const argv = ["--items", f.itemsPath, "--split", "jsonl", "--spec", f.specPath, "--out", f.out, "--batch-tokens", "5000"];
    const r = await batch(argv);
    expect(r.code).toBe(0);
    expect(readFileSync(join(f.out, "b01", "workspace", "items.jsonl"), "utf8")).toBe('{"id":"a"}\n{"id":"b"}\n');
  });

  test("over-budget item", async () => {
    const big = `### TODO line 1\n${"y".repeat(3600)}\n`;
    const f = files(`### TODO line 0\nx\n${big}### TODO line 2\nz\n`);
    const r = await batch([...base(f), ...withShared(f, FIT_TWO)]);
    expect(r.code).toBe(0);
    const m = manifest(f.out);
    expect(m.batches.map((b: { items: string[] }) => b.items)).toEqual([["0"], ["1"], ["2"]]);
    expect(m.batches[1].overBudget).toBe(true);
    expect(r.stderr).toMatch(/b02/);
  });

  test("fixed part over budget", async () => {
    const f = files(ITEMS, "s".repeat(36_000));
    const r = await batch([...base(f), "--batch-tokens", "5000", "--overhead-tokens", "0"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("10000");
    expect(r.stderr).toContain("5000");
    expect(existsSync(f.out)).toBe(false);
  });

  test("preamble reported", async () => {
    const f = files(`intro\n${ITEMS}`);
    const r = await batch([...base(f), ...withShared(f, FIT_TWO)]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/6 characters/);
  });

  test("a shared folder is copied whole and counted", async () => {
    const f = files();
    const dir = join(root, "shared-dir");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "a.txt"), "a".repeat(36));
    const r = await batch([...base(f), "--shared", dir, "--batch-tokens", "250", "--overhead-tokens", "0"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(f.out, "b01", "workspace", "shared-dir", "sub", "a.txt"), "utf8")).toBe("a".repeat(36));
    // spec 16 + folder 36 = 52 characters, 15 tokens, plus two items of 100.
    expect(manifest(f.out).batches[0].estTokens).toBe(215);
  });

  test("a reference file is copied to every batch and not counted", async () => {
    const f = files();
    // 36,000 characters, 10,000 tokens: as a shared file it would put the fixed part over the budget.
    const corpus = join(root, "corpus.md");
    writeFileSync(corpus, "c".repeat(36_000));
    const r = await batch([...base(f), "--reference", corpus, "--batch-tokens", "250", "--overhead-tokens", "0"]);
    expect(r.code).toBe(0);
    for (const b of ["b01", "b02"]) {
      expect(readFileSync(join(f.out, b, "workspace", "corpus.md"), "utf8")).toHaveLength(36_000);
    }
    const m = manifest(f.out);
    // spec 16 + two items of 360 = 736 characters, 205 tokens: the reference adds nothing.
    expect(m.batches[0]).toEqual({ name: "b01", items: ["7", "8"], estTokens: 205, overBudget: false });
    expect(m.reference).toEqual(["corpus.md"]);
    // The manifest says which files were counted (shared) and which were not (reference).
    expect(m.shared).toEqual([]);
  });

  test("a reference folder is copied whole", async () => {
    const f = files();
    const dir = join(root, "ref-dir");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "a.txt"), "a".repeat(36_000));
    const r = await batch([...base(f), "--reference", dir, "--batch-tokens", "250", "--overhead-tokens", "0"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(f.out, "b01", "workspace", "ref-dir", "sub", "a.txt"), "utf8")).toHaveLength(36_000);
  });

  test("a reference that lands on the name of a shared file or the items is an input error", async () => {
    const f = files();
    const other = join(root, "other");
    mkdirSync(other);
    const twin = join(other, "CHANGELOG.md");
    writeFileSync(twin, "x");
    const items = join(other, "items.md");
    writeFileSync(items, "x");
    for (const clash of [twin, items]) {
      const r = await batch([...base(f), "--shared", f.shared, "--reference", clash, "--batch-tokens", "250"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("two files would land at workspace/");
      expect(existsSync(f.out)).toBe(false);
    }
  });
});

describe("veriharness batch on the command line", () => {
  test("the cli routes batch, and a call with no options is an input error", async () => {
    const { main: cliMain } = await import("../harness/cli.ts");
    const r = await batch([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--items is required");
    const outReal = process.stdout.write.bind(process.stdout);
    let stdout = "";
    process.stdout.write = ((c: string | Uint8Array) => ((stdout += String(c)), true)) as typeof process.stdout.write;
    try {
      expect(await cliMain(["batch", "--help"])).toBe(0);
    } finally {
      process.stdout.write = outReal;
    }
    expect(stdout).toContain("veriharness batch --items FILE");
  });
});
