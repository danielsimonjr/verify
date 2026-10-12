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
  "model": {"provider": "ollama", "name": "qwen3.5:9b-64k", "digest": "809799ae09ab9ff5c3eb9c57f0f757560167e7768a52bb9cc7038016ddb3af67", "quantization": "Q4_K_M"},
  "charsPerToken": 3.6, "overheadTokens": 2000, "itemTokens": 0,
  "split": "heading:^### TODO line (\\d+)$", "reference": ["CHANGELOG.md"],
  "batches": [{"name": "b01", "items": ["6857", "6858"], "estTokens": 29674, "overBudget": false}]
}
```

All batch names of one run have the same width: `b01` to `b31`, or `b001` to `b120`. A sort by name is
also a sort by order.

`batch` reads the spec and the worker prompt for each `workspace/<file>` they name. A name that no batch
holds is printed as a `batch:` warning and listed in the manifest as `"missing": [{"file": "rows.md",
"namedBy": "spec/task.md"}]`. The usual cause is an items file with another name than the task expects:
`--items-name` sets it. A pattern (`workspace/a*.md`) and a placeholder (`workspace/<name>`) are not files.

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
`peakContext` tests it. When `peakContext` is above `estTokens` and above the `budget` of the
manifest, the command writes a line to stderr with the `--item-tokens` value that would have covered
the batch. A peak above the estimate and inside the budget writes no line: the batch fit, and a
`batch` call with that value would give the same split. Use the value, or one measured on your own
task, in the next `batch` call. A default cannot know what one item costs: that depends on
the task, the tools and the model. Each rollout of a batch gives its own value. Take the largest
value over all rollouts of all batches, not the value of one probe: one rollout is one sample of a
cost that varies from run to run.

`compactions` is the number of times the agent compacted its context. Each compaction drops the
older turns, so a worker that compacted answers from turns it no longer holds. pi compacts when the
context passes the window less its reserve of 16384 tokens, and `workers` writes that point and the
peak in its stderr line. A rollout with a compaction ends as `compacted`: its deliverable is kept, and
the batch with the results of its tools did not fit under that point. `--retries` runs it again, and
the deliverable of the attempt before is kept in `trajectory/attempt-N/deliverables/`. Make the batches
smaller if it repeats. `--allow-compaction` accepts such a rollout. A window at or below the reserve
makes every rollout compact, and `workers` writes a warning before it starts.
Compaction caps `peakContext`, so the suggested `--item-tokens` of a compacted rollout is a lower
bound: the line says "at least".

At the end of a run, `workers` writes the largest `--item-tokens` suggestion over all rollouts, and
the summary line has it as `itemTokens`.

`toolErrors` is the number of tool calls that failed. `toolErrorKinds` splits them by what each failed
result said: `invalid` (the tool refused the arguments, for example none), `missing` (a path or file the
task does not have), `repeated` (the repeat guard blocked a call that the session had already made) and
`other`. `workers` writes a stderr line when at least half of at least five calls failed, and the line
names the class that occurred most.

`timeoutWriting` is present, and true, for a `timeout` that came while the model was writing prose,
not while it worked. A model that writes one row of its report many times is such a case. `--retries`
runs that rollout again (see Retries).

`batch` writes `model` (`provider` and `name`) into the manifest, and `workers` writes the same pair as
`model` into each `worker.json`. A local model is named by tag, and a tag can be re-created under the
same name with other weights. For that reason `batch` adds the `digest` that the server lists for the tag
and, when it lists one, the `quantization`; `workers` writes them as `modelIdentity`. Two runs with the
same name and a different digest ran different weights. A server that lists no digest, and a Claude Code
model, leave the digest fields out.

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
| `stuck` | The session ended in its tool calls: the guard stopped it after three turns in a row in which every tool call failed, or its last turn asked for a tool. A pi worker only. |
| `no-json` | A `.json` deliverable, and the final text holds no JSON. |
| `length` | The last turn ended at the output-token limit, or the runaway guard cut it (it held more records than the batch has items, or one unit of text again and again). Its text is cut. |
| `thinking-only` | The last turn held thinking and no text: the model spent its output on thought. |
| `no-tool-calls` | A pi worker was offered tools and made no tool call. Its answer, whatever it says, rests on nothing it read. |
| `schema` | The deliverable is JSON but does not fit the `--schema` file. |
| `ids` | The deliverable fits the schema, and the ids of its records are not the ids of the batch (`--ids`). |
| `compacted` | The agent compacted its context. The deliverable is kept; see `--retries` and `--allow-compaction`. |

When a rollout ends with an error and its last turn had text, the harness keeps that text as
`deliverables/<name>.partial.txt`. A timeout, a cut or a stop no longer loses what the worker wrote.
For `schema`, the file `deliverables/<name>.schema-errors.txt` lists each error with its path. For `ids`,
`deliverables/<name>.ids-errors.txt` lists the ids that are missing, not in the batch or repeated.

## Deliverable schema

`--schema FILE` checks each parsed deliverable against a JSON Schema file. A value that parses is
not yet a deliverable: it must have the shape the task asked for. The check knows `type`, `enum`,
`const`, `required`, `properties`, `additionalProperties`, `items`, `minItems`, `maxItems`,
`minimum`, `maximum` and `anyOf`. A schema that holds any other keyword is an input error, so a
schema is never passed by a part that the check skipped.

## Deliverable ids

A schema checks types. It does not know which rows the batch holds, so a report that fits the schema
can cover other rows than the batch's, or only some of them. `--ids ARRAY.FIELD` names the array of
the deliverable and the field of each record that holds its id. `--ids rows.line` checks that every
record of `rows` has a `line`, and that the `line` values are the item ids of the batch, each once. The
ids come from `manifest.json` of the batch root, so the option needs a root that `batch` made. A number
and a string with the same digits are the same id. The order of the records is not checked. The
worker charter lists the array, the id field and the ids of the batch, so the model has them in
every turn, and after a compaction.

The check runs after the schema check, and only when the schema passes. A deliverable that fails it ends
as `ids`, and a pi worker is sent the error once, in the same session, as for a schema error (see
Nudge). The
message lists the ids that are missing, the ids that are not in the batch and the ids that are
repeated, up to twelve of each.

## Retries

`--retries N` runs a rollout again, up to N more times, when its error is `no-result`, `no-json`,
`thinking-only`, `length`, `schema`, `ids`, `no-tool-calls`, `stuck` or `compacted`: the model's output
was wrong or empty, its tool calls failed in a row, or its context filled, and a second try can differ.
A `timeout` is repeated when `worker.json` has `timeoutWriting`: the time
ran out while the model wrote prose, and a new session does not repeat that. A `timeout` of a worker
that was working is the speed of the batch or the model, and a new session repeats it. A
`usage-limit`, a `stopped` and a `max-turns` are never repeated. Each printed line and each
`worker.json` has `attempts`. A retry runs in the same rollout folder, so the harness first
moves the stream and the record of the attempt before it to `trajectory/attempt-N/`. A rollout that
took three tries shows all three. `seconds` is the time of the last attempt; `totalSeconds` is the time of
all of them.

## Nudge

Three things end a pi session with no answer: the time limit, a last turn of thought alone, and a
last turn cut at the output limit. A fourth is a session that the guard stopped after failed tool
calls. A fifth is a final message without the JSON, and a sixth is a final message whose JSON stops
being JSON at some place. A seventh is an answer that parses and does not fit the `--schema` file, and
an eighth is an answer that fits it and has the wrong `--ids`. Each one used to throw away what the
worker had found. `workers` now continues the same session with a short message: stop investigating,
do not think further, write the answer now. The message depends on the cause. For a schema or an ids
error it lists the errors (the first eight). For a JSON that is not valid it names the character where
the text stops being JSON, the rule that it breaks and the text around that place. For a stuck session
it says that the tool calls failed or repeated an earlier call and that no tool is offered.

A session is sent back once for each kind of failure: `time`, `cut`, `stuck`, `format`, `json`,
`schema` and `ids`. An answer that is put right can fail the next check. A model that answered in
prose, then in the wrong shape, then with the wrong ids needs three messages, and one message for all
three kinds leaves the last check with no chance. A kind is never sent twice, so a session gets seven
messages at most.

A nudge turn offers no tools (`--no-tools`): a chat template such as llama3.1's tells a model that
holds tools to answer with a function call, so a nudge that left the tools on was answered with more
tool calls. Before a nudge, the harness removes the last message of the saved session when that
message was cut at the output limit, or aborted by the guard, or is the empty turn that an abort ended
after a tool result. A cut message is mostly a runaway (one row written many times), and the model
would read its own loop again. `agent.jsonl` keeps the message. Each nudge has its own
budget: `--nudge-timeout S` (default 300; 0 turns it off). The
record has `nudged: true` and `nudges`, the number of messages sent, and `agent.jsonl` holds every
session. A nudge needs a saved session, so a Claude Code worker has none, and `--nudge-timeout` with
`--provider claude-code` is an input error.

## Session guard

A small model can repeat one tool call, again and again, until its context is full, or call a tool with
arguments that it does not accept. A pi worker therefore loads one extension, the guard
(`harness/pi-extensions/repeat-guard.ts`), which does three things with tool calls and one with the
answer.

**Repeated calls.** The tools of a worker only read, so a repeat returns the text that the model
already has. The guard blocks a `read`, `grep`, `find` or `ls` call that has the same tool and the same
arguments as an earlier call of the session. In place of the result, the model reads: the call is the
same as an earlier call, its result is in the context, use a different call or write the final answer.
Two arguments are the same when they have the same value: `10` and `"10"` are one argument, and the
order of the keys does not matter. A compaction clears the guard, because the results that it replaced
are no longer in the context. A call of any other tool (`edit`, `write`, `bash`) clears it too: the same
read after it can return other text. The record counts a blocked call in `toolErrors`, in the class
`repeated`.

**Failed calls in a row.** Three turns in a row in which every tool call failed stop the session,
whatever the cause: a block, arguments that the tool does not accept, or a path that is not there. The
turn is the unit because pi runs the calls of one message together, so the model has read none of
their results when they end; the charter asks for one call in each message, so a turn is mostly one
call. A turn in which one call worked starts the count again, and so does a compaction. The count is
three because, over three runs of a local model, a streak of two failed calls was followed by a call
that worked in 12 of 16 cases, and a streak of three or more in 3 of 22. The session then has no
answer: its error is `stuck`, and the nudge for it (`--no-tools`) asks for the answer from what the
worker has found.

**Result size.** One result can be the call that forces a compaction: pi cuts a result at 50 KB, which
is 14 000 to 16 000 tokens of a llama model. The guard cuts a result to half of the room that is left
before pi compacts (the window less the reserve of 16384 tokens, less the context in use, less the
results of the same message that the context does not hold yet), at the end of a line where it can,
and ends the result with a line that says how many characters it had, how much room is left and how
to ask for less. A result is never cut below 1000 characters.

**Runaway message.** The guard also reads the text of the message that the model is writing. A final
message can repeat one row until the output limit: one batch of four rows came back as 129 rows of the
same id, 8192 tokens and ten minutes of a local model. The guard cuts a message when it holds more
records than the batch has items (it counts the key of `--ids ARRAY.FIELD` at the shallowest depth
where it is written, so a nested object with a key of the same name is not a record; the harness gives
it the field and the number of items), or when the end of the text is one unit of 24 to 600
characters written 12 times in a row (a batch with no ids, or a runaway of another shape). A cut
message ends with the stop reason `aborted`. The record has the error `length`, as for a message that
reached the limit, and the nudge for it removes the message from the session before it asks for the
answer.

With `--ids`, the output limit of the model is also cut to the answer that the batch needs: 1024 tokens
for each item and 1024 for the rest of the message, and never less than 4096, because the limit is
the one of every turn of the session. The longest record that a model was measured to write took 378
tokens, so the room is about 2.7 times that. A runaway then ends in a few thousand tokens, not in the
8192 of the default. `--max-tokens`, and `VERIHARNESS_MAX_TOKENS`, replace the cap, `--thinking` keeps
the limit of the provider because thought is output too, and the cap never raises a limit.

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
