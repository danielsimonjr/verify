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
"""Workspace-Bench Lite: the official agent-as-a-judge run inside the workspace-bench docker
image on a staged task dir {metadata.json, output/}. Score = passed rubrics / n_rubrics, as in
materialize/wsb.py. Our deliverables dir mirrors the agent's output folder. `_misplaced_outputs/`
IS part of that surface: it sits inside the benchmark's own output/ tree, so the archived judge
saw it and we must too."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from harness import config
from harness.config import bench_root
from harness.views import is_view

WSB = bench_root() / "benchmarks" / "wsb_lite" / "official" / "evaluation"
TASKS = WSB / "tasks"
MODEL = "claude-opus-4-8"  # the judge model configured in the benchmark's runs/judge.yaml
GRADER = "wsb/agent_as_a_judge"


def preflight() -> str:
  """See jb.preflight: the judge fails soft. When its litellm proxy is down every call burns the
  six-retry budget (about forty minutes a task) and then writes every rubric failed, so the cell
  scores 0.000 without any error being raised."""
  import urllib.request

  env = {}
  for line in (WSB / ".env").read_text().splitlines():
    if "=" in line and not line.lstrip().startswith("#"):
      k, _, v = line.partition("=")
      env[k.strip()] = v.strip()
  url = env.get("JUDGE_BASE_URL", "")
  body = json.dumps(
      {
          "model": MODEL,
          "max_tokens": 1,
          "messages": [{"role": "user", "content": "ok"}],
      }
  ).encode()
  req = urllib.request.Request(
      url.rstrip("/") + "/v1/chat/completions",
      data=body,
      headers={
          "Content-Type": "application/json",
          "Authorization": "Bearer " + env.get("JUDGE_API_KEY", ""),
      },
  )
  try:
    with urllib.request.urlopen(req, timeout=60) as r:
      json.loads(r.read())
    return ""
  except Exception as e:  # noqa: BLE001
    return f"wsb judge {MODEL} unreachable at {url}: {type(e).__name__}: {str(e)[:200]}"


def _stage(
    td: Path,
    key: str,
    deliverables: Path,
    meta: dict,
    trace: Path | None = None,
) -> None:
  (td / "output").mkdir(parents=True)
  # The judge reads agent.json for a filtered execution trace; archived rollouts were judged
  # with theirs. A rollout's bundle has it beside its trajectory; a delivered bundle (out/) is
  # judged with the base rollout's, which the scorer passes via `trace`.
  trace = trace or deliverables.parent / "trajectory" / "agent.json"
  if trace.is_file():
    shutil.copy2(trace, td / "agent.json")
  meta = {
      **meta,
      "__metadata_path": f"/workspace/Workspace-Bench/evaluation/tasks/{key}/metadata.json",
  }
  (td / "metadata.json").write_text(
      json.dumps(meta, ensure_ascii=False, indent=1)
  )
  for p in deliverables.iterdir():
    if is_view(
        p.name
    ):  # our own pre-rendered view, never part of the deliverable
      continue
    (shutil.copytree if p.is_dir() else shutil.copy2)(p, td / "output" / p.name)


def _parse(td: Path, meta: dict, tail: str) -> dict:
  rj = td / f"rubrics_judge--{MODEL}.json"
  if not rj.exists():
    return {
        "score": None,
        "error": tail or "judge produced no rubric file",
        "grader": GRADER,
    }
  res = json.loads(rj.read_text())
  items = res.get("rubrics") or res.get("results") or res
  if isinstance(items, dict):
    items = items.get("rubrics") or []
  n = len(meta.get("rubrics") or [])
  # A judge that failed after its retries writes every rubric as failed, with the error in its
  # evidence and under judge.error: that is no grading of the bundle, not a zero.
  judge_err = (
      (res.get("judge") or {}).get("error") if isinstance(res, dict) else None
  )
  failed_items = [
      x
      for x in items
      if isinstance(x, dict)
      and str(x.get("evidence", "")).startswith("ClaudeCode judge failed")
  ]
  if judge_err or failed_items or not n:
    return {
        "score": None,
        "error": f"judge failed: {judge_err or (failed_items[0].get('evidence') if failed_items else 'no rubrics')}"[
            :400
        ],
        "rubrics": items,
        "grader": GRADER,
    }
  passed = sum(1 for x in items if isinstance(x, dict) and x.get("passed"))
  return {
      "score": passed / n,
      "detail": {"passed": passed, "n_rubrics": n},
      "rubrics": items,
      "grader": GRADER,
  }


def grade(
    key: str,
    deliverables: Path,
    timeout: int = 2400,
    trace: Path | None = None,
    **_,
) -> dict:
  meta_src = TASKS / key / "metadata.json"
  if not meta_src.exists():
    return {
        "score": None,
        "error": f"no tasks/{key}/metadata.json",
        "grader": GRADER,
    }
  meta = json.loads(meta_src.read_text())
  stage_root = Path(tempfile.mkdtemp(prefix="vh_wsb_", dir=str(config.TMP_DIR)))
  try:
    os.chmod(stage_root, 0o777)
    _stage(stage_root / key, key, deliverables, meta, trace)
    subprocess.run(["chmod", "-R", "a+rwX", str(stage_root)], check=False)
    # As the host user, so the judge's outputs in the staging dir stay ours to read and remove.
    cmd = [
        "docker",
        "compose",
        "-f",
        "docker/docker-compose.yaml",
        "run",
        "--rm",
        "--user",
        f"{os.getuid()}:{os.getgid()}",
        "-e",
        "HOME=/tmp/home",
        "-v",
        f"{stage_root}:/workspace/vh_stage",
        "workspace-bench",
        "python3",
        "-u",
        "/workspace/Workspace-Bench/evaluation/src/agent_as_a_judge.py",
        "--task-dir",
        "/workspace/vh_stage",
        "--eval-yaml",
        "/workspace/Workspace-Bench/evaluation/runs/judge.yaml",
        "--overwrite",
        "--workers",
        "1",
    ]
    try:
      p = subprocess.run(
          cmd, capture_output=True, text=True, timeout=timeout, cwd=str(WSB)
      )
      tail = (p.stderr or p.stdout)[-800:]
    except subprocess.TimeoutExpired:
      tail = "judge container timed out"
    return _parse(stage_root / key, meta, tail)
  finally:
    shutil.rmtree(stage_root, ignore_errors=True)


def grade_batch(items, workers: int = 8, timeout: int = 7200) -> dict:
  """Judge several bundles in ONE container: `items` are (key, deliverables, trace-or-None); keys must be
  distinct within a batch (a task's base and its delivery go in different batches). The official judge
  takes a runs root and a --workers count, so a batch of N bundles costs one container instead of N —
  which is what keeps the host's network stack calm when many cells are graded at once.
  """
  out, metas = {}, {}
  stage_root = Path(
      tempfile.mkdtemp(prefix="vh_wsbb_", dir=str(config.TMP_DIR))
  )
  try:
    os.chmod(stage_root, 0o777)
    for key, deliverables, trace in items:
      meta_src = TASKS / key / "metadata.json"
      if not meta_src.exists():
        out[key] = {
            "score": None,
            "error": f"no tasks/{key}/metadata.json",
            "grader": GRADER,
        }
        continue
      metas[key] = json.loads(meta_src.read_text())
      _stage(stage_root / key, key, Path(deliverables), metas[key], trace)
    if not metas:
      return out
    subprocess.run(["chmod", "-R", "a+rwX", str(stage_root)], check=False)
    cmd = [
        "docker",
        "compose",
        "-f",
        "docker/docker-compose.yaml",
        "run",
        "--rm",
        "--user",
        f"{os.getuid()}:{os.getgid()}",
        "-e",
        "HOME=/tmp/home",
        "-v",
        f"{stage_root}:/workspace/vh_stage",
        "workspace-bench",
        "python3",
        "-u",
        "/workspace/Workspace-Bench/evaluation/src/agent_as_a_judge.py",
        "--task-dir",
        "/workspace/vh_stage",
        "--eval-yaml",
        "/workspace/Workspace-Bench/evaluation/runs/judge.yaml",
        "--overwrite",
        "--workers",
        str(min(workers, len(metas))),
    ]
    try:
      p = subprocess.run(
          cmd, capture_output=True, text=True, timeout=timeout, cwd=str(WSB)
      )
      tail = (p.stderr or p.stdout)[-400:]
    except subprocess.TimeoutExpired:
      tail = "judge container timed out"
    for key, meta in metas.items():
      out[key] = _parse(stage_root / key, meta, tail)
    return out
  finally:
    shutil.rmtree(stage_root, ignore_errors=True)
