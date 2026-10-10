// Copyright 2026 The VeriHarness Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * `veriharness batch` — split an items file into task folders that each fit a token budget. Each
 * batch gets the spec, the shared and reference files, its own items and an empty `rollouts/`, so `workers` and
 * `driver` can run on it. The whole output is written to a temp sibling of `--out` and renamed into
 * place, so a failure leaves no partial output.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { copyTree, renameReplacing, rmrf } from "../fsutil.js";
import { parseContextSize, type BackendDeps } from "../model/config.js";
import { resolveWindow, type ResolvedWindow } from "../model/window.js";
import { isMain } from "../runtime.js";
import { pack, type PackOptions } from "./pack.js";
import { parseSplitRule, splitItems, type Item, type SplitRule } from "./split.js";

const USAGE =
  "usage: veriharness batch --items FILE --split jsonl|blank-line|heading:REGEX --spec FILE --out DIR\n" +
  "         [--shared PATH]... [--reference PATH]... [--prompt FILE] [--items-name NAME]\n" +
  "         [--batch-tokens N | --provider P --model M [--base-url U] [--context-size N|auto]]\n" +
  "         [--chars-per-token R] [--overhead-tokens N] [--item-tokens N] [--max-items N]\n";

/** An input error: exit 2 with the message. */
class UsageError extends Error {}

function positive(name: string, raw: string | undefined, fallback: number, integer = true): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    throw new UsageError(`${name} must be a positive ${integer ? "whole number" : "number"}, not '${raw}'`);
  }
  return n;
}

function nonNegativeInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`${name} must be a whole number of 0 or more, not '${raw}'`);
  return n;
}

function required(values: Record<string, unknown>, name: string): string {
  const v = values[name];
  if (typeof v !== "string" || v === "") throw new UsageError(`--${name} is required`);
  return v;
}

/** Characters in a file, or in every file under a folder. */
function charsOf(path: string): number {
  if (statSync(path).isDirectory()) {
    return readdirSync(path).reduce((sum, name) => sum + charsOf(join(path, name)), 0);
  }
  return readFileSync(path, "utf8").length;
}

/** The text of a batch's items file: each item with its original text, in file order. */
function itemsText(items: readonly Item[], rule: SplitRule): string {
  if (rule.kind === "heading") return items.map((i) => i.text).join("");
  const sep = rule.kind === "jsonl" ? "\n" : "\n\n";
  return items.map((i) => i.text).join(sep) + "\n";
}

