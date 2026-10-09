# Local models

The verifier can run against a model on this machine, through [Ollama](https://ollama.com) or through [llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server`, in addition to the hosted providers pi already supports. No API key is required.

The agent loop (tools, sessions, the four verifier turns) still runs in [pi](https://github.com/danielsimonjr/pi). Before the first turn the harness talks to the local server itself: it checks that the process is up, that the model is pulled or loaded, and that the model can call tools. Hosted lanes are unchanged.

## Why tool calling is required

A verifier turn reads the workspace and writes `ledger_*.json`, `finish.json` and the delivered files. That only happens if the model can call pi's tools (`read`, `bash`, `grep`, `find`, `ls`, and `edit`/`write` on an artifact contract). If the server says the model has no tools, or a required tool call comes back as plain text, the harness stops with an error. It does not start a turn that would end as an empty ledger.

JSON mode is separate. A normal run does not ask for it; the model writes JSON files through the `write` tool. If a caller does request JSON mode and the server rejects it, or the body is prose rather than JSON, that call fails. The JSON constraint is not silently removed. A tool call is itself structured, so a reply that is only a tool call is accepted.

`--thinking` is a hosted-model flag. The runner drops a lane's `--thinking` value when you override that lane onto `ollama` or `llamacpp`. Pass `--thinking` yourself only when the local model actually supports it.

## Ollama

Install Ollama, start it, and pull a tool-capable model:

```bash
ollama serve
ollama pull qwen2.5-coder:7b
```

Check the server, then run one task:

```bash
bun harness/cli.ts model-check --provider ollama --model qwen2.5-coder:7b
bun harness/cli.ts driver path/to/task --provider ollama --model qwen2.5-coder:7b --env none
```

The default base URL is `http://127.0.0.1:11434`. Override it with `--base-url` or `VERIHARNESS_OLLAMA_BASE_URL`. `OLLAMA_HOST` is also honoured (`127.0.0.1:11434` or a full URL). A bind address of `0.0.0.0` is rewritten to `127.0.0.1` for the client.

The harness probes Ollama's native API (`/api/tags`, `/api/show`, `/api/ps`, `/api/chat`). pi then calls the OpenAI-compatible API at `<base>/v1`, which is what the agent loop speaks. A model that is not pulled fails with `ollama pull <name>` rather than a generic connection error.

### Context length

pi 0.84.4 subtracts a 4096-token reserve from the registered context window before it will generate, so a window of 4096 or less cannot run a turn. The harness reads the effective window from the server and refuses to invent one (there is no silent 32768 default).

For Ollama, a model that is already loaded reports its effective window as `context_length` on `GET /api/ps`. That value wins, because it is the window the process is actually using. Otherwise the harness reads the `num_ctx` parameter from `ollama show`. The architecture `context_length` inside `model_info` is the model's maximum, not the window the server will use, so it is ignored. If neither source is present, preflight fails:

```bash
OLLAMA_CONTEXT_LENGTH=32768 ollama serve
ollama run qwen2.5-coder:7b ""
```

The second command loads the model. `OLLAMA_CONTEXT_LENGTH` is a setting of the server, so `ollama show` does not report it. Only `GET /api/ps` reports it, and only for a loaded model. Ollama unloads an idle model after 5 minutes unless `OLLAMA_KEEP_ALIVE` says otherwise, so run `model-check` or the driver soon after the load.

As an alternative, set the window in a model variant. Save these two lines in a file named `Modelfile`:

```
FROM qwen2.5-coder:7b
PARAMETER num_ctx 32768
```

Then create the variant and pass its name to `--model`:

```bash
ollama create qwen2.5-coder-32k -f Modelfile
bun harness/cli.ts model-check --provider ollama --model qwen2.5-coder-32k
```

`ollama create` reads the Modelfile only from the file named by `-f` (default `./Modelfile`). It does not read standard input. `ollama show` reports the `num_ctx` of the variant at once, with no load step.

Ollama's OpenAI endpoint, which is what pi calls, uses that configured context rather than a per-request field. `--context-size` is accepted only when the advertised window is at least that large. The window registered with pi is the requested size when you pass one, and the advertised window otherwise. A window of 4096 or less is an error. A window above 4096 and below 8192 still runs, with a warning: verifier tasks are long.

`--context-size auto` uses the server's window. It also overrides `VERIHARNESS_CONTEXT_SIZE`; with no option, the variable applies. The driver writes one line for each role to `driver.log`:

```
context: checker=ollama:qwen3.5:9b-64k window=65536 source=loaded
```

The source is `loaded` (from `GET /api/ps`), `num_ctx` (from `ollama show`), `n_ctx` (llama.cpp), `table` (a Claude Code model, from the table in `harness/config.ts`) or `explicit` (a number you passed). `model-check` reports the same two values as `window` and `windowSource`.

The harness sends no `num_ctx` in its own requests, so it does not cause a reload. Another client of the same server can. When a role asks for a number and the model is loaded with a different window, the driver writes a warning and continues:

```
context: checker asks 8192, the server runs qwen3.5:9b-64k at 65536; a client that sends num_ctx may reload it
```

### Request options

| Flag | Environment | Meaning |
| --- | --- | --- |
| `--model` | | Model name (`qwen2.5-coder:7b`). Required. `name` matches `name:latest`. |
| `--base-url` | `VERIHARNESS_OLLAMA_BASE_URL`, then `OLLAMA_HOST` | Server root. Default `http://127.0.0.1:11434`. |
| `--temperature` | `VERIHARNESS_TEMPERATURE` | Sampling temperature. Omitted unless set, so the model's own default stands. `0.2` is a reasonable verifier setting. |
| `--top-p` | `VERIHARNESS_TOP_P` | Nucleus sampling. |
| `--max-tokens` | `VERIHARNESS_MAX_TOKENS` | Maximum tokens pi may generate in one reply. Default ceiling 8192, capped by the context window. |
| `--context-size` | `VERIHARNESS_CONTEXT_SIZE` | Context to register with pi. `auto`, or a positive integer no larger than the window the server advertises, and greater than 4096. `auto` uses the server's window, also when the variable is set. |
| `--request-timeout` | `VERIHARNESS_MODEL_TIMEOUT` | Seconds for the preflight HTTP calls. Default 180. |

`model-check` prints the probed capabilities as JSON. `bun harness/cli.ts runner` accepts the same flags and applies them to every cell, in place of that lane's hosted provider. Example:

```bash
bun harness/cli.ts runner --run-name local --cells sb2:flash \
  --provider ollama --model qwen2.5-coder:7b --temperature 0.2
```

## A local model for some roles

A local model can take some roles while a hosted model takes the others, for example a local Checker and Challenger and a Claude Code Reviewer. Use `--role ROLE=ollama:MODEL`, `--role-base-url` and `--role-context-size`. Each local role gets its own preflight. See [roles.md](roles.md).

## llama.cpp

Use `llama-server` from a current llama.cpp build. The harness speaks its OpenAI-compatible HTTP API. The default address is `http://127.0.0.1:8080`.

Single model:

```bash
llama-server -m ~/models/model.gguf --host 127.0.0.1 --port 8080 --jinja -c 32768
```

`--jinja` turns on the chat template path that implements tool calls. Without it, preflight fails and names that flag. Do not pass `--api-key`: the harness does not send an `Authorization` header, so a server that requires a key will reject every call.

Router mode (several GGUF files, load on demand) is the same HTTP API:

```bash
llama-server --models-dir ~/models --host 127.0.0.1 --port 8080 --jinja -c 32768
```

`--model` must be an id from `GET /v1/models` (a loaded model). A unique filename such as `model.gguf` matches a longer server id. A model that is only present and not loaded fails with the list of loaded ids, instead of silently talking to a different file.

Context length is the server's `-c` / `--ctx-size`. Preflight reads `n_ctx` from `GET /props?model=<id>`, and from `GET /props` only when that query returns 404. If `n_ctx` is missing, preflight fails instead of assuming a window. `--context-size` larger than `n_ctx`, or a window of 4096 or less, is an error. Context is not a per-request field; restart the server with a larger `-c`.

```bash
bun harness/cli.ts model-check --provider llamacpp --model model.gguf
bun harness/cli.ts driver path/to/task --provider llamacpp --model model.gguf \
  --base-url http://127.0.0.1:8080 --env none
```

`--provider llama.cpp` and `--provider llama-cpp` are the same backend. The base URL is `--base-url`, then `VERIHARNESS_LLAMACPP_BASE_URL`, then `LLAMA_BASE_URL`, then `http://127.0.0.1:8080`. A URL that already ends in `/v1` is accepted.

Temperature, top-p, max tokens and the request timeout are the same flags as Ollama.

## What the harness sends

Ollama native chat (`POST /api/chat`):

- `stream: false` unless you are streaming. Ollama's default is to stream, so this is set explicitly.
- `tools` / `tool_choice` when the call includes tools.
- `format: "json"` only when JSON mode was requested.
- `options.num_ctx`, `options.temperature`, `options.top_p`, `options.num_predict` when those were set.
- Token counts are read from `prompt_eval_count` and `eval_count`. Missing counts stay missing; they are not estimated.
- A streamed tool call in one chunk is kept when the next chunk carries a different call. A repeated id updates that call. An `{"error":"..."}` frame, or a stream that ends without `done: true`, fails the call.

llama-server chat (`POST /v1/chat/completions`):

- OpenAI chat messages, tools and `response_format: { "type": "json_object" }` when requested.
- `stream_options.include_usage` on streaming calls. If the server rejects that field, the request is retried once without it. Tool and JSON fields are never removed to make a call succeed.
- Token counts are read from `usage.prompt_tokens` and `usage.completion_tokens`.
- An SSE `error` payload, or a stream that ends with neither `finish_reason` nor `data: [DONE]`, fails the call. Partial text is not returned as a completed reply.

pi receives a generated `models.json` under the task's `.pi/` directory (`PI_CODING_AGENT_DIR`). It points at `<base>/v1` with `api: "openai-completions"`. The file contains a placeholder `apiKey` of `local` because pi will not select a provider that has no credential. That placeholder is not a secret, the harness HTTP client never sends it, and a default Ollama or llama-server ignores it. The committed `harness/pi-home/models.json` (the Vertex proxy) is not modified.

`compat.maxTokensField` is `max_tokens`. pi 0.84.4 would otherwise send `max_completion_tokens`, which Ollama's `/v1` adapter does not apply to `num_predict`, so the output cap would be silently ignored.

Sampling options you set are copied into that model's `samplingParams`, which is how temperature reaches the agent loop.

## Failures

| What you see | What it means |
| --- | --- |
| `Ollama is not reachable` / `llama-server is not reachable` | Nothing is listening. The connection is not retried: the server is down, not busy. |
| `does not have model` / `ollama pull` | The server is up and the model is not pulled. |
| `not serving model` / `not loaded` | llama-server is up, but that id is not the loaded model. |
| `still loading` | llama-server returned 503. Retry after the weights are in memory. |
| `does not support tool calling` | The verifier cannot use this model. Pick one with tools, or restart llama-server with `--jinja`. |
| `not JSON` | JSON mode was requested and the body was not a JSON value. The text is discarded. |
| `does not advertise num_ctx` / `did not report n_ctx` | The server did not say how large the context is. Set it and retry. The harness does not assume 32768. |
| `4096 or less` | pi reserves 4096 tokens, so that window cannot generate a reply. |
| `num_ctx` / `context` too small | The server is configured with a shorter window than `--context-size`. |

Transient HTTP statuses (408, 429, 500, 502, 503, 504) and connection resets are retried. `VERIHARNESS_MODEL_RETRIES` is the extra attempt count (default 2). A model that answered a required tool call is remembered for six hours under the system temp directory so a batch does not repeat the probe. Failures are not cached. Set `VERIHARNESS_MODEL_CACHE=0` to probe every time.

`VERIHARNESS_ASSUME_TOOLS=1` skips the probe when the server does not advertise tool support. An explicit "no tools" capability still fails. If the assumption is wrong, the run does not produce a ledger.

## In-process GGUF bindings

An in-process binding such as `node-llama-cpp` is not used. The verifier's tool loop lives in pi and already speaks HTTP, which is the API `llama-server` exposes, so a second runtime would not replace that process. A native addon is also a poor fit for this repo: development runs on Bun and production on Node, the jail bind-mounts a read-only Node, and CI cannot load a GGUF. Keeping the server out of process means the same client covers single-model and router mode, and tests mock HTTP instead of weights.

## Live tests

Unit tests mock HTTP and always run. A real server is opt-in:

```bash
VERIHARNESS_LIVE_OLLAMA=1 VERIHARNESS_OLLAMA_MODEL=qwen2.5:7b bun test tests/model.live.test.ts
VERIHARNESS_LIVE_LLAMACPP=1 VERIHARNESS_LLAMACPP_MODEL=model.gguf bun test tests/model.live.test.ts
```
