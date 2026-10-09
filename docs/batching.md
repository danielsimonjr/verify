# Batching and workers

Two commands prepare a large check for verify:

- `veriharness batch` splits an items file into task folders. Each folder fits a token budget.
- `veriharness workers` runs worker rollouts on each folder. The driver then checks the rollouts.

## A worked example

The task: for each closed row in `TODO.md`, find out if `CHANGELOG.md` records it.

### 1. Split the items

```
veriharness batch --items TODO-closed.md --split "heading:^### TODO line (\d+)$" \
  --spec task.md --shared CHANGELOG.md --prompt worker_prompt.md \
  --provider ollama --model qwen3.5:9b-64k --base-url http://evo-x2:11434 --out work
```

Each line that matches the regex starts one item. The capture group is the item id. The command
resolves the worker model's window, takes half of it as the budget, and packs the items in file order.

```
work/
  manifest.json
  worker_prompt.md
  b01/  spec/task.md  workspace/CHANGELOG.md  workspace/items.md  rollouts/
  b02/  ...
```

### 2. Run the workers

```
veriharness workers work --provider ollama --model qwen3.5:9b-64k --base-url http://evo-x2:11434 --count 3
```

Each batch gets the rollouts `r01` to `r03`. Each rollout has `trajectory/agent.jsonl`,
`trajectory/worker.json` and `deliverables/report.json`.

### 3. Check each batch

```
veriharness driver work/b01 --provider ollama --model qwen3.6:latest --env none
```

The driver reads `rollouts/` as for any task. The runner and verify-mcp's `verify_driver` work the
same way.

## The budget

| Input | Budget |
|---|---|
| `--batch-tokens N` | N tokens |
| `--provider P --model M` | half the resolved window (`budgetSource: "half-window"`) |
| neither | exit 2 |

The window resolves as in [local-models.md](local-models.md): a loaded Ollama model, then `num_ctx`,
then llama.cpp's `n_ctx`. A Claude Code model reads the table in `harness/config.ts`.

The estimate of one batch is:

```
ceil((chars(spec) + chars(shared) + chars(items)) / R) + overhead + item_tokens * count
```

`R` is `--chars-per-token` (default 3.6). `overhead` is `--overhead-tokens` (default 2000): the
worker's system prompt and tool definitions. `item_tokens` is `--item-tokens` (default 0): the reads
and search results that the work on one item adds.

The estimate counts only the text that the worker gets at the start. A worker that reads files and
runs searches adds tokens on each turn. Measured on a 9B model with a 64k window: batches estimated at
30k tokens reached a peak context of 34k to 48k. Set `--item-tokens` to keep that growth under the
window, or keep the default budget of half the window.

An item that alone exceeds the budget gets a batch of its own. The manifest marks it
`overBudget: true`, and the command prints a warning. When the spec, the shared files and the overhead
alone exceed the budget, the command stops with exit code 2.

## The manifest

```json
{
  "budget": 32768, "budgetSource": "half-window",
  "window": 65536, "windowSource": "loaded",
  "charsPerToken": 3.6, "overheadTokens": 2000, "itemTokens": 0,
  "split": "heading:^### TODO line (\\d+)$",
  "batches": [{"name": "b01", "items": ["6857", "6858"], "estTokens": 29674, "overBudget": false}]
}
```

All batch names of one run have the same width: `b01` to `b31`, or `b001` to `b120`. A sort by name is
also a sort by order.

## Split rules

| Rule | Item | Id |
|---|---|---|
| `jsonl` | one non-empty line | the `id` field, else the line number |
| `heading:REGEX` | from a matching line to the next one | the first capture group, else the position |
| `blank-line` | a block between blank lines | the position |

Text before the first heading belongs to no item; the command prints its length. Two items with the
same id stop the command with exit code 2. CRLF line ends and a leading byte order mark do not change
the result.

## Deliverable forms

The deliverable is the text of the worker's last message. For a `.json` deliverable, the harness
records the form:

| Form | The text is |
|---|---|
| `pure` | JSON and nothing else |
| `fenced` | one code fence that holds JSON |
| `embedded` | prose around a fenced block or a bare object |

A text with no JSON goes to `deliverables/report.json.txt`, with the error `no-json`. A form other than
`pure` is a format error: the record shows it, and the harness does not hide it.

## The record

```json
{"rollout": "r01", "exit": 0, "seconds": 699, "turns": 7, "tools": 16, "peakContext": 36982,
 "outputTokens": 4864, "form": "pure", "error": null}
```

`peakContext` is the largest prompt of one turn: input plus cache read plus cache write tokens.
`error` is `timeout`, `no-result`, `no-json`, `start-failed`, `usage-limit` or null.

## Resume

A rollout whose `worker.json` has `error: null` is complete. A second call skips it and runs the
others again. A rollout that has a deliverable but no `worker.json` runs again.

## Concurrency

- `ollama` and `llamacpp`: all rollouts of one batch run at the same time, and batches run one after
  the other. A local server has a fixed token rate, so more sessions at once make each session slower.
  They do not make the job faster. Measured: about 44 s for each tool turn with 3 sessions, about
  120 s with 9.
- `claude-code`: up to the lane cap of the model (haiku 4, sonnet 4, opus 2, fable 2) across batches.
- `--max-parallel N` replaces the default.

A usage limit stops the start of new workers. The command then exits with code 75.

## Isolation

Each worker runs in a temp copy of its batch's `spec/` and `workspace/`. A worker cannot read another
worker's files. The harness deletes the copy when the worker stops, also after an error.