/** Run `veriharness batch` on `argv`; returns the exit code (0, 1 on a failed write, 2 on an input error). */
export async function main(argv: string[] = process.argv.slice(2), deps: BackendDeps = {}): Promise<number> {
  let tmp: string | null = null;
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h", default: false },
        items: { type: "string" },
        split: { type: "string" },
        spec: { type: "string" },
        out: { type: "string" },
        shared: { type: "string", multiple: true },
        reference: { type: "string", multiple: true },
        prompt: { type: "string" },
        "items-name": { type: "string" },
        "batch-tokens": { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
        "base-url": { type: "string" },
        "context-size": { type: "string" },
        "chars-per-token": { type: "string" },
        "overhead-tokens": { type: "string" },
        "item-tokens": { type: "string" },
        "max-items": { type: "string" },
      },
    });
    if (values.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    const itemsPath = required(values, "items");
    const splitRaw = required(values, "split");
    const specPath = required(values, "spec");
    const out = resolve(required(values, "out"));
    const shared = (values.shared ?? []).map((p) => resolve(p));
    // A worker searches a reference file with tools and never reads it whole, so it is not counted.
    const reference = (values.reference ?? []).map((p) => resolve(p));
    const rule = parseSplitRule(splitRaw);
    const itemsName = values["items-name"] ?? (rule.kind === "jsonl" ? "items.jsonl" : "items.md");
    const workspaceNames = [...shared, ...reference].map((p) => basename(p));
    const clash = workspaceNames.find((n, i) => workspaceNames.indexOf(n) !== i || n === itemsName);
    if (clash) throw new UsageError(`two files would land at workspace/${clash}`);
    if (existsSync(out) && readdirSync(out).length > 0) throw new UsageError(`--out ${out} is not empty`);
    // Checked before the first write, as the other inputs are: a missing prompt is an input error.
    if (values.prompt !== undefined && !(existsSync(values.prompt) && statSync(values.prompt).isFile())) {
      throw new UsageError(`--prompt ${values.prompt} is not a file`);
    }

    const { items, preambleChars } = splitItems(readFileSync(itemsPath, "utf8"), rule);
    if (items.length === 0) throw new UsageError(`no items: --split ${splitRaw} matched nothing in ${itemsPath}`);
    if (rule.kind === "heading" && preambleChars > 0) {
      process.stderr.write(`batch: ${preambleChars} characters before the first heading belong to no item\n`);
    }

    // The budget: an explicit number, or half the worker model's window.
    let budget: number;
    let window: ResolvedWindow | undefined;
    if (values["batch-tokens"] !== undefined) {
      if (values.model !== undefined) throw new UsageError("give --batch-tokens or --model, not both");
      budget = positive("--batch-tokens", values["batch-tokens"], 0);
    } else if (values.model !== undefined) {
      if (values.provider === undefined) throw new UsageError("--model needs --provider");
      window = await resolveWindow(
        {
          provider: values.provider,
          model: values.model,
          baseUrl: values["base-url"],
          contextSize: parseContextSize(values["context-size"], "--context-size"),
        },
        deps,
      );
      budget = Math.floor(window.window / 2);
    } else {
      throw new UsageError("no budget: give --batch-tokens N, or the worker model (--provider P --model M) to use half its window");
    }

    const options: PackOptions = {
      budget,
      fixedChars: charsOf(specPath) + shared.reduce((sum, p) => sum + charsOf(p), 0),
      charsPerToken: positive("--chars-per-token", values["chars-per-token"], 3.6, false),
      overheadTokens: nonNegativeInt("--overhead-tokens", values["overhead-tokens"], 2000),
      itemTokens: nonNegativeInt("--item-tokens", values["item-tokens"], 0),
      maxItems: values["max-items"] === undefined ? undefined : positive("--max-items", values["max-items"], 0),
    };
    const batches = pack(items, options);

    tmp = join(dirname(out), `.${basename(out)}.tmp-${process.pid}`);
    rmrf(tmp);
    mkdirSync(tmp, { recursive: true });
    for (const b of batches) {
      const dir = join(tmp, b.name);
      mkdirSync(join(dir, "spec"), { recursive: true });
      mkdirSync(join(dir, "workspace"), { recursive: true });
      mkdirSync(join(dir, "rollouts"), { recursive: true });
      copyFileSync(specPath, join(dir, "spec", "task.md"));
      for (const p of [...shared, ...reference]) {
        const dest = join(dir, "workspace", basename(p));
        if (statSync(p).isDirectory()) copyTree(p, dest);
        else copyFileSync(p, dest);
      }
      writeFileSync(join(dir, "workspace", itemsName), itemsText(b.items, rule), "utf8");
      if (b.overBudget) {
        process.stderr.write(`batch: ${b.name} holds one item (${b.items[0]!.id}) of ${b.estTokens} tokens, above the budget of ${budget}\n`);
      }
    }
    if (values.prompt !== undefined) copyFileSync(values.prompt, join(tmp, "worker_prompt.md"));
    const manifest = {
      budget,
      budgetSource: window ? "half-window" : "explicit",
      ...(window ? { window: window.window, windowSource: window.source } : {}),
      charsPerToken: options.charsPerToken,
      overheadTokens: options.overheadTokens,
      itemTokens: options.itemTokens,
      split: splitRaw,
      // Shared files are read whole by the worker, so the estimate counts them; reference files are searched, so it does not.
      shared: shared.map((p) => basename(p)),
      reference: reference.map((p) => basename(p)),
      batches: batches.map((b) => ({ name: b.name, items: b.items.map((i) => i.id), estTokens: b.estTokens, overBudget: b.overBudget })),
    };
    writeFileSync(join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    if (existsSync(out)) rmdirSync(out);
    renameReplacing(tmp, out);
    tmp = null;
    process.stderr.write(`batch: ${items.length} items in ${batches.length} batches of at most ${budget} tokens -> ${out}\n`);
    return 0;
  } catch (err) {
    // Before the first write, every error is about the input (an option, the items, a window that
    // does not resolve, a fixed part above the budget): exit 2. A failed write exits 1.
    const writing = tmp !== null;
    if (tmp) rmrf(tmp);
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return writing ? 1 : 2;
  }
}

if (isMain(import.meta.url)) {
  main().then((code) => process.exit(code));
}
