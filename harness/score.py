#!/usr/bin/env python3
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
"""Score one cell of a run against its archived rollout pool.

    python3 -m harness.score <runs>/<run>/<bench>_<pool> [--workers N] [--select-only] [--redo]

Two results per task, both on the benchmark's own scale:

  select   the archived score of the base that adjudication chose. No new grading.
  final    select + (revised - base_regraded): the delivered bundle and the unrevised base
           are graded in the same pass, so grader drift and judge noise cancel in the
           difference, which is then applied to the archived score.

A delivery that failed the driver's bundle contract falls back to the base (final =
select), and so does one whose bytes equal the base's (the driver records the changed
files by hash): grading identical content twice can only add judge noise to the
difference. Tasks the harness did not finish are listed, not dropped silently.

Grading runs in processes, not threads: several graders compare workbooks in-process
and a thread pool is serialised by the GIL. Every graded task is appended to
scores.partial.jsonl as it completes, and a rerun resumes from it.
"""

import argparse
from concurrent.futures import as_completed
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import random
import sys

from harness import config
from harness.driver import base_of
from harness.driver import read_json
from harness.grade import grade_deliverables
from harness.grade import preflight


def bootstrap_ci(xs, iters=10000, alpha=0.05, seed=0):
  rng = random.Random(seed)
  n = len(xs)
  means = sorted(sum(rng.choices(xs, k=n)) / n for _ in range(iters))
  return means[int(alpha / 2 * iters)], means[int((1 - alpha / 2) * iters) - 1]


def _safe_grade(bench: str, key: str, deliverables: Path, **kw) -> dict:
  try:
    return grade_deliverables(bench, key, deliverables, **kw)
  except Exception as e:  # noqa: BLE001  a grader that dies must not kill the cell
    return {"score": None, "error": f"{type(e).__name__}: {str(e)[:200]}"}


def _grade_task(job):
  """Module level so a process pool can pickle it."""
  bench, ws_str, base, delivery_valid = job
  ws = Path(ws_str)
  base_dir = ws / "rollouts" / base / "deliverables"
  # Base "none": nothing to regrade; the delivered bundle is the whole result.
  g_base = (
      _safe_grade(bench, ws.name, base_dir)
      if base_dir.is_dir()
      else {"score": None, "error": "no base"}
  )
  # A delivered bundle is judged under the base rollout's execution trace, where a grader uses one.
  g_out = (
      _safe_grade(
          bench,
          ws.name,
          ws / "out" / "deliverables",
          trace=base_dir.parent / "trajectory" / "agent.json",
      )
      if delivery_valid
      else {"score": None, "error": "delivery failed the bundle contract"}
  )
  return ws.name, g_base, g_out


def _run_batch(grade_batch, batch: int, b):
  side, items = b
  try:
    return side, grade_batch(items, workers=batch)
  except Exception as e:  # noqa: BLE001
    return side, {
        k: {"score": None, "error": f"{type(e).__name__}: {str(e)[:200]}"}
        for k, _, _ in items
    }


