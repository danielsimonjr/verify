#!/usr/bin/env node
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
 * CLI: bun harness/cli.ts <cmd> ...
 * Production: node dist/harness/cli.js <cmd> ...
 */

import { isMain } from "./runtime.js";

const USAGE = `usage: veriharness <command> [args]

commands:
  driver        run one task workspace
  runner        batch-run cells
  score         score a cell
  materialize   build task workspaces from an archive
  grade         grade one deliverables directory
  env-derive    derive WorkBuddy images with the tool stack
  model-check   probe a local Ollama or llama.cpp server, or the Claude Code CLI
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    process.stderr.write(USAGE);
    return cmd ? 0 : 2;
  }
  switch (cmd) {
    case "driver": {
      const m = await import("./driver.js");
      return m.main(rest);
    }
    case "runner": {
      const m = await import("./runner.js");
      return m.main(rest);
    }
    case "score": {
      const m = await import("./score.js");
      return m.main(rest);
    }
    case "materialize": {
      const m = await import("./materialize/main.js");
      return m.main(rest);
    }
    case "grade": {
      const m = await import("./grade/main.js");
      return m.main(rest);
    }
    case "env-derive": {
      const m = await import("./env/derive.js");
      return m.main(rest);
    }
    case "model-check": {
      const m = await import("./model/check.js");
      return m.main(rest);
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n${USAGE}`);
      return 2;
  }
}

if (isMain(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
