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
 * Materialization CLI: one entry, one adapter per benchmark.
 *
 *     bun harness/materialize/main.ts <bench> [--pool P] [--only KEY] [--limit N]
 */

import { BENCHES, type Bench } from "../config.js";
import { isMain } from "../runtime.js";
import { UsageError, runCli, type TaskIterable } from "./base.js";

const ADAPTERS: Record<Bench, () => Promise<{ POOLS: Record<string, unknown>; iterTasks: (pool: string) => TaskIterable }>> = {
  apex: () => import("./apex.js"),
  wsb: () => import("./wsb.js"),
  wb: () => import("./wb.js"),
  sb2: () => import("./sb2.js"),
  jb: () => import("./jb.js"),
};

export async function main(argv: string[]): Promise<number> {
  const bench = argv[0];
  if (!bench || !BENCHES.includes(bench as Bench)) {
    process.stderr.write(
      `usage: materialize <${BENCHES.join("|")}> [--pool P] [--only KEY] [--limit N]\n`,
    );
    return 2;
  }
  const adapter = await ADAPTERS[bench as Bench]!();
  const pools = Object.keys(adapter.POOLS);
  try {
    return await runCli(bench, pools, adapter.iterTasks, argv.slice(1));
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`materialize: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
