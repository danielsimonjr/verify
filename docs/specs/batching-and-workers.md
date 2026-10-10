# Context auto-size, batching and workers

This spec adds three features to the harness and one wrapper layer to verify-mcp:

1. `--context-size auto`: resolve, record and report the context window of each model.
2. `veriharness batch`: split a list of items into task workspaces that fit a token budget.
3. `veriharness workers`: make N rollouts for each task workspace with one worker model.
4. verify-mcp: `context_size: "auto"`, and the tools `verify_batch` and `verify_workers`.

The driver already checks rollouts. It does not make them. Today a caller writes scripts to cut a
job into tasks and to run the workers. These features replace those scripts.

## 1. Context auto-size

### Input

Each option that takes a context size also takes the word `auto`:

- `--context-size` on `driver`, `runner`, `model-check`, `batch` and `workers`.
- `--role-context-size ROLE=auto` on `driver` and `runner`.

A number keeps its current rules: a whole number above 4096, not larger than the server's window.
An omitted option means `auto`. Calls that omit the option keep their current behaviour.

### Resolution

The harness resolves the window of a model in this order and records the source:

| Provider | First source | Second source | No source |
|---|---|---|---|
| `ollama` | `GET /api/ps` `context_length` of the loaded model (`loaded`) | `num_ctx` from `POST /api/show` (`num_ctx`) | error |
| `llamacpp` | `n_ctx` from `GET /props` (`n_ctx`) | — | error |
| `claude-code` | the window table in `harness/config.ts` (`table`) | — | error that names the model id |

The harness never assumes a window. The `claude-code` table holds one window for each model id
that the lanes use. Each value comes from Anthropic's model documentation. A model id that is not in
the table needs an explicit number.

### Records

- `driver.log` has one line for each role: `context: ROLE=PROVIDER:MODEL window=N source=S`.
- `model-check` adds `window` and `windowSource` to its JSON output.
- `batch` writes `window` and `windowSource` into its manifest.

### Mismatch warning

The harness sends no `num_ctx` in its own requests, so it cannot cause a reload. Another client of
the same server can. When a role gives an explicit number and the model is loaded with a different
window, the harness writes a warning to `driver.log`:
`context: ROLE asks N, the server runs MODEL at M; a client that sends num_ctx may reload it`.
The run continues.

## 2. `veriharness batch`

### Command

```
veriharness batch --items FILE --split RULE --spec FILE --out DIR
                  [--shared PATH]... [--reference PATH]... [--prompt FILE] [--items-name NAME]
                  [--batch-tokens N | --provider P --model M [--base-url U] [--context-size N|auto]]
                  [--chars-per-token R] [--overhead-tokens N] [--item-tokens N] [--max-items N]
```

| Option | Meaning | Default |
|---|---|---|
| `--items FILE` | The file of items. | required |
| `--split RULE` | How the file divides into items: `jsonl`, `heading:REGEX` or `blank-line`. | required |
| `--spec FILE` | The task statement. The harness copies it to `spec/task.md` in each batch. | required |
| `--out DIR` | The output root. It must not exist, or it must be empty. | required |
| `--shared PATH` | A file or a folder that each batch gets under `workspace/`. The worker reads it whole, so the estimate counts it. Repeatable. | none |
| `--reference PATH` | A file or a folder that each batch gets under `workspace/`. The worker only searches it, so the estimate does not count it. Repeatable. | none |
| `--prompt FILE` | The worker prompt. The harness copies it to `DIR/worker_prompt.md`. | none |
| `--items-name NAME` | The file name of a batch's items under `workspace/`. | `items.md`, or `items.jsonl` for `jsonl` |
| `--batch-tokens N` | The token budget of one batch. | half the worker model's window |
| `--provider`, `--model`, `--base-url`, `--context-size` | The worker model. The harness resolves its window as in section 1. | — |
| `--chars-per-token R` | The fixed ratio that turns characters into tokens. | `3.6` |
| `--overhead-tokens N` | Tokens for the worker's own system prompt and tool definitions. | `2000` |
| `--item-tokens N` | Tokens reserved for the work on each item (search results, reads). | `0` |
| `--max-items N` | The largest number of items in one batch. | no limit |

The call must give `--batch-tokens`, or a worker model with a window that resolves. Else it stops
with exit code 2.

### Split rules

- `jsonl`: each non-empty line is one JSON object. The item id is its `id` field. A line without
  `id` gets its line number.
- `heading:REGEX`: a line that matches `REGEX` starts an item. The item runs to the next matching
  line. Text before the first match is not an item, and the harness reports its length. The first
  capture group is the item id. Without a capture group, the id is the item's ordinal.
- `blank-line`: one or more blank lines end an item. The id is the item's ordinal.

