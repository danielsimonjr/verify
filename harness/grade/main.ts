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

/** Grade one deliverables directory: veriharness grade <bench> <task_key> <deliverables_dir> [--json] */

import { BENCHES } from "../config.js";
import { isMain } from "../runtime.js";
import { gradeDeliverables } from "./index.js";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let json = false;
  const args: string[] = [];
  for (const a of argv) {
    if (a === "--json") json = true;
    else args.push(a);
  }
  const [bench, key, deliverables] = args;
  if (!bench || !key || !deliverables) {
    process.stderr.write(
      "usage: veriharness grade <bench> <task_key> <deliverables_dir> [--json]\n",
    );
    return 2;
  }
  if (!BENCHES.includes(bench as (typeof BENCHES)[number])) {
    process.stderr.write(`unknown bench: ${bench}\n`);
    return 2;
  }
  const result = await gradeDeliverables(bench, key, deliverables);
  if (json) {
    console.log(JSON.stringify(result, null, 1));
  } else {
    console.log(`${result.score ?? "null"}  ${result.error ?? ""}`);
  }
  return 0;
}

if (isMain(import.meta.url)) {
  main().then((c) => process.exit(c));
}
