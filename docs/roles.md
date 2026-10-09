# A model for each role

By default, the four verifier roles use one model: the model of `--provider`
and `--model` (or of the runner lane). Use `--role` to give a role its own
model and provider.

| Role | Phase | Writes |
|---|---|---|
| `checker` | the `elim` investigation | `ledger_elim.json` |
| `challenger` | the `fals` investigation | `ledger_fals.json` |
| `reviewer` | the adjudication | `finish.json` |
| `fixer` | the repair | `repair.json`, `out/deliverables/` |

## Options

The driver and the runner accept the same three options. Each option is
repeatable, one time for each role.

| Option | Value | Applies to |
|---|---|---|
| `--role ROLE=PROVIDER:MODEL` | The provider and the model of the role. The model id can contain colons (`ollama:qwen3.5:9b`). | all providers |
| `--role-base-url ROLE=URL` | The server of a local role. Refused for other providers. | `ollama`, `llamacpp` |
| `--role-context-size ROLE=N` | The context window of a local role. N must be `auto` or a whole number above 4096. `auto` uses the server's window. Refused for other providers. | `ollama`, `llamacpp` |

```bash
# A local Checker and Challenger; Claude Opus 5.5 reviews and fixes.
bun harness/cli.ts driver <task-dir> --provider claude-code --model claude-opus-5-5 --env none \
  --role checker=ollama:qwen3.5:9b --role challenger=ollama:qwen3.5:9b

# Claude Haiku 5.5 investigates; Claude Opus 5.5 reviews; Claude Sonnet 5.5 fixes.
bun harness/cli.ts driver <task-dir> --provider claude-code --model claude-haiku-5-5 --env none \
  --role reviewer=claude-code:claude-opus-5-5 --role fixer=claude-code:claude-sonnet-5-5

# The same roles for every task of a run.
bun harness/cli.ts runner --run-name demo --cells sb2:haiku --env none \
  --role reviewer=claude-code:claude-opus-5-5
```

## Rules

1. A role without `--role` uses the main model.
2. A fixer without `--role` uses the model of the reviewer.
3. A fixer on the model of the reviewer continues the session of the reviewer.
   The fixer then knows how the reviewer made the plan.
4. A fixer on a different model starts a new session. The harness tells it to
   read `finish.json`, the two ledgers, `MISSION.md` and the rollouts that
   `finish.json` names. `driver.log` records "fresh session".
5. A Claude Code role needs `--env none`. This is also true when the main
   provider is not Claude Code.
6. `--thinking`, `--temperature`, `--max-tokens`, `--top-p` and
   `--request-timeout` apply to the pi roles only. The driver refuses them only
   when no role runs pi.
7. `--base-url` and `--context-size` apply to the main model. A Claude Code main
   model refuses them. Use `--role-base-url` and `--role-context-size` for a
   local role.
8. The harness probes each different local role one time before the run. Each
   different local role gets its own pi home (`.pi`, `.pi-2`, `.pi-3`).
9. A usage limit in one Claude Code role stops all the Claude Code roles of the
   task. The driver exits with code 75.

## Local servers

The checker and the challenger run at the same time. When they use two
different models, or one model with two context sizes, on one local server, the
server must hold the two at the same time. If it cannot, it reloads on each
request and every turn becomes slow. The driver writes a warning to
`driver.log` for this case. Use one model and one context size for the two
roles, or use two servers:

```bash
--role checker=ollama:qwen3.5:9b --role challenger=ollama:qwen2.5-coder:7b \
  --role-base-url challenger=http://192.168.1.169:11434
```

## Records

* `driver.log` has one `roles:` line, for example
  `roles: checker=ollama:qwen3.5:9b challenger=ollama:qwen3.5:9b reviewer=claude-code:claude-opus-5-5 fixer=claude-code:claude-opus-5-5`.
* The runner writes the roles that `--role` set to `run.json` (`roles`), and the
  options to `driver_args`.
* The runner checks the options of each lane with the parser of the driver
  before it starts a task. A bad option stops the run with exit code 2.
