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
 * your weekly usage limit", "5-hour usage limit", "You've hit your monthly spend limit".
 */
const USAGE_LIMIT = /usage limit|you(?:'|’)ve hit your |reached your (?:weekly|5-hour|monthly|daily)/i;

/**
 * Provider and transport faults worth a retry. The CLI has already retried inside the turn; this is a
 * second layer. A status code counts only as a whole number: "41503 tokens" and "0.429" are not a 503
 * or a 429.
 */
const TRANSIENT: readonly RegExp[] = [
  /\bAPI Error:? (?:429|5\d\d)\b/i,
  /(?<![\d.])(?:429|502|503|504|529)(?!\d)/,
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
