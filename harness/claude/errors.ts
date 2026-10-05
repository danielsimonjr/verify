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

/** What a failed Claude Code turn means for the driver: try again, stop the lane, or give up. */

export type FailureKind = "usage-limit" | "transient" | "fatal";

/**
 * A subscription or budget limit. The window is hours, not seconds, so the harness's backoff (30 s to
 * 3 min) cannot outlast it. Claude Code words it several ways: "Usage limit reached", "you have reached
 * your weekly usage limit", "5-hour usage limit", "You've hit your monthly spend limit", "You've reached
 * your ..." (any limit), "You're out of usage credits", "You're out of extra usage", "Your org is out of
 * usage", "Your seat type doesn't include usage" and "Your usage allocation has been disabled by your
 * admin". Each apostrophe may be straight or curly.
 */
const USAGE_LIMIT = new RegExp(
  [
    "usage limit",
    "you@ve (?:hit|reached) your ",
    "reached your (?:weekly|5-hour|monthly|daily)",
    "you@re out of (?:extra )?usage",
    "org is out of usage",
    "seat type doesn@t include usage",
    "usage allocation has been disabled",
  ]
    .join("|")
    .replaceAll("@", "['’]"),
  "i",
);

/**
 * Provider and transport faults worth a retry. The CLI has already retried inside the turn; this is a
 * second layer. A status code counts only as a whole number, and only in HTTP context: "41503 tokens",
 * "0.429", a stack line "index.js:503:17" and "exit code 503" are not a 503 or a 429.
 */
const CODE = String.raw`(?<![\d.])(?:429|502|503|504|529)(?![\d:])`;

const TRANSIENT: readonly RegExp[] = [
  /\bAPI Error:? (?:429|5\d\d)\b/i,
  // A bare status code in HTTP context only. "app.js:503:17", "line 502" and "exit code 503" are not one.
  new RegExp(String.raw`(?:HTTP/?[\d.]*|status(?: code)?|api error)["']?\s*[:=]?\s*${CODE}`, "i"),
  new RegExp(String.raw`${CODE}\s+(?:service unavailable|bad gateway|gateway time-?out|overloaded|too many requests)`, "i"),
  new RegExp(String.raw`(?:failed with|responded with|returned|got|received)(?: an?)?(?: http)?(?: status)?(?: code)? ${CODE}`, "i"),
  /overloaded/i,
  /rate[_ ]limit/i,
  /\bapi_error\b/,
  /RESOURCE_EXHAUSTED|Resource exhausted|UNAVAILABLE/,
  /ECONNRESET|ETIMEDOUT|socket hang up|ENOTFOUND|EAI_AGAIN/,
];

/** Classify the text of a failed turn: the `result` event's message and the tail of stderr, joined. */
export function classifyFailure(text: string): FailureKind {
  if (USAGE_LIMIT.test(text)) return "usage-limit";
  return TRANSIENT.some((re) => re.test(text)) ? "transient" : "fatal";
}
