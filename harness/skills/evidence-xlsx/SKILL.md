---
name: evidence-xlsx
description: Use when a claim you are checking turns on the contents of a spreadsheet (.xlsx/.xlsm/.csv) — what a cell's formula is, what it evaluates to, which cells a rollout changed, or whether a recomputed model reproduces its own baseline. Reads formulas next to cached values, diffs workbooks cell by cell, and says when a recalculation can be trusted.
---

# Spreadsheet evidence

Scripts (run with `python3`; paths are relative to this directory):

- `scripts/xlsx_dump.py FILE [SHEET] [RANGE]` — formulas and cached values side by
  side, preceded by the workbook's calculation settings (iterative calculation
  on/off). Without RANGE each sheet is cut after its first 200 rows; pass a
  RANGE, or `--all`, for the rest. A cached value is what the last Excel/LibreOffice save computed; a
  formula with no cached value was never calculated.
- `scripts/xlsx_diff.py A.xlsx B.xlsx` — every cell whose formula or value differs,
  per sheet, plus a separate section for formatting differences (font colour,
  bold, fill, number format). The first thing to run between an input workbook
  and a rollout's output, and between two rollouts' outputs.
- `scripts/xlsx_gaps.py FILE` — structural incompleteness the workbook itself evidences,
  with the witness for each: a computed row whose formula stops before the period block
  ends, a formula that reads an empty cell in an otherwise populated row, an error value
  and the blanks it reads, a labelled row left blank beside a same-shape row that is filled.
  A gap is where to look, not proof that a cell must be filled: check it against the task
  and the sheet's own layout.
- `scripts/xlsx_forks.py A.xlsx B.xlsx ...` — every cell the candidates store differently,
  grouped into camps with who holds each, flagged by kind (sign, blank, formula shape,
  value). A locator for disagreements; settle each from the input workbook's notes, labels
  and filled sibling rows.
- `scripts/xlsx_render.py FILE` — renders every sheet, charts included, to PNG
  pages under /tmp/xlsx_render/ for the `read` tool. Judge charts and layout from
  the rendered page, not from the chart XML.

What the evidence means (each point is drawn from a measured failure in this project):

- A cell holds up to three numbers: the **cached value** the file's author last saw,
  the **formula** behind it, and whatever a recalculation engine computes now. Graders
  read the first two. Treat cached value + formula as the evidence and any
  recalculation as an instrument reading. A file written by a library (e.g. openpyxl)
  may carry formulas with no cached values at all — that is a fact about the rollout,
  not a reason to recalculate on its behalf.
- This skill ships no recalculation script (repair-xlsx does). If you recalculate (headless
  LibreOffice, or your own evaluation of the formulas), it counts as evidence only after
  it reproduces cells nobody touched. Circular models (`xlsx_dump.py` reports iterative
  calculation on; debt schedules, interest on average balances) are where headless
  engines converge to a different fixed point than Excel, or not at all: iterate the
  model's own formulas in Python from the cached values instead.
- Most spreadsheet disputes are about **conventions**, not arithmetic: sign of a stored line,
  period basis, which line a phrase refers to, whether a labelled blank is filled. Settle the
  convention before you compute, and settle it from the workbook. Authority runs: a note or
  footnote cell in the input (search for one before ruling, and quote it) > labels and headers
  (a leading "−", "(Annual)", a section title) > a same-kind sibling formula filled *in the
  input* > the spec's words > what most rollouts did > your own domain habit. A cell the
  rollouts filled is not a precedent. An argument from what the accounting or the industry
  "must" be — a balance that ought to extinguish, a block that ought to tie, a rate that ought
  to be annual — is the weakest evidence here: when it would eliminate the larger group or
  special-case the last column of a dragged row, the plain pattern is usually what was intended.
  Two readings with the same downstream total are still different deliverables: the stored
  cells are what a reader opens.
- A literal where the template has a formula (`xlsx_diff.py` marks these) is a first-
  class defect in modelling tasks even when the number is right; adjudicate each such
  cell, do not treat it as noise.
- **Which cells the task is about depends on its shape.** When the task hands over a workbook to
  edit or complete, graders diff against the input: prefer formulas over values (identical
  numbers can hide different logic), and treat changes to input cells that the task did not
  ask for — moved headers, "fixed" unrelated cells, reformatting — as risk, not thoroughness.
  When the task is to find and fix errors and names the class — in its wording, the file name
  or a sheet title (a lookup, an average, double counting, a hardcode, anchoring, a sign, a
  unit) — that class is the scope: the intended fix is every instance of it, on every sheet,
  siblings showing the correct form, and nothing outside it. A latent oddity of another kind
  (an odd input value, a second broken reference, a label that looks wrong) is part of the
  intended original, and a candidate that "also fixed" it departed from the task; the
  candidate complete in class and silent out of class is ahead of both the two-cell fix and
  the sixty-cell audit. This holds wherever the base is chosen, not only when a consensus is
  tested. Only when the task's own text lists the fixes it wants is that list the scope instead.
- **What is delivered is the stored value.** Every grader and viewer that opens a workbook on
  values — and most do — sees a formula without a cached value as a blank cell. When the task
  asks for a new workbook or table built from data and supplies none to edit, formula versus
  literal is neither merit nor defect (unless the spec asks for a live model), a
  library-written formula with no cached value is a blank, and the plainest layout carrying
  the asked-for columns — header in the first row, the entity label first, no banner or merged
  group rows above it — is what a reader parses; a banner, a two-tier header or an extra label
  column is a departure to record, not polish to credit. The `.cells.tsv` header line counts
  each workbook's formulas and how many have no cached value.
- Some graders check formatting and rendering: font colour, number format, the rendered
  chart. Compare those layers too (`xlsx_diff.py` formatting section, `xlsx_render.py`).
- Legacy `.xls` files: `xlrd` gives values; formulas are not recoverable from them.
