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

/** Split a user base URL into the server root and its OpenAI-compatible `/v1` prefix. */

export function normalizeBaseUrl(raw: string): string {
  let value = raw.trim();
  if (!value) throw new Error("base URL is empty");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid base URL '${raw}'`);
  }
  if (url.hostname === "0.0.0.0" || url.hostname === "::") url.hostname = "127.0.0.1";
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (url.pathname === "/") url.pathname = "";
  const out = url.toString().replace(/\/+$/, "");
  return out;
}

export function apiRoots(baseUrl: string): { root: string; openai: string } {
  const trimmed = normalizeBaseUrl(baseUrl);
  if (trimmed.endsWith("/v1")) {
    return { root: trimmed.slice(0, -3), openai: trimmed };
  }
  return { root: trimmed, openai: `${trimmed}/v1` };
}
