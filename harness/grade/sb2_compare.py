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

"""Cell-level SB2 grading via upstream evaluation.py (invoked from harness/grade/sb2.ts)."""

import json
import os
import sys
from pathlib import Path

# VERIHARNESS_BENCH_ROOT must be set; SB2 root is resolved like harness.grade.sb2.
_bench_root = os.environ.get("VERIHARNESS_BENCH_ROOT", "")
if not _bench_root:
  sys.stderr.write("VERIHARNESS_BENCH_ROOT is not set\n")
  sys.exit(2)
SB2 = Path(_bench_root).resolve() / "benchmarks" / "sb2" / "official"
DATA = SB2 / "data"


def _grade_det(data: dict, cat: str, outputs_dir: Path) -> dict:
  """The official per-item scoring (evaluation.process_single_item), with every cell mismatch kept."""
  ev_dir = str(SB2 / "evaluation")
  if ev_dir not in sys.path:
    sys.path.insert(0, ev_dir)
  import evaluation as ev  # noqa: E402

  dataset_path = DATA / cat
  input_file = str(dataset_path / data["spreadsheet_path"])
  gt_file = str(dataset_path / data["golden_response_path"])
  proc_file = str(outputs_dir / f"{data['id']}_output.xlsx")

  with_font_color = cat == "Debugging" and "Color" in data.get(
      "spreadsheet_path", ""
  )
  with_formula = cat == "Debugging" and "Embedded" in data.get(
      "spreadsheet_path", ""
  )

  detail = {"id": data["id"], "category": cat}
  if not os.path.exists(proc_file):
    detail.update(
        {
            "accuracy": 0.0,
            "regression_accuracy": 0.0,
            "modification_accuracy": 0.0,
            "error_message": "output file not exist",
            "cell_errors": [],
            "missing": True,
        }
    )
    return detail

  need_raw = with_formula
  try:
    wb_proc = ev.openpyxl.load_workbook(proc_file, data_only=not need_raw)
    wb_proc_f = (
        None
        if with_formula
        else ev.openpyxl.load_workbook(proc_file, data_only=False)
    )
  except Exception as e:  # noqa: BLE001
    detail.update(
        {
            "accuracy": 0.0,
            "regression_accuracy": 0.0,
            "modification_accuracy": 0.0,
            "error_message": str(e)[:500],
            "cell_errors": [],
        }
    )
    return detail
  try:
    wb_input = ev.openpyxl.load_workbook(input_file, data_only=not need_raw)
    wb_gt = ev.openpyxl.load_workbook(gt_file, data_only=not need_raw)
    if not with_formula:
      wb_input_f = ev.openpyxl.load_workbook(input_file, data_only=False)
      wb_gt_f = ev.openpyxl.load_workbook(gt_file, data_only=False)
    else:
      wb_input_f = wb_gt_f = None

    reg = {"correct": 0, "total": 0}
    mod = {"correct": 0, "total": 0}
    msgs = []
    for scr in ev.parse_answer_position(data["answer_position"]):
      if "!" in scr:
        sheet_name, cell_range = scr.split("!")
      else:
        sheet_name, cell_range = wb_gt.sheetnames[0], scr
      sheet_name = sheet_name.strip("'").strip()
      cell_range = cell_range.strip("'").strip()
      rc, mc = ev.classify_cells_by_modification(
          wb_input,
          wb_gt,
          sheet_name,
          cell_range,
          with_font_color,
          with_formula,
          wb_input_formula=wb_input_f,
          wb_answer_formula=wb_gt_f,
      )
      r_c, r_t, m_c, m_t, m_msgs = ev.cell_level_compare_with_classification(
          wb_gt,
          wb_proc,
          sheet_name,
          rc,
          mc,
          with_font_color,
          with_formula,
          wb_answer_formula=wb_gt_f,
          wb_output_formula=wb_proc_f,
      )
      reg["correct"] += r_c
      reg["total"] += r_t
      mod["correct"] += m_c
      mod["total"] += m_t
      msgs.extend([m for m in m_msgs if m])
  except Exception as e:  # noqa: BLE001
    detail.update(
        {
            "accuracy": None,
            "error_message": f"grader crashed: {type(e).__name__}: {str(e)[:400]}",
            "cell_errors": [],
        }
    )
    return detail

  reg_ratio = round(reg["correct"] / reg["total"], 4) if reg["total"] else 0.0
  mod_ratio = round(mod["correct"] / mod["total"], 4) if mod["total"] else 0.0
  if reg_ratio >= 0.998:
    reg_ratio = 1.0
  acc = 1.0 if reg_ratio == 1.0 and mod_ratio == 1.0 else 0.0
  detail.update(
      {
          "accuracy": acc,
          "regression_accuracy": reg_ratio,
          "modification_accuracy": mod_ratio,
          "regression_cells": reg,
          "modification_cells": mod,
          "error_message": msgs[0] if msgs and not acc else "",
          "cell_errors": msgs[:500],
      }
  )
  return detail


def _result(det: dict) -> dict:
  msg = str(det.get("error_message") or "")
  grader = "sb2/evaluation.py+recalc"
  if msg.startswith("grader crashed"):
    return {"score": None, "error": msg[:300], "detail": det, "grader": grader}
  return {
      "score": float(det.get("accuracy") or 0.0),
      "detail": det,
      "grader": grader,
  }


def main() -> int:
  if len(sys.argv) > 1:
    payload = json.loads(Path(sys.argv[1]).read_text())
  else:
    payload = json.loads(sys.stdin.read())
  data = payload["data"]
  cat = payload["cat"]
  outputs_dir = Path(payload["outputs_dir"])
  det = _grade_det(data, cat, outputs_dir)
  print(json.dumps(_result(det)))
  return 0


if __name__ == "__main__":
  sys.exit(main())
