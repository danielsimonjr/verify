# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- The harness is TypeScript: Bun runs it in development and Node runs the built `dist/` in production (#1).
- Local model backends: Ollama and llama.cpp, with a `model-check` preflight that refuses a server that is down, a missing model, or a model that cannot call tools (#2).
- `writeFileAtomic` and `renameReplacing` in `harness/fsutil.ts`: one shared temp-file-and-rename write (#8).
- CI builds and smoke-runs the built CLI on Linux and Windows, and checks the jail on a real Linux kernel. A control run with capabilities must report every escape and every write, so a "no" in the jail run means the jail held (#9).

### Fixed
- Runner: an unknown `--lane` is rejected instead of stalling the scheduler; view renders are awaited before the driver starts; tasks run concurrently up to the lane and cell caps; `--sample` and `--fraction` choose the tasks that Python's `random.Random(seed).sample` chose; numeric options reject typos (#4).
- env-derive: images build concurrently up to `--jobs`, and a timed-out build is reported (#4).
- The built CLI resolves its prompts, skills, scripts and data from the repository root, and starts with a Node shebang (#5).
- WorkBuddy, JobBench and SB2 task keys split at the first `__` only (#5, #8).
- The `jb` and `wsb` judge preflights fail on a non-2xx response (#5).
- Model options: zero, negative and fractional `--max-tokens`, `--request-timeout`, `maxTokens`, `timeoutMs` and `retries` are input errors; the Ollama context-window messages state what a user must run (#3).
- Skill scripts: PDF word coordinates start at the top-left of the displayed page; `pdf_tables` detects tables with pdfplumber; the PPTX, XLSX and PDF renderers fall back to PyMuPDF when Poppler is absent (#6).
- Materialized views keep PPTX speaker notes, grouped text and shape order, and read DOCX text, headings and merged cells as python-docx does (#6).
- Driver: a timed-out turn kills its whole process tree; a turn whose agent never started is reported; timeouts and options are validated; a base name from `finish.json` must be a real rollout (#7).
- Score: graded tasks are appended to `scores.partial.jsonl` as they finish, so a rerun resumes (#7).
- Materialize: meta is written before the done-marker; task keys are checked before any delete; the leak blocklist holds on Windows paths; the renderers and the five adapters match the Python they were ported from (#8).
- Grade: graders run asynchronously, stop the processes and containers that they start on a timeout, and report why they failed; `grade` refuses unknown options (#8).
- Windows: an atomic write retries while an antivirus scan or the search indexer holds the target open; a relative output path in the current directory works under Bun (#8).
- Grade: a timed-out SB2 recalc waits for its `docker kill` (up to 40 s) before it returns. It waited 10 s, and the grade CLI then exited and ended a slower kill, which left the container running (#10).
- `ensureDir` accepts a directory that exists, such as a Windows drive root, where a recursive mkdir throws EPERM in Node and Bun (#10).
- An atomic write that fails removes a partly written temp file, and reports the write or rename error even when that cleanup fails (#10).
- Skill scripts: `pageprobe` and `xlsx_recalc` run on Windows; output directories go through one helper, so `--out .` works under Bun on Windows; a patchlab candidate splits at the first `=` only (#9).
- `bun run typecheck` checks `tests/` too, with the strict unused-code and implicit-return flags, and the dead code that they reported is removed (#9).

### Security
- Staging deliverables for grading refuses symlinks instead of copying the files that they point at (#5).
- Grader and judge credentials no longer reach the verifier session (#7).
- Jail: the verifier command runs with no capabilities and `no_new_privs`, so it cannot unmount the covers or remount evidence read-write; `setpriv` is required (#7).
- pageprobe's static server serves only files under its root. It decodes the path once and refuses `..`, a backslash, a NUL byte, and a link that leads out of the root (CodeQL js/path-injection) (#9).
- The WorkBuddy grader probes for a free port on 127.0.0.1 instead of on every interface (CodeQL py/bind-socket-all-network-interfaces) (#9).
- fast-xml-parser 5.x, and uuid 11.1.1 for exceljs through an override (Dependabot alerts #1 and #2) (#9).

### Removed
- The `test:node` script, which ran no tests (#5).
- The unused `DEFAULT_PI_CONTEXT` export (#3).
