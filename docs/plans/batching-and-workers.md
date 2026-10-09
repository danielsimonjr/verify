# Context auto-size, batching and workers: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `--context-size auto`, `veriharness batch` and `veriharness workers` in verify, and their wrappers in verify-mcp.

**Architecture:** Window resolution extends the existing probe in `harness/model/`. Batching is a pure split-and-pack module plus a writer (`harness/batch/`). Workers reuse the driver's pi launcher, the Claude Code argument and stream helpers, and `run()` from `harness/grade/proc.ts` for the timeout and the tree kill (`harness/workers/`). verify-mcp adds two thin tools over the new commands.

**Tech Stack:** TypeScript on Bun (dev) and Node (prod), `bun test`, `node:util` `parseArgs`; verify-mcp: zod schemas, MCP SDK.

**Spec:** `docs/specs/batching-and-workers.md`

## Global Constraints

- A numeric context size stays a whole number above 4096 and not above the server window; `auto` and an omitted option resolve the window.
- The harness never assumes a window: no source means an error.
- Default budget: half the worker model's resolved window. Default ratio `3.6` characters per token, `--overhead-tokens 2000`, `--item-tokens 0`.
- Default worker tools `read,grep,find,ls`; default deliverable `report.json`; default `--count 3`; default `--timeout 3600`.
- Lane caps for `claude-code` workers: haiku 4, sonnet 4, opus 2, fable 2.
- Exit codes: 2 for a usage error, 1 for a rollout with an error, 75 for a usage limit.
- Gates on every task: `bun run typecheck` and `bun test` green; docs in ASD-STE100 style.

## Review Focus

1. An items file with CRLF line ends: `heading:` and `blank-line` split it as they split the LF file (Task 3).
2. An items file that starts with a UTF-8 BOM: the first heading still matches (Task 3).
3. A split rule that finds no item: exit 2 and no `--out` folder is created (Task 5).
4. `--only` names a batch that does not exist: exit 2 before any worker starts (Task 8).
5. A rollout with a deliverable but no `worker.json` (the harness was killed): it runs again on resume (Task 8).

---

### Task 1: Window resolution and `auto`

**Files:**
- Modify: `harness/model/types.ts` (`Capabilities`), `harness/model/ollama.ts` (`probe`), `harness/model/llamacpp.ts` (`probe`), `harness/model/config.ts`, `harness/config.ts`
- Create: `harness/model/window.ts`
- Test: `tests/verify-model-window.test.ts`

**Interfaces:**
- Produces:
  - `Capabilities.contextSource?: "loaded" | "num_ctx" | "n_ctx"` (set by the Ollama and llama.cpp probes).
  - `type ContextSize = number | "auto"`; `parseContextSize(raw: string | undefined, name: string): ContextSize | undefined` in `harness/model/config.ts` (`"auto"` case-insensitive; other values keep the current integer rules).
  - `CLAUDE_CODE_WINDOWS: Readonly<Record<string, number>>` in `harness/config.ts`, one entry per model id in `LANES` (the `--model` values of the four lanes).
  - `type WindowSource = "explicit" | "loaded" | "num_ctx" | "n_ctx" | "table"`; `interface ResolvedWindow { window: number; source: WindowSource }`.
  - `resolveWindow(m: { provider: string; model: string; baseUrl?: string; contextSize?: ContextSize }, deps?: BackendDeps): Promise<ResolvedWindow>` in `harness/model/window.ts`. An explicit number returns `{window: n, source: "explicit"}` after the existing `enforceContext` check; otherwise the probe decides; `claude-code` reads the table.

