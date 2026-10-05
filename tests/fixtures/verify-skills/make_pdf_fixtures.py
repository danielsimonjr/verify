"""Regenerates the PDF fixtures used by tests/verify-skills-pdf.test.ts.

Run: python tests/fixtures/verify-skills/make_pdf_fixtures.py
Needs PyMuPDF (pip install pymupdf). The committed bytes are the source of truth for the
tests; this script records how they were made.
"""

from pathlib import Path

import fitz  # PyMuPDF

here = Path(__file__).parent


def two_lines() -> None:
  """US Letter page. FIRSTLINE is drawn near the top, SECONDLINE below it."""
  doc = fitz.open()
  page = doc.new_page(width=612, height=792)
  # insert_text takes the baseline origin in top-left coordinates.
  page.insert_text((72, 100), "FIRSTLINE", fontsize=12, fontname="helv")
  page.insert_text((72, 200), "SECONDLINE", fontsize=12, fontname="helv")
  doc.save(here / "two-lines.pdf", deflate=False, garbage=0)


def rotated() -> None:
  """Same two lines on a page whose /Rotate is 90 (landscape when displayed)."""
  doc = fitz.open()
  page = doc.new_page(width=612, height=792)
  page.insert_text((72, 100), "FIRSTLINE", fontsize=12, fontname="helv")
  page.insert_text((72, 200), "SECONDLINE", fontsize=12, fontname="helv")
  page.set_rotation(90)
  doc.save(here / "two-lines-rotated90.pdf", deflate=False, garbage=0)


def tables() -> None:
  """Page 1: prose, no rules. 2: a ruled 3x3 table. 3: aligned columns, no rules. 4: ruled, one multi-line cell."""
  doc = fitz.open()
  prose = doc.new_page(width=612, height=792)
  text = (
      "This is an ordinary paragraph of running prose. It has no ruling lines and no"
      " columns, so a table detector must not report it as a table. The quick brown"
      " fox jumps over the lazy dog and keeps running across the page."
  )
  prose.insert_textbox(fitz.Rect(72, 72, 540, 300), text, fontsize=11, fontname="helv")

  ruled = doc.new_page(width=612, height=792)
  x = [72, 192, 312, 432]
  y = [100, 130, 160, 190]
  for yy in y:
    ruled.draw_line((x[0], yy), (x[-1], yy), width=0.8)
  for xx in x:
    ruled.draw_line((xx, y[0]), (xx, y[-1]), width=0.8)
  rows = [("Item", "Qty", "Price"), ("Widget", "4", "9.50"), ("Gadget", "12", "3.25")]
  for r, row in enumerate(rows):
    for c, cell in enumerate(row):
      ruled.insert_text((x[c] + 6, y[r] + 20), cell, fontsize=11, fontname="helv")

  aligned = doc.new_page(width=612, height=792)
  grid = [
      ("Region", "Units", "Revenue"),
      ("North", "120", "4,800"),
      ("South", "95", "3,610"),
      ("East", "143", "5,720"),
      ("West", "88", "3,300"),
  ]
  for r, row in enumerate(grid):
    for c, cell in enumerate(row):
      aligned.insert_text((72 + c * 150, 100 + r * 24), cell, fontsize=11, fontname="helv")
  multi = doc.new_page(width=612, height=792)
  mx = [72, 252, 432]
  my = [100, 160, 190]
  for yy in my:
    multi.draw_line((mx[0], yy), (mx[-1], yy), width=0.8)
  for xx in mx:
    multi.draw_line((xx, my[0]), (xx, my[-1]), width=0.8)
  multi.insert_text((mx[0] + 6, my[0] + 20), "Note", fontsize=11, fontname="helv")
  multi.insert_text((mx[0] + 6, my[0] + 36), "continued", fontsize=11, fontname="helv")
  multi.insert_text((mx[1] + 6, my[0] + 20), "Status", fontsize=11, fontname="helv")
  multi.insert_text((mx[0] + 6, my[1] + 20), "Late fee", fontsize=11, fontname="helv")
  multi.insert_text((mx[1] + 6, my[1] + 20), "Waived", fontsize=11, fontname="helv")
  doc.save(here / "tables.pdf", deflate=False, garbage=0)


two_lines()
rotated()
tables()