Two items with the same id stop the command with exit code 2.

### Packing

The estimate of a batch in tokens is:

```
ceil((chars(spec) + chars(shared) + chars(items in the batch)) / R) + overhead + item_tokens * count
```

`shared` is the `--shared` files. The `--reference` files are not in the estimate, because the worker
reaches them only through search and slice reads.

The harness takes the items in file order. It adds an item to the current batch while the estimate
stays at or below the budget, and while the batch has fewer than `--max-items` items. Then it starts
a new batch. An item that alone exceeds the budget gets a batch of its own, with `overBudget: true`.
The command prints a warning for each such batch and exits 0. When the fixed part (spec, shared
files and overhead) alone exceeds the budget, the command stops with exit code 2.

### Output

```
DIR/
  manifest.json
  worker_prompt.md            (when --prompt is given)
  b01/
    spec/task.md
    workspace/<shared files>
    workspace/<reference files>
    workspace/<items-name>    (the items of this batch, in file order, with their original text)
    rollouts/                 (empty)
  b02/ ...
```

`manifest.json`:

```json
{
  "budget": 32768, "budgetSource": "half-window",
  "window": 65536, "windowSource": "loaded",
  "charsPerToken": 3.6, "overheadTokens": 2000, "itemTokens": 0,
  "split": "heading:^### TODO line (\\d+)$", "reference": ["CHANGELOG.md"],
  "batches": [
    {"name": "b01", "items": ["6857", "6858"], "estTokens": 29674, "overBudget": false}
  ]
}
```

All batch names of one run have the same width, so a sort by name is also a sort by order. The
width is the number of digits in the batch count, and at least 2: `b01` to `b31` for 31 batches,
`b001` to `b120` for 120 batches.

## 3. `veriharness workers`

### Command

```
veriharness workers DIR --provider P --model M [--base-url U] [--context-size N|auto]
                    [--count N] [--tools LIST] [--deliverable NAME] [--prompt FILE]
                    [--only NAME]... [--timeout S] [--max-parallel N] [--env none]
                    [--temperature T] [--thinking L] [--max-tokens N]
```

| Option | Meaning | Default |
|---|---|---|
| `DIR` | A `batch` output root, or one task workspace that has `spec/` and `workspace/`. | required |
| `--provider`, `--model` | The worker model: a local provider, a pi provider or `claude-code`. | required |
| `--count N` | Rollouts for each batch: `r01` to `rNN`. | `3` |
| `--tools LIST` | The pi tool names the worker may use. | `read,grep,find,ls` |
| `--deliverable NAME` | The file name of the worker's result under `deliverables/`. | `report.json` |
| `--prompt FILE` | The worker prompt. | `DIR/worker_prompt.md` |
| `--only NAME` | Run only this batch. Repeatable. | all batches |
| `--timeout S` | Wall-clock limit of one worker, in seconds. | `3600` |
| `--max-parallel N` | Workers that run at the same time. | see Concurrency |
| `--env none` | Required for `claude-code`, as for the driver. | — |

`--temperature`, `--thinking` and `--max-tokens` apply to pi workers only, as on the driver.

### One worker

1. The harness copies `spec/` and `workspace/` of the batch to a new folder in the system temp
   folder. A worker cannot see another worker's files.
2. It starts one session in that folder:
   - pi workers: the pi command of the driver (`piCommandFor`), with `-p`, `--no-context-files`,
     `--no-extensions`, `--no-prompt-templates`, `--no-skills`, `--no-session`, `--mode json` and
     `--tools LIST`. A local model gets its own pi home with the `models.json` that
     `buildPiProvider` and `materializePiHome` write.
   - `claude-code` workers: `claude -p` with `--output-format stream-json`, `--setting-sources ""`,
     `--strict-mcp-config`, the verifier settings, `--no-session-persistence` and the tools from
     `claudeTools(LIST)`. The environment is `claudeSessionEnv` with `DISABLE_AUTOUPDATER=1`.
3. The prompt goes on the command line, or on stdin when it is too long (as `planPiCommand` does).
4. The event stream goes to `rollouts/rNN/trajectory/agent.jsonl`.
5. At the timeout, the harness stops the worker's whole process tree.
6. The harness deletes the temp folder.

### Deliverable

The deliverable is the text of the worker's last assistant message.

- For a `.json` deliverable, the harness parses it in this order and records the form:
  `pure` (the whole text is JSON), `fenced` (the whole text is one code fence) or `embedded`
  (text around a fenced block or a bare object). It writes the parsed value to
  `deliverables/NAME`. A text with no JSON value goes to `deliverables/NAME.txt` with the error
  `no-json`.
- For another deliverable, the text goes to `deliverables/NAME` unchanged.