- [ ] **Step 1: Write the failing tests** in `tests/verify-model-window.test.ts`, with mocked `fetch` as `tests/model.test.ts` does:
  - `ollama loaded wins`: `/api/ps` reports 65536 and `show` has `num_ctx 32768` → `{window: 65536, source: "loaded"}`.
  - `ollama num_ctx when not loaded`: `/api/ps` lists nothing → `{window: 32768, source: "num_ctx"}`.
  - `ollama no source throws`: neither → throws a `ModelError` with code `unsupported`.
  - `llamacpp n_ctx`: `/props` `n_ctx 16384` → `{window: 16384, source: "n_ctx"}`.
  - `claude-code table`: `claude-haiku-5-5` → `{window: CLAUDE_CODE_WINDOWS["claude-haiku-5-5"], source: "table"}`; an unknown id throws and the message names it.
  - `explicit number`: `contextSize: 8192` with a 65536 server → `{window: 8192, source: "explicit"}`.
  - `parseContextSize`: `"auto"`, `"AUTO"` → `"auto"`; `"8192"` → 8192; `"4096"` and `"big"` throw.
  - `every lane model has a window`: each `--model` value in `LANES` is a key of `CLAUDE_CODE_WINDOWS`.
- [ ] **Step 2: Run** `bun test tests/verify-model-window.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement.** Set `contextSource` where each probe sets `contextSize`. Fill `CLAUDE_CODE_WINDOWS` from Anthropic's model documentation (`https://docs.claude.com/en/docs/about-claude/models/overview`); cite the page in a comment above the table. Make `resolveModelConfig` accept `contextSize: ContextSize` and treat `"auto"` as omitted.
- [ ] **Step 4: Run** `bun test tests/verify-model-window.test.ts` then `bun test` and `bun run typecheck`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat(model): resolve the context window and record its source`.

### Task 2: `auto` on the driver, runner and model-check, with records

**Files:**
- Modify: `harness/driver.ts` (option parsing near lines 1076-1180, role parsing, the role-preparation loop near line 1481), `harness/runner.ts` (line 390 area), `harness/model/check.ts`
- Test: `tests/verify-roles-driver.test.ts`, `tests/verify-model-flags.test.ts`, `tests/verify-runner-args.test.ts`

**Interfaces:**
- Consumes: `parseContextSize`, `resolveWindow`, `Capabilities.contextSource` (Task 1).
- Produces: driver.log lines `context: ROLE=PROVIDER:MODEL window=N source=S`, and `context: ROLE asks N, the server runs MODEL at M; a client that sends num_ctx may reload it`; model-check JSON fields `window` and `windowSource`.

- [ ] **Step 1: Write the failing tests:**
  - driver: `--context-size auto` and `--role-context-size checker=auto` parse; a mocked local role logs `context: checker=ollama:m window=65536 source=loaded`; an explicit `--role-context-size checker=8192` against a model loaded at 65536 logs the mismatch line and the run continues.
  - runner: `--role-context-size checker=auto` passes the parser check.
  - model-check: the JSON output has `window` and `windowSource` for ollama (mocked) and for claude-code (table).
- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement.** Replace the numeric parse of both options with `parseContextSize`. Write one context line per role after its preflight; a claude-code role uses the table.
- [ ] **Step 4: Run** the three files, then `bun test` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Update** `docs/local-models.md` (the context section) and `docs/roles.md` (`--role-context-size ROLE=auto`). **Commit** `feat(driver): context-size auto with a context line per role`.

### Task 3: Split rules

**Files:**
- Create: `harness/batch/split.ts`
- Test: `tests/verify-batch-split.test.ts`

**Interfaces:**
- Produces:
  - `type SplitRule = { kind: "jsonl" } | { kind: "heading"; regex: RegExp } | { kind: "blank-line" }`
  - `parseSplitRule(raw: string): SplitRule` (`jsonl`, `blank-line`, `heading:REGEX` with the `m` flag; anything else throws).
  - `interface Item { id: string; text: string }`
  - `splitItems(text: string, rule: SplitRule): { items: Item[]; preambleChars: number }` (throws on a duplicate id; the message names the id and both 1-based positions).

- [ ] **Step 1: Write the failing tests:**
  - `jsonl ids`: `{"id":"a"}\n{"x":1}\n` → ids `["a", "2"]`, item text is the line.
  - `heading capture`: `intro\n### TODO line 7\nx\n### TODO line 9\ny\n` with `heading:^### TODO line (\d+)$` → ids `["7","9"]`, texts start with the heading line, `preambleChars` 6.
  - `heading ordinal`: a regex without a group → ids `["1","2"]`.
  - `blank-line`: `a\n\n\nb\nc\n` → 2 items, ids `["1","2"]`.
  - `duplicate id`: two `### TODO line 7` → throws with `7` and positions `1` and `2`.
  - `CRLF`: the CRLF form of each fixture gives the same ids and the same texts with LF ends.
  - `BOM`: a leading U+FEFF does not stop the first heading from matching.
  - `parseSplitRule`: `heading:` with an invalid regex throws; `csv` throws.