def _grade_batched(bench: str, jobs: list, batch: int, containers: int):
  """Batched grading for benches whose grader offers `grade_batch` (wsb, sb2): many bundles per
  long-lived container, `containers` containers at a time. A task's base and its delivery go to
  different batches, so keys never repeat inside one. Yields (key, g_base, g_out) as batches land.
  """
  from harness.grade import _module

  grade_batch = _module(bench).grade_batch
  pending = {}  # key -> [g_base, g_out]
  base_items, out_items = [], []
  for _, ws_str, base, delivery_valid in jobs:
    ws = Path(ws_str)
    base_dir = ws / "rollouts" / base / "deliverables"
    trace = base_dir.parent / "trajectory" / "agent.json"
    pending[ws.name] = [
        None if base_dir.is_dir() else {"score": None, "error": "no base"},
        None
        if delivery_valid
        else {"score": None, "error": "delivery failed the bundle contract"},
    ]
    if pending[ws.name][0] is None:
      base_items.append((ws.name, base_dir, None))
    if pending[ws.name][1] is None:
      out_items.append((ws.name, ws / "out" / "deliverables", trace))
  batches = [
      (0, base_items[i : i + batch]) for i in range(0, len(base_items), batch)
  ] + [(1, out_items[i : i + batch]) for i in range(0, len(out_items), batch)]
  print(
      f"{bench}: {len(base_items)} base + {len(out_items)} delivered gradings in {len(batches)} containers "
      f"of <= {batch}, {containers} at a time",
      flush=True,
  )

  def ready():
    for key, pair in list(pending.items()):
      if pair[0] is not None and pair[1] is not None:
        del pending[key]
        yield key, pair[0], pair[1]

  yield from ready()
  # Threads, not processes: a batch is one docker subprocess, so the GIL is not in the way.
  with ThreadPoolExecutor(max_workers=containers) as ex:
    for fut in as_completed(
        [ex.submit(_run_batch, grade_batch, batch, b) for b in batches]
    ):
      side, res = fut.result()
      for key, r in res.items():
        if key in pending:
          pending[key][side] = r
      yield from ready()


def _unchanged(base: str, delivery: dict) -> bool:
  """The delivered bundle is byte-for-byte the base (per the driver's hash record). Records
  without one are graded as if changed."""
  return base != "none" and delivery.get("changed") == []


def _row(
    base: str,
    pool_scores: dict,
    delivery: dict,
    g_base: dict | None,
    g_out: dict | None,
) -> dict:
  select = pool_scores.get(base)
  changed = delivery.get("changed")
  row = {
      "base": base,
      "select": select,
      "pool_mean": sum(pool_scores.values()) / len(pool_scores),
      "oracle": max(pool_scores.values()),
      "zero_spread": len({round(v, 9) for v in pool_scores.values()}) == 1,
      "delivery_valid": bool(delivery.get("valid")),
      # Whether bytes changed; the model's own `applied` flag also says true for "copied the base".
      "revised": bool(changed)
      if changed is not None
      else bool(delivery.get("applied")),
  }
  if g_base is None:  # --select-only
    return {**row, "final": select}
  if (
      _unchanged(base, delivery) and select is not None
  ):  # identical bytes: the base stands
    return {
        **row,
        "base_regraded": None,
        "out_graded": None,
        "final": select,
        "error": None,
    }
  base_regraded, out_graded = g_base.get("score"), g_out.get("score")
  if select is None and base != "none" and base_regraded is not None:
    # The pool holds no score for this base; its fresh grading is the selection score.
    row["select"] = select = base_regraded
  if out_graded is None:  # invalid or ungradable delivery: the base stands
    final = select
  elif select is None:  # base none: the delivery scores on its own
    final = out_graded
  elif (
      base_regraded is None
  ):  # base could not be regraded: no paired difference available
    final = out_graded
  else:  # clamped to [0, 1], the scale of all five graders; a paired difference can overshoot it
    final = min(1.0, max(0.0, select + (out_graded - base_regraded)))
  return {
      **row,
      "base_regraded": base_regraded,
      "out_graded": out_graded,
      "final": final,
      "error": g_out.get("error") or g_base.get("error"),
  }


def _mean(xs):
  return sum(xs) / len(xs) if xs else float("nan")


def summarize(cell: Path, rows: dict, unfinished: list) -> dict:
  scored = [r for r in rows.values() if r["final"] is not None]
  out = {
      "cell": cell.name,
      "n_scored": len(scored),
      "n_unfinished": len(unfinished),
  }
  if not scored:
    return out
  fallback = lambda r: r["select"] if r["select"] is not None else r["pool_mean"]  # noqa: E731  base none
  out.update(
      single_rollout=_mean([r["pool_mean"] for r in scored]),
      select=_mean([fallback(r) for r in scored]),
      final=_mean([r["final"] for r in scored]),
      oracle=_mean([r["oracle"] for r in scored]),
      n_revised=sum(r["revised"] for r in scored),
      n_invalid_delivery=sum(not r["delivery_valid"] for r in scored),
  )
  for name, deltas in (
      ("select", [fallback(r) - r["pool_mean"] for r in scored]),
      ("final", [r["final"] - r["pool_mean"] for r in scored]),
  ):
    out[f"{name}_gain"] = _mean(deltas)
    out[f"{name}_gain_ci95"] = (
        list(bootstrap_ci(deltas)) if len(deltas) > 1 else [deltas[0]] * 2
    )
  return out


