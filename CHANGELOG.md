# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] - 2026-10-09

### Added
- `.github/workflows/publish.yml`: a pushed `v*` tag publishes the package to npm, with provenance. `workflow_dispatch` with a `tag` input runs the same job again for a tag from v0.4.1 on. The tag must name `package.json`'s version (`scripts/publish-version-guard.mjs`), and a version already on npm is skipped. The job needs the repository secret `NPM`.

## [0.4.0] - 2026-10-09

### Added
- A model for each role. `--role ROLE=PROVIDER:MODEL` gives the Checker, the Challenger, the Reviewer or the Fixer its own provider and model. `--role-base-url ROLE=URL` and `--role-context-size ROLE=N` set the server and the context window of a local role. The driver and the runner accept the three options; each option can repeat. See `docs/roles.md`.
- A role without `--role` uses the main model. A Fixer without `--role` uses the Reviewer's model and continues its session. A Fixer on another model starts a new session that is told to read `finish.json`, the ledgers, `MISSION.md` and the named rollouts.
- `driver.log` has a `roles:` line. The runner writes the roles to `run.json` (`roles`).
- A warning in `driver.log` when the Checker and the Challenger use two models, or one model with two context sizes, on one local server.

### Changed
- The Claude Code runtimes of one task share one usage-limit state: a limit in one role stops every Claude Code role, and the driver exits with code 75.
- A Claude Code role needs `--env none` also when the main provider is not Claude Code. `--thinking`, `--temperature`, `--max-tokens`, `--top-p` and `--request-timeout` are refused only when no role runs pi.
- The runner checks each lane's driver options with the driver's own parser before it starts a task, in place of a separate Claude Code check.
- `--role-base-url` and `--role-context-size` are refused on a role that is not `ollama` or `llamacpp`, instead of being ignored.

### Fixed
- `docs/claude-code.md` named the `flash` lane in its cap sentence; the lane is `fable`.

## [0.3.0] - 2026-10-09

### Changed
- The lane `flash` is renamed `fable`, after the model it runs (`claude-fable-5-1`). `--max-flash` becomes `--max-fable`, and `--lane-max flash=N` is an unknown-lane error.
- New `POOL_LANES` in `harness/config.ts`: a pool whose name is not a lane takes its lane from it. The archived `flash` pools (Gemini 3.5 Flash rollouts) keep their name and run on the `fable` lane. `--lane` overrides this.
- README: the roles are named Worker, Checker, Challenger, Reviewer and Fixer, with a table that maps each name to its code and file names. The code, the prompts and the output files keep their names (`elim`, `fals`, `ADJUDICATE`, `REPAIR`). The two figures still show the earlier names; the README text says which is which.

## [0.2.0] - 2026-10-09

### Changed
- All four lanes run through Claude Code: `flash` is `claude-fable-5-1`, `opus` is `claude-opus-5-5`, `haiku` is `claude-haiku-5-5` and `sonnet` is `claude-sonnet-5-5`. The lanes `flash` and `opus` no longer use Vertex AI or the litellm proxy, and no lane sets a thinking level. `PROXIED_LANES` is removed from `harness/config.ts`.
- Every lane now needs `--env none`. The runner refuses a run without it, as it did for `haiku` and `sonnet`.
- The default concurrency caps are 2 for `flash` and `opus` and 4 for `haiku` and `sonnet`. All lanes share one Claude Code usage limit.
- The pi providers `google-vertex` and `vertex-litellm` stay available through `--provider`, but no lane uses them.

## [0.1.0] - 2026-10-06

First release, published to npm as `@danielsimonjr/verify`.

