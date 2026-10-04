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


two_lines()
rotated()
