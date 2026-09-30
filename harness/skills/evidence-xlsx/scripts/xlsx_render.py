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
"""Render a workbook (all sheets, charts included) to PNG pages you can look at
with the read tool — the way a grader sees it, not the XML.

usage: xlsx_render.py FILE [--dpi 110]

Converts a COPY with headless LibreOffice to PDF (no recalculation is relied on;
this is for layout, charts and formatting), then rasterises each page to
/tmp/xlsx_render/<stem>/page-N.png and prints the paths. Conversion can take
10-60 s on large workbooks.
"""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

ap = argparse.ArgumentParser(
    description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
)
ap.add_argument("file")
ap.add_argument("--dpi", type=int, default=110)
a = ap.parse_args()
src = Path(a.file).resolve()
out = Path("/tmp/xlsx_render") / src.stem
out.mkdir(parents=True, exist_ok=True)
copy = out / src.name
shutil.copy2(src, copy)
# A private profile: LibreOffice refuses to start for a user whose profile dir it cannot create,
# and HOME alone is not enough inside a task image run as a foreign uid.
env = dict(os.environ, HOME=str(out))  # never touches the original
r = subprocess.run(
    [
        "soffice",
        f"-env:UserInstallation=file://{out / 'profile'}",
        "--headless",
        "--convert-to",
        "pdf",
        "--outdir",
        str(out),
        str(copy),
    ],
    capture_output=True,
    text=True,
    timeout=300,
    env=env,
)
pdf = out / (src.stem + ".pdf")
if not pdf.exists():
  sys.exit(
      f"LibreOffice conversion failed: {r.stderr.strip()[-400:] or r.stdout.strip()[-400:]}"
  )
# PyMuPDF where it is installed, pdftoppm otherwise: a task image that carries the Python
# document stack need not also carry poppler, and several do not.
try:
  import fitz

  with fitz.open(str(pdf)) as doc:
    for i, page in enumerate(doc, 1):
      page.get_pixmap(dpi=a.dpi).save(str(out / f"page-{i}.png"))
except ImportError:
  subprocess.run(
      ["pdftoppm", "-r", str(a.dpi), "-png", str(pdf), str(out / "page")],
      check=True,
  )
pages = sorted(out.glob("page-*.png"), key=lambda p: int(p.stem.split("-")[-1]))
print(f"{len(pages)} page(s) rendered from {src.name}:")
for p in pages:
  print(p)
