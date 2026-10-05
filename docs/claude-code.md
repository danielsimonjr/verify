# Claude Code as the verifier

The verifier can run on Claude Haiku or Claude Sonnet through the `claude` command-line program (Claude Code). The harness starts `claude -p` for each turn. It uses the login that Claude Code already holds. It does not read, set or print a credential.

The agent loop is Claude Code's. The four verifier turns, the records and the delivery gate are the harness's, and they are the same as for the other providers. The driver judges a turn by the files the verifier wrote, not by what the CLI printed.

## Requirements

- Claude Code 2.1 or later, signed in on the host. `claude --version` must work.
- `--env none`. The jail replaces `$HOME`, so Claude Code finds no login in it. The containers of the native environments run pi only. `--env jail`, `native` and `native-full` stop with an error.
- Python 3 with `openpyxl` and `python-docx` on `PATH` when the task delivers spreadsheets or Word documents. The repair instructions (`harness/prompts/REPAIR.md`) tell the verifier to use them.
- Windows or Linux. On Windows, Claude Code needs Git for Windows. Set `VERIHARNESS_CLAUDE_BIN` (or `--claude-bin`) to `claude.exe`. Node cannot start a `.cmd` shim, and the driver says so when it fails to start one.

## Commands

```bash
# Check the CLI and the login. Prints the CLI version, the model and the credential source.
bun harness/cli.ts model-check --provider claude-code --model claude-haiku-4-5-20251001

# One task.
bun harness/cli.ts driver <task-dir> --provider claude-code --model claude-haiku-4-5-20251001 --env none

# A benchmark cell on the haiku lane, with four concurrent drivers.
bun harness/cli.ts runner --run-name demo --cells sb2:haiku --env none --lane-max haiku=4
```

`--model` is required and is a full model id. The lanes `haiku` (`claude-haiku-4-5-20251001`) and `sonnet` (`claude-sonnet-5-5`) are in `harness/config.ts`. A lane applies to a runner cell the same way as `flash` and `opus`.

`model-check` runs one isolated turn with no tools and no saved session. It prints a JSON report with the fields `provider`, `requestedModel`, `model` (the model Claude Code reports), `cliVersion`, `keySource` (as Claude Code reports it; `none` with a subscription login), `tools`, `warnings`, `builtinPlugins` and `reply`. It exits with 1 when the CLI does not start or the turn fails, and the error says which. It exits with 2 when the arguments are wrong.

The driver starts a task with `claude --version` only. It does not spend a model turn on a preflight.

These options are not supported with this provider, and the driver refuses them: `--thinking`, `--base-url`, `--context-size`, `--temperature`, `--max-tokens`, `--top-p`, `--request-timeout`. `model-check` accepts `--request-timeout` and refuses the rest. When the runner overrides a lane onto `claude-code`, it drops the lane's `--thinking` value.

## How a turn runs

Each turn is one `claude` process, started in the task directory:

```
claude -p --output-format stream-json --verbose --model <id>
       (--session-id <uuid> | --resume <uuid>)
       --setting-sources "" --strict-mcp-config --settings {"disableAllHooks":true}
       --tools <list> --permission-mode bypassPermissions
       --append-system-prompt-file <ws>/session/charter.md
       [--add-dir <skills directory>]...
```

The message goes to standard input. It never goes on the command line. A mission with its skills is longer than the 32,767 characters that a Windows command line holds. The charter goes in `session/charter.md` for the same reason.

| Part | Effect |
| --- | --- |
| `--setting-sources ""` | Loads no user, project or local settings file. |
| `--strict-mcp-config` | Loads no MCP server, because none is named. |
| `--settings {"disableAllHooks":true}` | Runs no hook, whether it comes from a settings file or a plugin. |
| `--tools` | Names the only tools. Pick-only contracts get `Read,Bash,Grep,Glob`. Artifact contracts add `Edit,Write`. |
| `--permission-mode bypassPermissions` | Never asks. There is nobody to answer. |
| `--add-dir` | Lets `Read` open the skill library. The skill text names each skill directory by its absolute path. |

The pi tool names map to Claude Code tool names: `read` to `Read`, `bash` to `Bash`, `grep` to `Grep`, `find` and `ls` to `Glob`, `edit` to `Edit`, `write` to `Write`.

The first `system/init` event of a task goes to `driver.log`: the CLI version, the model, the credential source and the tool list. The driver logs a warning when the event lists an MCP server or a plugin that is not built in, because the isolation flags should have removed both.

Claude Code loads its own built-in plugins whatever the setting sources are. Their names start with `cc-plugin-`, for example `cc-plugin-agents-md`, `cc-plugin-telemetry` and `cc-plugin-plugin-authoring`. The driver logs them on a separate line and does not warn about them. `model-check` lists them in `builtinPlugins`.

### What these flags do not guarantee

- `--env none` is not a security boundary. The verifier's `Bash` tool runs on the host with the permissions of the user who started the driver. Run the driver on a host where that is acceptable.
- The harness does not check whether a `CLAUDE.md` or `AGENTS.md` in a parent directory of the task directory loads into the session. The built-in plugins above are not disabled by any flag the driver passes. To see what a session loaded, read the first lines of its transcript in `session/<name>/`, and keep `CLAUDE.md` and `AGENTS.md` files out of the directories above the runs directory.
- The skills use `/tmp/...` paths for rendered pages, and the evidence skills tell the verifier to open them with `Read`. On Windows, `Read` needs a native path, so a verifier that follows the text literally can fail to open a rendered page. The text evidence (`.cells.tsv`, `.text.txt`) is not affected.

