# Copyright 2026 The VeriHarness Authors.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Workspace-Bench Lite adapter. Spec = metadata.task + required output files
ONLY (the same metadata.json carries the literal rubrics and never moves; so
does each run's rubrics_judge file). Workspace = the task's data/ folder.
Deliverables = EVERYTHING the rollout left in its output/ — the required
files and all scratch (intermediate scripts, misplaced outputs); scratch is
real evidence of how the rollout worked. The volume is
across all rollouts: affordable, so nothing is substituted with a listing."""

from functools import lru_cache
import json
from pathlib import Path

from harness.materialize.base import Rollout
from harness.materialize.base import SRCROOT
from harness.materialize.base import Task
from harness.materialize.renderers import render_wsb_traj

WSB = SRCROOT / "benchmarks/wsb_lite/official/evaluation"
POOLS = {"flash": "Gemini-3.5-Flash", "opus": "Opus-4-8"}


@lru_cache(maxsize=1)
def _task_meta() -> dict:
  out = {}
  for t in sorted((WSB / "tasks").iterdir()):
    f = t / "metadata.json"
    if f.exists():
      m = json.loads(f.read_text())
      out[t.name] = {
          "task": m.get("task", ""),
          "output_files": [str(x) for x in (m.get("output_files") or [])],
          "n_rubrics": len(m.get("rubrics") or []),
      }
  return out


def _spec(meta: dict) -> str:
  out = [meta["task"]]
  if meta["output_files"]:
    out.append("Required output files: " + ", ".join(meta["output_files"]))
  return "\n\n".join(x for x in out if x)


def _rollout_payload(td: Path):
  out_dir = td / "output"
  files = []
  if out_dir.is_dir():
    files = [
        (p, str(p.relative_to(out_dir)))
        for p in sorted(out_dir.rglob("*"))
        if p.is_file()
    ]
  return files


def iter_tasks(pool: str):
  model = POOLS[pool]
  metas = _task_meta()
  runs = sorted(
      p
      for p in (WSB / "output").glob(f"ClaudeCode--{model}--s*")
      if (p / ".s_done").exists()
  )
  tasks: dict[str, Task] = {}
  for run in runs:
    seed = run.name.split("--")[-1]
    for td in sorted(p for p in run.iterdir() if p.is_dir()):
      meta = metas.get(td.name)
      jf = td / "rubrics_judge--claude-opus-4-8.json"
      if not meta or not meta["n_rubrics"] or not jf.exists():
        continue
      judged = json.loads(jf.read_text())
      rubrics = judged.get("rubrics") or []
      ok = {}
      for x in rubrics:
        try:
          ok[int(x.get("index"))] = bool(x.get("passed"))
        except (TypeError, ValueError):
          continue
      # A judge that failed writes every rubric as not passed, with the error in its
      # evidence: that is no grading of this rollout, not a zero. Score it None, so the
      # pool's mean and oracle ignore it and a verifier that picks it is graded afresh.
      failed = bool((judged.get("judge") or {}).get("error")) or (
          bool(rubrics)
          and all(
              str(x.get("evidence", "")).startswith("ClaudeCode judge failed")
              for x in rubrics
          )
      )
      score = (
          None
          if failed
          else sum(1 for i in range(meta["n_rubrics"]) if ok.get(i))
          / meta["n_rubrics"]
      )
      t = tasks.setdefault(td.name, Task(key=td.name, spec=_spec(meta)))
      data_dir = WSB / "tasks" / td.name / "data"
      if data_dir.is_dir() and not t.trees:
        t.trees.append((data_dir, ""))
      files = _rollout_payload(td)
      af = td / "agent.json"
      t.rollouts[seed] = Rollout(
          seed=seed,
          score=score,
          files=files,
          traj=(lambda f=af: render_wsb_traj(f)) if af.exists() else None,
          traj_files=[(af, "agent.json")] if af.exists() else [],
      )  # the judge reads it
  yield from (tasks[k] for k in sorted(tasks))