- [ ] **Step 2: Run** `bun test tests/verify-batch-split.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Normalise CRLF to LF and strip one leading BOM before splitting.
- [ ] **Step 4: Run** the file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(batch): split rules for an items file`.

### Task 4: Packing

**Files:**
- Create: `harness/batch/pack.ts`
- Test: `tests/verify-batch-pack.test.ts`

**Interfaces:**
- Consumes: `Item` (Task 3).
- Produces:
  - `interface PackOptions { budget: number; fixedChars: number; charsPerToken: number; overheadTokens: number; itemTokens: number; maxItems?: number }`
  - `interface PackedBatch { name: string; items: Item[]; estTokens: number; overBudget: boolean }`
  - `estimateTokens(chars: number, count: number, o: PackOptions): number` = `ceil(chars / charsPerToken) + overheadTokens + itemTokens * count`, where `chars` includes `fixedChars`.
  - `batchName(index: number, count: number): string` (index from 1; width `max(2, digits(count))`).
  - `pack(items: Item[], o: PackOptions): PackedBatch[]` (throws `FixedOverBudget` with the fixed estimate and the budget when `estimateTokens(fixedChars, 0, o) > budget`).

- [ ] **Step 1: Write the failing tests:**
  - `estimate formula`: chars 3600 + fixed 0, count 2, ratio 3.6, overhead 2000, item 100 → `1000 + 2000 + 200 = 3200`.
  - `packs in order to the budget`: 5 items of 360 chars, fixed 0, ratio 3.6, overhead 0, budget 250 → batches of 2, 2, 1.
  - `maxItems`: same items, budget 10000, `maxItems: 2` → 2, 2, 1.
  - `over-budget item alone`: one 3600-char item between two small ones, budget 500 → three batches, the middle one `overBudget: true`.
  - `fixed part over budget throws`: fixedChars 36000, budget 5000 → throws, message contains `10000` and `5000`.
  - `names`: `batchName(1, 31)` is `b01`, `batchName(31, 31)` is `b31`, `batchName(1, 120)` is `b001`, `batchName(120, 120)` is `b120`.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement** a single greedy pass in file order.