## Sessions and files

Claude Code keeps a copy of each session in its configuration directory, and `--resume` reads that copy. The configuration directory is `CLAUDE_CONFIG_DIR` when it is set, and `~/.claude` otherwise.

- A new session gets a UUID from the driver and starts with `--session-id`.
- The adjudication turn and the delivery turn share one session. The delivery turn starts with `--resume`.
- Each investigation, and the adjudication, has its own session.
- When a retry follows a failed turn, the driver resumes the session only if Claude Code saved a copy. Otherwise it starts the same UUID again.

The stream of events of each turn is appended to `<task>/session/<name>/<uuid>.jsonl`. `<name>` is `elim`, `fals` or `adjudicate`. The own-record check reads these files. A record counts as the verifier's own when a `Write` of the record path carried content that parses, or when a `Bash` command named the record, or an `Edit` or `MultiEdit` changed it, and the file on disk parses. The last such call wins. A file that another session wrote does not count.

When the task ends, the driver moves the saved copy of each session it created to `<task>/session/<name>/claude-persisted/<uuid>.jsonl`. The move runs in a `finally` block and again on process exit. A kill that gives the driver no chance to run code leaves the copies in the configuration directory. The configuration directory can hold the sessions of the user and of other agents. The move therefore touches only these:

- A file named `<uuid>.jsonl` for a UUID that this task created. The driver finds it with the pattern `<config dir>/projects/*/<uuid>.jsonl`. It does not reproduce Claude Code's way of naming the project directory.
- The project directory that held it, and only when it is empty after the move. The driver never deletes a directory recursively and never matches a glob.

## Failures and retries

| Event | What the harness does |
| --- | --- |
| Exit code 0 and a `result` event with `is_error` false | The turn succeeded. |
| A transient fault: a 429 or 5xx, `overloaded`, `rate_limit`, a dropped connection | Waits 30, 90 and 180 seconds, and retries up to three times. The retry resumes the session when a saved copy exists. |
| A usage limit | Does not retry. The limit lasts hours and the account is shared. The driver exits with code 75. |
| Another failure | The turn fails. The driver then runs its usual single nudge turn. |
| A timeout (`--turn-timeout`, `--nudge-timeout`, `--task-timeout`) | Kills the whole process tree: `taskkill /T /F` on Windows, a leaf-first kill on Linux. |
| `claude` does not start | The turn fails. The log names the command. |

A usage limit that stops a task before `finish.json` exists leaves a task that the runner stages again on the next run. A usage limit during the repair turn happens after the adjudication chose a base. The driver then writes `"error": "usage-limit"` into the `repair` block of `finish.json`. The runner counts a task with a `finish.json` as finished and skips it. Scoring treats the missing delivery as a delivery that failed the bundle contract, as it does for any repair turn that wrote no valid bundle. Delete the task directory to run the task again.

The runner treats exit code 75 as the status `usage-limit`. It stops the lane that hit the limit and does not start its queued tasks. It counts them as `lane-stopped`. Other lanes continue.

## Concurrency

Every Claude Code session of the account counts against one usage limit, and the user's own sessions count too. The `haiku` and `sonnet` lanes therefore start at 2 concurrent drivers each. `--lane-max haiku=4` raises one lane, and the option can repeat or take a comma list (`--lane-max haiku=4,sonnet=2`). `--max-flash` and `--max-opus` stay as aliases for `--lane-max flash=N` and `--lane-max opus=N`. The order of precedence is the lane default, then the alias, then `--lane-max`.

The runner also counts the drivers that other runners started on the same host. It finds them with `pgrep`, so those runners must use the same limits. Windows has no `pgrep`. A runner on Windows counts only its own drivers, so give each runner a limit that leaves room for the others.

## The environment of the verifier

The driver can start inside a Claude Code session, for example from a tool that session runs. A verifier that inherits the variables of that session behaves as a child of it. The driver therefore removes the variables that name or reach one running session. It removes them case-insensitively, because Windows ignores case in names.

| Variable | Reason for removal |
| --- | --- |
| `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID` | Name the parent session, its entry point and its program. |
| `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ATTENDED` | Mark the process as a child session. In Claude Code 2.1.289, `CLAUDE_CODE_CHILD_SESSION` can turn off the saved copy of a session. `--resume` needs that copy. |
| `CLAUDE_CODE_SSE_PORT` | Points at the IDE connection of the parent. |
| `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN` | Reach the message channel of the parent. The token is not an Anthropic credential. It opens that channel, and the verifier's `Bash` tool could read it. |
| `AI_AGENT`, `CLAUDE_EFFORT`, `TRACEPARENT` | Carry the parent's agent identity, effort level and trace. |

The driver never removes the login or the choice of provider: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`. It also keeps `CLAUDE_CONFIG_DIR` and the user's settings, for example `CLAUDE_CODE_GIT_BASH_PATH` and `CLAUDE_CODE_MAX_OUTPUT_TOKENS`. A test checks that no name appears in both lists. The driver also removes the grader-only variables, as for every provider.

## Tests

The suite uses a stand-in `claude` program (`tests/fixtures/verify-claude-code/stub.mjs`). It records each call and scripts its answers. No test starts the real program or contacts a model, and every test sets `CLAUDE_CONFIG_DIR` to a temporary directory.

One opt-in test uses the real program and the real login. It runs `model-check` on `claude-haiku-4-5-20251001`, then one driver task on a small fixture with `--env none`:

```bash
VERIHARNESS_LIVE_CLAUDE=1 bun test tests/verify-claude-code-live.test.ts
```

Without the variable, the test is skipped.