### Added
- The harness is TypeScript: Bun runs it in development and Node runs the built `dist/` in production (#1).
- Local model backends: Ollama and llama.cpp, with a `model-check` preflight that refuses a server that is down, a missing model, or a model that cannot call tools (#2).
- `writeFileAtomic` and `renameReplacing` in `harness/fsutil.ts`: one shared temp-file-and-rename write (#8).
- `--provider claude-code` runs the verifier on Claude Haiku and Claude Sonnet through the Claude Code CLI, with the login that Claude Code already holds (`docs/claude-code.md`). These lanes run without the jail: the verifier can read other tasks' results and answer keys, and the driver says so once per task (#11).
- Runner lanes `haiku` and `sonnet`, `--lane-max lane=N`, and `--env` passed to every driver. A usage limit (exit 75) stops the lane, because every session of an account shares it (#11).
- `model-check --provider claude-code` prints the CLI version, the model and the key source (#11).
- CI builds and smoke-runs the built CLI on Linux and Windows, and checks the jail on a real Linux kernel. A control run with capabilities must report every escape and every write, so a "no" in the jail run means the jail held (#9).

### Changed
- The pi agent runtime now comes from `@danielsimonjr/pi` (0.84.4, a fork of `earendil-works/pi` built from upstream `v0.84.4`) and not from `@earendil-works/pi-coding-agent`. `setup_pi.sh` installs it, `PI_SPEC` overrides the install spec, and `PI_CLI_JS` points into the new package directory.
- The package is named `@danielsimonjr/verify`. It was `veriharness`. The plain name `verify` on npm belongs to another package. The command is still `veriharness`: cmd.exe runs its built-in VERIFY command before it searches PATH, so a `verify` command would not run there. A test checks the package name, the command and both lockfiles (#19).
- The npm package ships `dist/` and `harness/` (its TypeScript source, prompts, skills and scripts) and leaves out `harness/vendor/`. `npm publish` runs the typecheck and the build first.

### Fixed
- Runner: an unknown `--lane` is rejected instead of stalling the scheduler; view renders are awaited before the driver starts; tasks run concurrently up to the lane and cell caps; `--sample` and `--fraction` choose the tasks that Python's `random.Random(seed).sample` chose; numeric options reject typos (#4).
- env-derive: images build concurrently up to `--jobs`, and a timed-out build is reported (#4).
- The built CLI resolves its prompts, skills, scripts and data from the repository root, and starts with a Node shebang (#5).
- WorkBuddy, JobBench and SB2 task keys split at the first `__` only (#5, #8).
- The `jb` and `wsb` judge preflights fail on a non-2xx response (#5).
- Model options: zero and negative `--request-timeout`, and zero, negative and fractional `--max-tokens`, `maxTokens`, `timeoutMs` and `retries`, are input errors; the Ollama context-window messages state what a user must run (#3).
- Skill scripts: PDF word coordinates start at the top-left of the displayed page; `pdf_tables` detects tables with pdfplumber; the PPTX, XLSX and PDF renderers fall back to PyMuPDF when Poppler is absent (#6).
- Materialized views keep PPTX speaker notes, grouped text and shape order, and read DOCX text, headings and merged cells as python-docx does (#6).
- Driver: a timed-out turn kills its whole process tree; a turn whose agent never started is reported; timeouts and options are validated; a base name from `finish.json` must be a real rollout (#7).
- Score: graded tasks are appended to `scores.partial.jsonl` as they finish, so a rerun resumes (#7).
- Materialize: meta is written before the done-marker; task keys are checked before any delete; the leak blocklist holds on Windows paths; the renderers and the five adapters match the Python they were ported from (#8).
- Grade: graders run asynchronously, stop the processes and containers that they start on a timeout, and report why they failed; `grade` refuses unknown options (#8).
- Skills: OOXML parts are read by namespace, so a DOCX or PPTX that binds the standard namespace to another prefix, or to the default namespace, reads as before; the markup-compatibility namespace (`mc:`) is mapped too, and a namespace URI that names an `Object.prototype` member is not taken for a standard one (#13).
- Skills: the LibreOffice converter removes a stale PDF before it runs and reports its exit status or signal when it prints nothing (#13).
- Jail: a Node or Python install under `$HOME` (nvm, pyenv) or under `/tmp` stays visible and read-only: the prefixes are bound back after the last cover (#13).
- Docs: `--env none` runs can leave a `setsid` descendant of a timed-out turn running; the README and `docs/claude-code.md` say so (#13).
- Grade: the SB2 batch grader keeps a task key such as `__proto__` in its result instead of dropping it (#13).
- Grade: APEX rejects a runner that wrote `grades.json` and then exited nonzero or was signalled; the judge-key counter is no longer wrapped at 1,000,000 (#13).
- Windows: an atomic write retries while an antivirus scan or the search indexer holds the target open; a relative output path in the current directory works under Bun (#8).
- Grade: a timed-out SB2 recalc waits for its `docker kill` (up to 40 s) before it returns. It waited 10 s, and the grade CLI then exited and ended a slower kill, which left the container running (#10).
- `ensureDir` accepts a directory that exists, such as a Windows drive root, where a recursive mkdir throws EPERM in Node and Bun (#10).
- An atomic write that fails removes a partly written temp file, and reports the write or rename error even when that cleanup fails (#10).
- Skill scripts: `pageprobe` and `xlsx_recalc` run on Windows; output directories go through one helper, so `--out .` works under Bun on Windows; a patchlab candidate splits at the first `=` only (#9).
- `bun run typecheck` checks `tests/` too, with the strict unused-code and implicit-return flags, and the dead code that they reported is removed (#9).
- A pi turn whose message or charter is over the Windows command-line limit sends them on stdin or in a file, and pi starts on Windows through its entry script (#11).
- `runWithBudget` marks a cut stderr as cut, and no longer splits a multi-byte character at a chunk boundary (#11).
- CHARTER.md matches MISSION.md, and states the `# cut at N cells` and 400,000-character limits of the rendered views (#11).
- `docs/local-models.md` and the context-length messages: load the model after setting `OLLAMA_CONTEXT_LENGTH`, and create a variant with `ollama create -f Modelfile` (#11).
- `VERIHARNESS_TMP` defaults to the OS temp directory when `/var/tmp` does not exist (#11).
- Tests: the env-derive timeout test gives its stub 2 s to start instead of 300 ms, and the Windows command-line test makes about 280 folders instead of 1,500, whose delete outlasted the 5 s cleanup hook. (#11).
- Model options: `timeoutMs` must be a whole number of milliseconds; a fractional count of seconds (`--request-timeout`, `VERIHARNESS_MODEL_TIMEOUT`) converts to whole milliseconds, and less than 1 ms is an error (#12).
- Ollama: a generated tool-call id never merges with a server id, in a stream or in a whole reply, so no call is lost (#12).
- `--jobs`, `--cell-cap`, `--lane-max` and `--limit` reject a digit string that is Infinity or an unsafe integer, through one helper, `parseCount` (#12).
- Score: tasks named `__proto__` or `constructor` are graded and saved on the batched path, and the bootstrap interval no longer depends on the order in which tasks finish (#12).
- Materialize: a task named `constructor` or `__proto__` is tracked correctly in `meta.json`; a WorkBuddy string reward must match Python `float()` syntax, so `0x10` is an error (#12).
- The `--skill=NAME` form is accepted like every other `--option=value`; a test and the README say so (#12).
- `secondsToMs` rejects a value below 0.001 s before rounding, so 0.0005 s no longer rounds up to 1 ms (#12).
- The Workspace-Bench (`wsb`) batch grader returns a prototype-free result, so a task named `__proto__` gets its own entry and reaches score (#12).
- A caller-supplied timeout above 2^31-1 ms (about 24.8 days) is clamped, because Node fires such a timer at once: `--request-timeout 2147484` aborted every model request after about 1 ms. `secondsToMs` says "finite" for an infinite product (#12).
- Tests: the env-derive concurrency test counts the builds that are open at once, behind a barrier in the stub docker, instead of timing them. Under CPU load the time check failed at 4.0 s to 7.1 s against its 2.5 s limit, and the old count failed once at 3 of 4, because a fourth build could start after the first one ended. The APEX event-loop test replaces its 400 ms gap limit, which a loaded host passed at 511 ms, with a handshake: the fake runner waits for an answer that only the grading process's event loop can write (#14).
- Tests: the suite has one test timeout, 30 s, from `bun test --timeout 30000` in the `test` script, and CI runs `bun run test`. In Bun 1.4.2 the flag reaches every file and every `beforeAll` and `afterAll` hook; `bunfig.toml` sets no test timeout, and a preloaded `setDefaultTimeout` reaches only the first file. The flag replaces a `setDefaultTimeout(30_000)` call in each of 12 files. Child-process tests measured up to 5.3 s on a loaded Windows host, against Bun's 5 s default. Tests fail when a file sets its own default again, or when a CI step runs a bare `bun test` (#14).
- Driver: what the verifier leaves under `out/` no longer stops the task before the repair block is in finish.json. A file where the bundle directory goes, a directory where a base file goes, or a file that cannot be read made the driver throw (EEXIST, EPERM). Now the delivery is invalid, and the error is its reason (#16).
- Graders: `run()` stops a process the same way when its output passes the stdout cap as when it times out. It kills the process tree, runs the stop hook, and returns after both. Before, the cap killed only the tree, so an SB2 recalc whose output passed 256 MiB left its container running. The hook is renamed from `onTimeout` to `onKill` (#17).
- Tests: the grandchild-kill test no longer races process start-up against a 2.5 s timer. The parent floods its output only after it writes the grandchild's pid, so the kill cannot come first. On Windows the grandchild is detached: a child that Bun or Node starts without `detached` dies with its parent, so the old test could not fail there (#17).
- Tests: the live Claude Code test requires the verifier to choose r1, the rollout with the right sum. It accepted either rollout, so a verifier that chose the wrong answer passed (#18).

### Security
- The driver refuses a delivery with a symlink at `out`, at `out/deliverables` or under it. Inside the jail the verifier can write `out/`, and the driver completes and checks the bundle on the host after the turn. Through a link, that would delete view-named files in a host directory, write base files into it, and list its file names into finish.json. Before the repair turn, it would also create the bundle directory through the link. Now the delivery is invalid, its reason names the link, and nothing under it is touched. A delivery path that the driver cannot check, such as a directory that it cannot list, is refused too (#16).
- Grading refuses a symlink at any step of what a grader reads: the bundle, each directory above it in the workspace, and the base rollout's trace. A link that the verifier makes resolves on the host at grade time. That side of the task stays ungraded, and its error names the link. The `grade` CLI, the APEX `answer.md` read and the WSB trace copy refuse links too (#15).
- SB2 grading refuses a `<task>_output.xlsx` that is a symlink, so a deliverable cannot make the grader read a host file (#13).
- The jail stops when a read-only remount fails, instead of warning and running with a writable skills, vendor or interpreter directory (#13).
- Staging deliverables for grading refuses symlinks instead of copying the files that they point at (#5).
- Grader and judge credentials no longer reach the verifier session (#7).
- Jail: the verifier command runs with no capabilities and `no_new_privs`, so it cannot unmount the covers or remount evidence read-write; `setpriv` is required (#7).
- pageprobe's static server serves only files under its root. It decodes the path once and refuses `..`, a backslash, a NUL byte, and a link that leads out of the root (CodeQL js/path-injection) (#9).
- The WorkBuddy grader probes for a free port on 127.0.0.1 instead of on every interface (CodeQL py/bind-socket-all-network-interfaces) (#9).
- fast-xml-parser 5.x, and uuid 11.1.1 for exceljs through an override (Dependabot alerts #1 and #2) (#9).
- Claude Code verifier sessions run with auto-memory off and no hooks, fail a turn at a usage limit instead of waiting, and inherit none of the parent session's variables, the `CLAUDE_BG_*` credentials included. The login and the provider choice are kept (#11).

### Removed
- The `test:node` script, which ran no tests (#5).
- The unused `DEFAULT_PI_CONTEXT` export (#3).