- [ ] **Step 4: Run** the file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(batch): pack items into batches by a token budget`.

### Task 5: `veriharness batch`

**Files:**
- Create: `harness/batch/main.ts`
- Modify: `harness/cli.ts` (a `batch` case and a USAGE line)
- Test: `tests/verify-batch-main.test.ts`

**Interfaces:**
- Consumes: `parseSplitRule`, `splitItems` (Task 3); `pack`, `PackedBatch` (Task 4); `resolveWindow`, `parseContextSize` (Task 1).
- Produces: `main(argv: string[], deps?: BackendDeps): Promise<number>`; the output layout and `manifest.json` exactly as the spec's section 2 shows (`budget`, `budgetSource` `"explicit"` or `"half-window"`, `window`, `windowSource`, `charsPerToken`, `overheadTokens`, `itemTokens`, `split`, `batches[{name, items: id[], estTokens, overBudget}]`).

- [ ] **Step 1: Write the failing tests** (temp folders, mocked fetch for the window):
  - `explicit budget`: 4 heading items, `--batch-tokens` that fits 2 → `b01`, `b02`; each has `spec/task.md`, the `--shared` file under `workspace/`, `workspace/items.md` with its items in order, and an empty `rollouts/`; manifest `budgetSource: "explicit"`, `window` absent.
  - `half window`: `--provider ollama --model m` with a mocked loaded window 65536 → manifest `budget: 32768`, `budgetSource: "half-window"`, `windowSource: "loaded"`.
  - `no budget`: neither option → exit 2, message names `--batch-tokens` and `--model`.
  - `no items`: a regex that matches nothing → exit 2 and `--out` does not exist.
  - `out not empty`: exit 2.
  - `prompt copied`: `--prompt` → `DIR/worker_prompt.md`.
  - `jsonl items-name default`: `items.jsonl`.
  - `over-budget item`: one item larger than the budget → its own batch with `overBudget: true`, a warning on stderr that names the batch, exit 0.
  - `fixed part over budget`: a spec file larger than the budget → exit 2, the message gives the fixed estimate and the budget, `--out` does not exist.
  - `preamble reported`: text before the first heading → stderr names its length in characters.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement.** Count `fixedChars` from the spec file and every `--shared` file (folders recursively). Write all batches to a temp sibling of `--out`, then rename it into place, so a failure leaves no partial `--out`.
- [ ] **Step 4: Run** the file, then `bun test` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(batch): veriharness batch`.

### Task 6: Deliverable and worker record

**Files:**
- Create: `harness/workers/record.ts`
- Test: `tests/verify-workers-record.test.ts`, fixtures `tests/fixtures/workers/pi-stream.jsonl` and `tests/fixtures/workers/claude-stream.jsonl` (cut from real runs: 3-4 assistant turns, one tool call)

**Interfaces:**
- Produces:
  - `type DeliverableForm = "pure" | "fenced" | "embedded"`
  - `parseJsonDeliverable(text: string): { value: unknown; form: DeliverableForm } | null`
  - `type WorkerError = "timeout" | "no-result" | "no-json" | "start-failed" | "usage-limit" | null`
  - `interface WorkerRecord { rollout: string; exit: number | null; seconds: number; turns: number; tools: number; peakContext: number; outputTokens: number; form: DeliverableForm | null; error: WorkerError }`
  - `piStreamStats(text: string): { finalText: string; turns: number; tools: number; peakContext: number; outputTokens: number }` (assistant `message_end` events; context = input + cacheRead + cacheWrite).
  - `claudeStreamStats(text: string): same shape` (via `parseStream` and the assistant events).

- [ ] **Step 1: Write the failing tests:**
  - `pure`: `{"rows":[]}` → form `pure`.
  - `fenced`: a message that is one ```json fence → `fenced`.
  - `embedded`: prose, a fence, prose → `embedded`; prose with a bare `{...}` → `embedded`.
  - `none`: `no json here` → `null`.
  - `pi stats`: the pi fixture gives the turn count, tool count, peak context and final text that the fixture holds (write the expected numbers into the test from the fixture).
  - `claude stats`: the same for the claude fixture.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(workers): deliverable forms and worker records`.

### Task 7: One worker

**Files:**
- Create: `harness/workers/worker.ts`
- Test: `tests/verify-workers-worker.test.ts`

