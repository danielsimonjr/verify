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

/**
 * Python's string rules for the text the scripts print. The pre-port scripts called
 * `str.strip()` and `str.splitlines()`, and each treats a different set of characters as
 * white space or a line boundary than its JavaScript counterpart does.
 */

/** What Python's str.strip() removes; JS trim() differs on \x1c-\x1f, \x85 and \ufeff. */
const PY_SPACE = /^[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

export function pyStrip(s: string): string {
  return s.replace(PY_SPACE, "");
}

/** Python's str.splitlines: it also splits at a vertical tab, a form feed and the Unicode separators. */
export function splitLines(text: string): string[] {
  return text === "" ? [] : text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
}