The task spec says the format. A form other than `pure` is a format error, and the harness records it.
The harness does not hide it.

### Record

Each rollout gets `trajectory/worker.json`:

```json
{"rollout": "r01", "exit": 0, "seconds": 699, "turns": 7, "tools": 16, "peakContext": 36982,
 "outputTokens": 4864, "compactions": 0, "toolErrors": 0, "nudged": false, "form": "pure", "error": null}
```

`peakContext` is the largest prompt size of one turn: input plus cache read plus cache write
tokens. `compactions` counts the context compactions of the agent: above 0, the worker answered from
turns it no longer held. `error` is one of `timeout`, `no-result`, `no-json`, `start-failed`,
`usage-limit`, `truncated`, `stopped`, `max-turns`, `length`, `thinking-only`, `schema`, `compacted` or null.
`toolErrors` counts failed tool calls. `nudged` is true when a pi session that ended without an answer
was continued once with a short message (`--nudge-timeout`, default 300 s; 0 turns it off). `length` is a last
turn cut at the output limit; `thinking-only` is a last turn of thought with no text; `schema` is a
deliverable that parses and does not fit the `--schema` file. A rollout with an error keeps the last
text of the worker as `deliverables/<name>.partial.txt`.

When the batch root has a `manifest.json`, the printed line also has `estTokens` (the manifest's
estimate for that batch). A `peakContext` above `estTokens` writes one stderr line that names the
`--item-tokens` value that would have covered it: the manifest's `itemTokens` plus the overshoot
divided by the item count, rounded up.

### Resume

A rollout whose `worker.json` has `error: null` is complete, and the command skips it. Other
rollouts run again. A second call after a stop therefore finishes the job and does not repeat work.

### Concurrency

- Local providers (`ollama`, `llamacpp`): the default is `--count`. All workers of one batch run at
  the same time, and batches run one after the other. A local server gives a fixed token rate, so
  more workers at the same time make each worker slower. They do not make the job faster.
- `claude-code`: the default is the lane cap of the model (`haiku` 4, `sonnet` 4, `opus` 2,
  `fable` 2). Workers of different batches can run at the same time.
- `--max-parallel` replaces the default.

### Output

The command prints one JSON line for each finished rollout (`{"batch": ..., ...worker.json}`) and
a summary at the end. It exits 0 when every rollout is complete. It exits 1 when one or more
rollouts have an error, and 75 when a `claude-code` worker reaches a usage limit (the remaining
workers stop).

## 4. verify-mcp

- `context_size` accepts a positive whole number or `"auto"`, on the main model and on each role.
  The argv builders pass the word through.
- `verify_batch` wraps `veriharness batch`. Its fields map one to one onto the options. It returns
  the manifest.
- `verify_workers` wraps `veriharness workers`. The default wall clock is 12 hours. It reports
  progress for each finished rollout. The default model profile (`VERIFY_MCP_*`) applies as it does
  to `verify_driver`.
- `verify_model_check` returns `window` and `windowSource` from the harness output.
- The verify pin moves to the release that has sections 1 to 3.
- The README and the plugin skill list the new tools.

## Errors

| Condition | Result |
|---|---|
| No `--batch-tokens` and no worker model window | exit 2, message names both ways to set a budget |
| The fixed part alone exceeds the budget | exit 2, message gives the fixed estimate and the budget |
| An item alone exceeds the budget | own batch, `overBudget: true`, warning, exit 0 |
| Two items with one id | exit 2, message names the id and both positions |
| `--out` exists and is not empty | exit 2 |
| A worker exceeds `--timeout` | process tree stopped, `error: timeout` |
| A worker ends with no assistant text | `error: no-result` |
| A `claude-code` worker without `--env none` | exit 2, as for the driver |

## Tests

Unit tests with no model and no network:

- Each split rule: ids, capture groups, text before the first heading, duplicate ids.
- Packing: the estimate formula, `--max-items`, the over-budget item, the fixed part over budget,
  the fixed-width batch names.
- Budget: an explicit `--batch-tokens`, half of a resolved window, and no window.
- Window resolution for each provider against mocked HTTP, with the source of each value.
- Deliverable parsing: `pure`, `fenced`, `embedded` and `no-json`.
- `worker.json` from a recorded pi stream and from a recorded `claude -p` stream.
- Resume: a complete rollout is skipped and a failed one runs again.
- The process-tree stop at the timeout, with a child that starts its own child.
- verify-mcp: the schemas accept `"auto"` and reject other words; the argv of both new tools; the
  manifest and progress pass-through.

A live test (opt-in, as `tests/model.live.test.ts`): `batch` and `workers` on a small item file with
one local model, `--count 2`.
