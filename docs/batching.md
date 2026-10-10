# Batching and workers

Two commands prepare a large check for verify:

- `veriharness batch` splits an items file into task folders. Each folder fits a token budget.
- `veriharness workers` runs worker rollouts on each folder. The driver then checks the rollouts.

## A worked example

The task: for each closed row in `TODO.md`, find out if `CHANGELOG.md` records it.

### 1. Split the items

```
veriharness batch --items TODO-closed.md --split "heading:^### TODO line (\d+)$" \
  --spec task.md --reference CHANGELOG.md --prompt worker_prompt.md \
  --provider ollama --model qwen3.5:9b-64k --base-url http://evo-x2:11434 --out work
```

Each line that matches the regex starts one item. The capture group is the item id. The command
resolves the worker model's window, takes half of it as the budget, and packs the items in file order.

`--shared` and `--reference` both copy a file or a folder into each batch's `workspace/`. The test
for the choice: does the worker prompt tell the worker to read the file whole? If it does, the file
is `--shared`. A file that the worker only searches is `--reference`. A file that is listed wrongly
as `--reference` is read whole and is not counted, so the batch goes over its budget. The
`manifest.json` lists both sets, as `shared` and `reference`. Use
`--shared` for a file that the worker reads whole: the estimate counts it. Use `--reference` for a
file that the worker only searches, such as a large CHANGELOG: the estimate does not count it. A
CHANGELOG of 1 MB is about 290,000 tokens, so as `--shared` it puts every batch over the budget.

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
`trajectory/worker.json` and `deliverables/report.json`. `agent.jsonl` grows while the worker runs,
so its size shows progress; `worker.json` is written when the worker stops.

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

`shared` is the `--shared` files; `--reference` files are not in the estimate.

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
  "split": "heading:^### TODO line (\\d+)$", "reference": ["CHANGELOG.md"],
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
| `embedded` | prose around a fenced block, a bare object or a bare array |

In prose, the deliverable is the longest top-level JSON value, an array included. A value that never
closes, or that is not valid JSON, gives `no-json`: the harness never returns an object from inside it.
A text with no JSON goes to `deliverables/report.json.txt`, with the error `no-json`. A form other than
`pure` is a format error: the record shows it, and the harness does not hide it.

## The record

```json
{"rollout": "r01", "exit": 0, "seconds": 699, "turns": 7, "tools": 16, "peakContext": 36982,
 "outputTokens": 4864, "form": "pure", "error": null}
```

`peakContext` is the largest prompt of one turn: input plus cache read plus cache write tokens.

When the folder holds a `manifest.json` from `batch`, the line printed by `workers` also has
`estTokens`, the estimate of that batch. The estimate is a claim that the batch fits. The measured
`peakContext` tests it. When `peakContext` is above `estTokens`, the command writes a line to stderr
with the `--item-tokens` value that would have covered the batch. Use that value, or one measured on
your own task, in the next `batch` call. A default cannot know what one item costs: that depends on
the task, the tools and the model. Each rollout of a batch gives its own value. Take the largest
value over all rollouts of all batches, not the value of one probe: one rollout is one sample of a
cost that varies from run to run.

`compactions` is the number of times the agent compacted its context. Each compaction drops the
older turns, so a worker that compacted answers from turns it no longer holds. A rollout with a
compaction ends as `compacted`: its deliverable is kept, but the batch did not fit the window, which
is the premise of `batch`. Make the batches smaller. `--allow-compaction` accepts such a rollout.
Compaction caps `peakContext`, so the suggested `--item-tokens` of a compacted rollout is a lower
bound: the line says "at least".

At the end of a run, `workers` writes the largest `--item-tokens` suggestion over all rollouts, and
the summary line has it as `itemTokens`.

`toolErrors` is the number of tool calls that failed. A worker that reads paths or patterns the task
does not have fails many calls; `workers` writes a stderr line when at least half of at least five
calls failed.

`error` is null when the rollout is complete. Otherwise it is one of these values:

| `error` | Cause |
|---|---|
| `start-failed` | The process did not start. |
| `timeout` | The worker ran past `--timeout`. |
| `truncated` | The event stream went past the 256 MiB cap. |
| `stopped` | A usage limit in another worker stopped this worker. |
| `max-turns` | The worker passed `--max-turns` assistant turns. |
| `usage-limit` | The Claude Code account hit its usage limit. |
| `no-result` | No final answer. For Claude Code, also an exit code that is not 0 or an error result. |
| `no-json` | A `.json` deliverable, and the final text holds no JSON. |
| `length` | The last turn ended at the output-token limit, so its text is cut. |
| `thinking-only` | The last turn held thinking and no text: the model spent its output on thought. |
| `schema` | The deliverable is JSON but does not fit the `--schema` file. |
| `compacted` | The agent compacted its context. The deliverable is kept; see `--allow-compaction`. |

When a rollout ends with an error and its last turn had text, the harness keeps that text as
`deliverables/<name>.partial.txt`. A timeout, a cut or a stop no longer loses what the worker wrote.
For `schema`, the file `deliverables/<name>.schema-errors.txt` lists each error with its path.

## Deliverable schema

`--schema FILE` checks each parsed deliverable against a JSON Schema file. A value that parses is
not yet a deliverable: it must have the shape the task asked for. The check knows `type`, `enum`,
`const`, `required`, `properties`, `additionalProperties`, `items`, `minItems`, `maxItems`,
`minimum`, `maximum` and `anyOf`. A schema that holds any other keyword is an input error, so a
schema is never passed by a part that the check skipped.

## Retries

`--retries N` runs a rollout again, up to N more times, when its error is `no-result`, `no-json`,
`thinking-only`, `length` or `schema`: the model's output was wrong or empty, and a second try can
differ. A `timeout`, a `usage-limit`, a `stopped` and a `max-turns` are never repeated. Each printed
line and each `worker.json` has `attempts`. A retry runs in the same rollout folder, so the harness first
moves the stream and the record of the attempt before it to `trajectory/attempt-N/`. A rollout that
took three tries shows all three. `seconds` is the time of the last attempt; `totalSeconds` is the time of
all of them.

## Nudge

Three things end a pi session with no answer: the time limit, a last turn of thought alone, and a
last turn cut at the output limit. A fourth is a final message without the JSON. Each one used to
throw away what the worker had found. `workers` now continues the same session once with a short
message: stop investigating, do not think further, write the answer now. The message depends on the
cause. The nudge has its own budget: `--nudge-timeout S` (default 300; 0 turns it off). The record
has `nudged: true`, and `agent.jsonl` holds both sessions. A nudge needs a saved session, so a
Claude Code worker has none, and `--nudge-timeout` with `--provider claude-code` is an input error.

## Turn cap

`--max-turns N` stops a worker after N assistant turns. pi and `claude -p` have no turn cap, so the
harness counts the turns in the live event stream. When the count passes N, the harness stops the
worker and records the error `max-turns`. Without the option, only `--timeout` stops a worker.

Use the cap for a small local model that can loop. Measured on qwen3.5:9b-64k: complete rollouts
used 7 to 12 tool calls. Looping rollouts used 77 to 106 turns and ran until the timeout. A cap of
about twice the normal turn count stops a loop in minutes, not in an hour.

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

A usage limit stops the start of new workers and stops the workers that are running. Their records
say `stopped`, so a later call runs them again. The command then exits with code 75.

## Isolation

Each worker runs in a temp copy of its batch's `spec/` and `workspace/`. A worker cannot read another
worker's files. The harness deletes the copy when the worker stops, also after an error. If the delete fails, the
harness writes a warning and keeps the record.