**Interfaces:**
- Consumes: `piCommandFor`, `planPiCommand` (`harness/driver.ts`); `buildPiProvider`, `materializePiHome` (`harness/model/pi.ts`); `prepareLocalProvider` (`harness/model/prepare.ts`); `claudeCommand` (`harness/claude/preflight.ts`); `claudeTools` (`harness/claude/provider.ts`); `VERIFIER_SETTINGS`, `claudeSessionEnv` (`harness/claude/env.ts`); `run` (`harness/grade/proc.ts`); `copyTree`, `rmrf` (`harness/fsutil.ts`); Task 6.
- Produces:
  - `interface WorkerModel { provider: string; model: string; baseUrl?: string; contextSize?: ContextSize; temperature?: number; thinking?: string; maxTokens?: number }`
  - `interface WorkerJob { batchDir: string; rollout: string; prompt: string; model: WorkerModel; tools: string; deliverable: string; timeoutSec: number; piProvider?: PiProviderRecord }`
  - `workerArgs(job: WorkerJob, home: string): { cmd: string[]; input?: string; env: NodeJS.ProcessEnv }` (pure; pi flags or claude flags exactly as the spec's section 3 lists).
  - `runWorker(job: WorkerJob, deps?: { run?: typeof run }): Promise<WorkerRecord>` (copies `spec/` and `workspace/` to `mkdtemp`, runs, writes `trajectory/agent.jsonl`, `trajectory/worker.json` and the deliverable, deletes the temp folder in a `finally`).

- [ ] **Step 1: Write the failing tests** (an injected `run` fake returns a recorded stream; no model):
  - `pi args`: the command has `-p`, `--no-context-files`, `--no-extensions`, `--no-prompt-templates`, `--no-skills`, `--no-session`, `--mode json`, `--tools read,grep,find,ls`; env `PI_CODING_AGENT_DIR` is the worker's own home with `models.json`.
  - `claude args`: `--output-format stream-json`, `--setting-sources ""`, `--strict-mcp-config`, `--no-session-persistence`, `--tools Read,Grep,Glob`; env has `DISABLE_AUTOUPDATER=1`.
  - `writes the rollout`: `agent.jsonl` holds the fake stream, `report.json` holds the parsed JSON, `worker.json` has `form` and `error: null`.
  - `timeout`: the fake returns `timedOut: true` → `error: "timeout"`, `exit: null`.
  - `no json`: a final text without JSON → `report.json.txt` written, `error: "no-json"`.
  - `temp folder removed`: after success and after a thrown error, the temp folder does not exist.
  - `isolation`: the worker's cwd is not the batch folder and holds copies of `spec/` and `workspace/` only.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement.** Map a usage-limit failure (`classifyFailure` in `harness/claude/errors.ts`) to `error: "usage-limit"`.
- [ ] **Step 4: Run** the file, then `bun test` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(workers): run one worker in an isolated copy`.

### Task 8: `veriharness workers`

**Files:**
- Create: `harness/workers/main.ts`
- Modify: `harness/cli.ts` (a `workers` case and a USAGE line)
- Test: `tests/verify-workers-main.test.ts`

**Interfaces:**
- Consumes: `runWorker`, `WorkerModel` (Task 7); `WorkerRecord` (Task 6); `resolveWindow` (Task 1); `isClaudeCodeProvider`, `USAGE_LIMIT_EXIT` (`harness/claude/provider.ts`).
- Produces: `main(argv: string[], deps?: { runWorker?: typeof runWorker }): Promise<number>`; one stdout JSON line per finished rollout `{"batch": NAME, ...WorkerRecord}`; a final summary line `{"summary": {complete, errors, skipped}}`.

- [ ] **Step 1: Write the failing tests** (an injected `runWorker` fake):
  - `all batches`: a batch root with `b01`, `b02`, `--count 2` → 4 calls, exit 0, 4 lines plus the summary.
  - `one task workspace`: `DIR` with `spec/` and `workspace/` → treated as one batch.
  - `--only`: `--only b02` → 2 calls; `--only b09` (absent) → exit 2 and 0 calls.
  - `resume`: `b01/rollouts/r01/trajectory/worker.json` with `error: null` → skipped; `r02` with `error: "timeout"` → runs; a rollout with a deliverable and no `worker.json` → runs.
  - `local concurrency`: provider `ollama`, `--count 3`: the fake records the largest number of calls in flight = 3, and batch `b02` starts only after all of `b01` finish.
  - `claude concurrency`: provider `claude-code`, model `claude-haiku-5-5`, 3 batches × 3 → largest in flight = 4.
  - `--max-parallel 1` → largest in flight = 1.
  - `exit 1`: one fake record with `error: "no-json"` → exit 1.
  - `usage limit`: a fake record with `error: "usage-limit"` → no new call starts, exit 75.
  - `claude needs env none`: provider `claude-code` without `--env none` → exit 2.
  - `prompt default`: no `--prompt` and no `DIR/worker_prompt.md` → exit 2.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement.** Resolve the window once before the first worker (it also proves the server and the model). Lane caps come from the lane whose `--model` equals the worker model; a claude-code model in no lane uses 2.
- [ ] **Step 4: Run** the file, then `bun test` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(workers): veriharness workers`.

### Task 9: Docs, live test and release

**Files:**
- Create: `docs/batching.md`
- Modify: `README.md` (command list), `CHANGELOG.md` (`[Unreleased]` → `[0.5.0]`), `todo.md`, `package.json` (`0.5.0`), `tests/model.live.test.ts` (opt-in live case)

- [ ] **Step 1: Write `docs/batching.md`**: one worked example from items file to `driver` (batch, workers, driver per batch), the budget rule, the manifest, the deliverable forms, resume and concurrency.
- [ ] **Step 2: Add the live case**, gated by `VERIHARNESS_LIVE_OLLAMA=1`: `batch` of 3 heading items with `--provider ollama`, then `workers --count 2` on `b01`; assert two `worker.json` files exist and the manifest has `windowSource`.
- [ ] **Step 3: Run the gates**: `bun run typecheck`, `bun test`, `repo-tools docs check harness` (no new MUST issue in the new files). Expected: green, and the doc check count of missing doc comments does not rise.
- [ ] **Step 4: Run the live case** against the EVO Ollama with `qwen3.5:9b-64k`. Expected: PASS.
- [ ] **Step 5: Commit, push, tag `v0.5.0`, push the tag.** Verify CI publishes: `npm view @danielsimonjr/verify version` prints `0.5.0`. Then `gh release create v0.5.0` from the CHANGELOG section.

### Task 10: verify-mcp wrappers

**Files (repo `verify-mcp`):**
- Modify: `src/schemas.ts`, `src/argv.ts`, `src/handlers.ts`, `src/server.ts`, `src/defaults.ts`, `src/pin.ts`, `package.json`, `README.md`, `skills/` (tool list), `CHANGELOG.md`, `todo.md`
- Test: `tests/` (schemas, argv, handlers, the pin test)

**Interfaces:**
- Consumes: the CLI of Tasks 2, 5 and 8 at `@danielsimonjr/verify@0.5.0`.
- Produces: `contextSizeField` = `z.union([z.number().int().positive(), z.literal("auto")])` on the main model and on each role; tools `verify_batch` (fields = the `batch` options in snake_case; returns the parsed `manifest.json`) and `verify_workers` (fields = the `workers` options; default `timeout_seconds` 43200; one progress notification per stdout JSON line; the default model profile applies); `verify_model_check` passes `window` and `windowSource` through.

- [ ] **Step 1: Write the failing tests:** schema accepts `"auto"` and 8192, rejects `"big"` and 4096-or-less on roles; `batchArgv` and `workersArgv` produce the exact flag lists for a full input; the pin test expects `0.5.0`; a handler test parses a fake `veriharness workers` stdout into progress events and a result.
- [ ] **Step 2: Run** `bun test`. Expected: FAIL.
- [ ] **Step 3: Implement**, following the existing `materialize` and `driver` patterns.
- [ ] **Step 4: Run** `bun test` and the typecheck, rebuild the bundle (`bundle/index.mjs`, recipe in the README), and run `repo-tools docs check src`. Expected: green.
- [ ] **Step 5: Commit, push, release** (version `0.9.0`), then `claude plugin marketplace update local-marketplace`, ask for `/reload-plugins`, and prove the running server: `verify_batch` on a 3-item file returns a manifest with `windowSource`.
