// Copyright 2026 The VeriHarness Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { findPython, runPythonScript, sibling } from "../../_shared/python.js";

// Table detection is pdfplumber's (ruling lines and cell grids from the page's drawing
// operators); pdf.js exposes no equivalent, and grouping text by position reports every
// prose page as a table. The retained Python script does the work; arguments pass through.
const python = findPython(["pdfplumber"]);
if (!python) {
  console.error(
    "pdf_tables needs a Python with the pdfplumber package, and none was found. No table " +
      "was detected and none was ruled out: render the page (pdf_render.js) and read it " +
      "as an image, or use pdf_words.js to tie labels to values by coordinates.",
  );
  process.exit(3);
}
process.exit(runPythonScript(python, sibling(import.meta.url, "pdf_tables.py"), process.argv.slice(2)));
