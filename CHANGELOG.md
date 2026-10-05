# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- The harness is TypeScript: Bun runs it in development and Node runs the built `dist/` in production (#1).
- Local model backends: Ollama and llama.cpp, with a `model-check` preflight that refuses a server that is down, a missing model, or a model that cannot call tools (#2).
- `writeFileAtomic` and `renameReplacing` in `harness/fsutil.ts`: one shared temp-file-and-rename write (#8).
- `--provider claude-code` runs the verifier on Claude Haiku and Claude Sonnet through the Claude Code CLI, with the login that Claude Code already holds (`docs/claude-code.md`). These lanes run without the jail: the verifier can read other tasks' results and answer keys, and the driver says so once per task (#11).
- Runner lanes `haiku` and `sonnet`, `--lane-max lane=N`, and `--env` passed to every driver. A usage limit (exit 75) stops the lane, because every session of an account shares it (#11).
- `model-check --provider claude-code` prints the CLI version, the model and the key source (#11).
- CI builds and smoke-runs the built CLI on Linux and Windows, and checks the jail on a real Linux kernel. A control run with capabilities must report every escape and every write, so a "no" in the jail run means the jail held (#9).

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
- Tests: the env-derive timeout test gives its stub 2 s to start instead of 300 ms, and the Windows command-line test makes about 280 folders instead of 1,500, whose delete outlasted the 5 s cleanup hook. Nine test files that start child processes set a 30 s default: their slowest tests measured 3.2-5.3 s on a loaded Windows host, and Bun's 5 s default failed a different one on each run. Bun 1.4.2 reads no test timeout from `bunfig.toml`, and a preloaded `setDefaultTimeout` reaches only the first file (#11).
- Model options: `timeoutMs` must be a whole number of milliseconds; a fractional count of seconds (`--request-timeout`, `VERIHARNESS_MODEL_TIMEOUT`) converts to whole milliseconds, and less than 1 ms is an error (#12).
- Ollama: a generated tool-call id never merges with a server id, in a stream or in a whole reply, so no call is lost (#12).
- `--jobs`, `--cell-cap`, `--lane-max` and `--limit` reject a digit string that is Infinity or an unsafe integer, through one helper, `parseCount` (#12).
- Score: tasks named `__proto__` or `constructor` are graded and saved on the batched path, and the bootstrap interval no longer depends on the order in which tasks finish (#12).
- Materialize: a task named `constructor` or `__proto__` is tracked correctly in `meta.json`; a WorkBuddy string reward must match Python `float()` syntax, so `0x10` is an error (#12).
- The `--skill=NAME` form is accepted like every other `--option=value`; a test and the README say so (#12).
- `secondsToMs` rejects a value below 0.001 s before rounding, so 0.0005 s no longer rounds up to 1 ms (#12).
- The Workspace-Bench (`wsb`) batch grader returns a prototype-free result, so a task named `__proto__` gets its own entry and reaches score (#12).
- A caller-supplied timeout above 2^31-1 ms (about 24.8 days) is clamped, because Node fires such a timer at once: `--request-timeout 2147484` aborted every model request after about 1 ms. `secondsToMs` says "finite" for an infinite product (#12).
- `pptx_text` tests set the 30 s default timeout of the other child-process test files (#12).

### Security
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