def grader_health(rows: dict) -> str:
  """A dead judge does not raise: it returns every rubric failed, i.e. 0.0, and the cell
  merely looks disappointing. Regrading a base's archived deliverables must reproduce its
  archived score; when it does not, the grader is broken, not the harness."""
  both = [
      r
      for r in rows.values()
      if r.get("base_regraded") is not None and r["select"] is not None
  ]
  if not both:
    return ""
  archived, regraded = _mean([r["select"] for r in both]), _mean(
      [r["base_regraded"] for r in both]
  )
  zeros = sum(1 for r in both if r["base_regraded"] == 0.0 and r["select"] > 0)
  if abs(archived - regraded) > 0.05 or zeros > 0.3 * len(both):
    return (
        f"!! GRADER HEALTH: archived {archived:.3f} vs regraded {regraded:.3f} over {len(both)} bases, "
        f"{zeros} of them regraded 0.0 against a non-zero archived score. Check the grader before "
        f"believing this cell."
    )
  return ""


def main(argv=None) -> int:
  ap = argparse.ArgumentParser(
      description="Score one <bench>_<pool> cell of a run"
  )
  ap.add_argument("cell")
  ap.add_argument(
      "--workers",
      type=int,
      default=6,
      help="graders (or, with --batch, containers) at a time",
  )
  ap.add_argument(
      "--batch",
      type=int,
      default=1,
      help="bundles graded per container where the grader supports it (wsb, sb2): with N > 1 a batch "
      "of N bundles costs one long-lived container instead of N short-lived ones",
  )
  ap.add_argument(
      "--select-only",
      action="store_true",
      help="archived scores only; grade nothing",
  )
  ap.add_argument(
      "--redo",
      action="store_true",
      help="ignore scores.partial.jsonl and grade everything again",
  )
  ap.add_argument(
      "--json", action="store_true", help="print the summary as JSON"
  )
  args = ap.parse_args(argv)

  cell = Path(args.cell).resolve()
  bench, pool = cell.name.rsplit("_", 1)
  meta = json.loads((config.DATA / bench / pool / "meta.json").read_text())
  if not args.select_only:
    problem = preflight(bench)
    if problem:
      print(
          f"!! {bench} grader preflight failed; refusing to run rather than score zeros:\n   {problem}",
          file=sys.stderr,
      )
      return 2

  tasks, unfinished = {}, []  # key -> (ws, base, pool_scores, delivery)
  for ws in sorted(p for p in cell.iterdir() if p.is_dir() and p.name in meta):
    pool_scores = {
        r: v["score"]
        for r, v in meta[ws.name]["rollouts"].items()
        if v["score"] is not None
    }
    finish = read_json(ws / "finish.json")
    if not pool_scores:
      unfinished.append(f"{ws.name} (no archived scores in the pool)")
      continue
    # A base whose archived score is missing (its own grading failed upstream) is still a
    # delivered bundle: keep the task and let the fresh grading of the base stand in for the
    # selection score. Only a task without a record at all is unfinished.
    if finish is None or (
        base_of(finish) != "none"
        and not (ws / "rollouts" / base_of(finish)).is_dir()
    ):
      unfinished.append(ws.name)
      continue
    tasks[ws.name] = (
        ws,
        base_of(finish),
        pool_scores,
        finish.get("repair") or {},
    )

  rows = {}
  if args.select_only:
    rows = {
        k: _row(base, sc, delivery, None, None)
        for k, (_, base, sc, delivery) in tasks.items()
    }
  else:
    # Bundles delivered unchanged need no grading, whatever an earlier pass recorded for them.
    for k, (ws, base, pool_scores, delivery) in tasks.items():
      # Only when the pool holds a score for this base; without one the delivery has to be
      # graded on its own, unchanged or not.
      if _unchanged(base, delivery) and pool_scores.get(base) is not None:
        rows[k] = _row(base, pool_scores, delivery, {}, {})
    n_unchanged = len(rows)
    partial = cell / "scores.partial.jsonl"
    if partial.exists() and not args.redo:
      for line in partial.read_text().splitlines():
        try:
          rec = json.loads(line)
        except (
            json.JSONDecodeError
        ):  # a line half-written when the last run died
          continue
        if rec["key"] in tasks and rec["key"] not in rows:
          # Re-derive the row from the stored gradings, so the scoring rules apply
          # uniformly to resumed and fresh rows alike.
          _, base, pool_scores, delivery = tasks[rec["key"]]
          old = rec["row"]
          rows[rec["key"]] = _row(
              base,
              pool_scores,
              delivery,
              {"score": old.get("base_regraded"), "error": None},
              {"score": old.get("out_graded"), "error": old.get("error")},
          )
      print(
          f"resuming: {len(rows) - n_unchanged} tasks already graded",
          flush=True,
      )
    elif partial.exists():
      partial.unlink()
    jobs = [
        (bench, str(ws), base, bool(delivery.get("valid")))
        for k, (ws, base, _, delivery) in tasks.items()
        if k not in rows
    ]
    print(
        f"{len(jobs)} tasks to grade; {n_unchanged} delivered unchanged (the base stands)",
        flush=True,
    )
    from harness.grade import _module

    def results():
      if args.batch > 1 and hasattr(_module(bench), "grade_batch"):
        yield from _grade_batched(bench, jobs, args.batch, args.workers)
        return
      with ProcessPoolExecutor(max_workers=args.workers) as ex:
        for fut in as_completed([ex.submit(_grade_task, j) for j in jobs]):
          try:
            yield fut.result()
          except Exception as e:  # noqa: BLE001
            print(
                f"!! grading failed: {type(e).__name__}: {str(e)[:200]}",
                flush=True,
            )

    for key, g_base, g_out in results():
      _, base, pool_scores, delivery = tasks[key]
      rows[key] = row = _row(base, pool_scores, delivery, g_base, g_out)
      with partial.open("a") as fh:
        fh.write(json.dumps({"key": key, "row": row}, default=str) + "\n")
      print(
          f"{key[:44]:44s} select {row['select']} regraded {row['base_regraded']} "
          f"out {row['out_graded']} final {row['final']}",
          flush=True,
      )

  summary = summarize(cell, rows, unfinished)
  (cell / "scores.json").write_text(
      json.dumps(
          {"summary": summary, "tasks": rows, "unfinished": unfinished},
          indent=1,
          default=str,
      )
  )
  if args.json:
    print(json.dumps(summary))
    return 0
  health = grader_health(rows)
  if health:
    print("\n" + health, flush=True)
  print(
      f"\n{cell.name}: {summary['n_scored']} scored, {summary['n_unfinished']} unfinished"
  )
  if summary["n_scored"]:
    print(
        f"  single rollout {summary['single_rollout']:.4f} | select {summary['select']:.4f} | "
        f"final {summary['final']:.4f} | oracle {summary['oracle']:.4f}"
    )
    for name in ("select", "final"):
      lo, hi = summary[f"{name}_gain_ci95"]
      print(
          f"  {name:6s} gain {summary[f'{name}_gain']:+.4f}  CI95 [{lo:+.4f}, {hi:+.4f}]"
      )
    print(
        f"  revised {summary['n_revised']} | invalid deliveries {summary['n_invalid_delivery']}"
    )
  return 0


if __name__ == "__main__":
  sys.exit(main())
