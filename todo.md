# todo

Open work for this repository. Check an item off when it lands, in the same commit.

## Harness

- [ ] Claude Code verifier runtime: Claude Haiku and Claude Sonnet run the verifier through `claude -p` on native Windows with `--env none`.
- [ ] Single-result verification: a task with one rollout gets a pass/fail verdict with evidence. Today the method compares two or more rollouts, and the materializers skip a task with fewer than two.
- [ ] Bring-your-own task: a documented way to build a task workspace (`spec/task.md`, `workspace/`, `rollouts/rNN/`) from local files, without a benchmark adapter.

## Quality gates

- [ ] Doc comments: `repo-tools docs check harness` reports 163 exported symbols without a doc comment (`harness/fsutil.ts` and `harness/grade/sb2.ts` are clean).
- [ ] Architecture docs: there is no `docs/architecture/`. Generate it with `repo-tools map . --out=docs/architecture` and gate it with `repo-tools check . --docs=docs/architecture`.
- [x] The skill scripts call `mkdirSync(outDir, { recursive: true })` on a path from the command line; `--out .` fails under Bun on Windows (oven-sh/bun#44576). Done in #9: one helper, `harness/skills/_shared/dirs.ts`, and a test that no other skill script makes a directory recursively.
- [x] Strict tsc (`--noUnusedLocals --noUnusedParameters --noImplicitReturns`) reports 6 findings: unused `readText` (`grade/jb.ts`), `existsSync` (`runner.ts`), `cell` (`skills/_shared/excel.ts`), `Key` (`xlsx_forks.ts`), `vals` (`xlsx_gaps.ts`), and a `walk` callback in `docx_changes.ts` that returns `false` on one branch only. That callback is correct, because `walk` reads `false` as "skip the children". Fix all six, then add the flags to `tsconfig.json` so the gate holds. Done in #9: the flags are in `tsconfig.json`, and `tsconfig.test.json` applies them to `tests/`.

## Benchmark reproduction (out of scope while the repo is used as a harness)

- [ ] `litellm_up.sh`: a pidfile overwritten while another instance starts, a stale pidfile that names a reused pid, no liveness check during the 60 s wait, `curl` without `--max-time`.
- [ ] `setup_benchmarks.sh`: `{}` substituted into a `bash -c` string (shell injection from upstream directory names); a failed image build exits 0.
- [ ] `requirements.txt` misses `openpyxl` and `tqdm`, which `grade/sb2_compare.py` needs on the host; its header comment is stale.
- [ ] `grade/wb.py` keeps an unreachable host half that imports the deleted Python harness package, and interpolates artifact names into `bash -c` (an apostrophe breaks it; a crafted name injects; `..` escapes `/workspace`).
- [ ] The Dockerfiles use a floating `python:3.12-slim` and unpinned apt and pip packages; `Dockerfile.office` does not check for `soffice`.
- [ ] `harness/benchmarks/wsb/env.example` names `harness/grade/wsb.py`, which is `.ts` now.

## Five-axis assessments

- 2026-10-04 — `harness/fsutil.ts`, `harness/grade/proc.ts`, grade tests. Speed: no change. Stability: the grade tests had no bound of their own, so Bun's 5 s default applied while three cases measure 3.8-4.5 s; the file now sets 30 s. Reliability: atomic writes retry a Windows sharing violation; a timed-out grader run waits for its container stop. Security: no change. Maintainability: three copies of the atomic write became one. Left: the doc-comment and architecture-doc gates above.
- 2026-10-04 — review of the above. Stability: the test that a timed-out run waits for `onTimeout` passed against the old code on Windows, because taskkill outlasted its fixed delay; it now waits for the child to die. Reliability: an SB2 recalc timeout waits for a slow `docker kill`; `ensureDir` accepts a drive root; a failed atomic write removes its partial temp file and reports its own error. Security, speed: no change. Maintainability: `fsutil.ts` and `sb2.ts` exports all carry doc comments; the SB2 kill wait is computed from the kill's own bounds (40 s), not from a default in another module. Strict tsc found 6 issues that main already had; they are recorded above. Left: on Linux CI the drive-root test cannot fail, because `mkdir -p /` never threw there.
- 2026-10-05 — #9 review threads: `harness/skills/_shared/static_server.ts`, `tests/jail/`. Security: the static server refuses a backslash on every platform. Measured on ubuntu-latest: Bun 1.4.2 `realpathSync` reads `\` as a separator, while Node 22 throws ENOENT, so one URL named different files per runtime. Reliability: the jail check now tests the read-only `workspace/` bind, and its control run must answer yes to every write probe. Stability: the control run no longer writes `probe.txt` into the checkout. Speed, maintainability: no change. Left: the Bun `realpathSync` divergence is upstream (oven-sh/bun#33403, still open; 1.4.2 data added).
