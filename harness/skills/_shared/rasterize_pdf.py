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

"""Rasterize PDF pages to PNG with PyMuPDF (the PyMuPDF path of _shared/raster.ts).

usage: rasterize_pdf.py PDF PREFIX --dpi N [--first N] [--last N] [--clip x0,y0,x1,y1]

Writes PREFIX-<page>.png (page number from 1, no padding) for each page from --first to
--last (default: all) and prints each path. --clip takes fractions of the page rectangle.
The task images install PyMuPDF with the other Python document libraries (STACK in
env/derive.ts) but do not all carry Poppler's pdftoppm.
"""

import argparse
import sys

import fitz  # PyMuPDF

sys.stdout.reconfigure(encoding="utf-8")

ap = argparse.ArgumentParser(
    description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
)
ap.add_argument("pdf")
ap.add_argument("prefix")
ap.add_argument("--dpi", type=int, required=True)
ap.add_argument("--first", type=int)
ap.add_argument("--last", type=int)
ap.add_argument("--clip", help="x0,y0,x1,y1 as fractions of the page")
a = ap.parse_args()

with fitz.open(a.pdf) as doc:
  first = a.first or 1
  last = a.last or doc.page_count
  if not 1 <= first <= last <= doc.page_count:
    sys.exit(f"pages {first}..{last} out of range 1..{doc.page_count}")
  fractions = [float(v) for v in a.clip.split(",")] if a.clip else None
  for number in range(first, last + 1):
    page = doc[number - 1]
    clip = None
    if fractions:
      r = page.rect
      x0, y0, x1, y1 = fractions
      clip = fitz.Rect(
          r.x0 + x0 * r.width,
          r.y0 + y0 * r.height,
          r.x0 + x1 * r.width,
          r.y0 + y1 * r.height,
      )
    path = f"{a.prefix}-{number}.png"
    page.get_pixmap(dpi=a.dpi, clip=clip).save(path)
    print(path)
