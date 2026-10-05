// Test fixture: stands in for the driver process. It starts a long fake turn through
// runWithBudget, waits until the turn's grandchild is running, then dies the way main() does
// on an uncaught rejection (process.exit). The turn tree must not outlive it.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runWithBudget } from "../../../harness/runtime.ts";

const here = dirname(fileURLToPath(import.meta.url));
const tag = process.argv[2]!;
void runWithBudget([process.execPath, join(here, "turn_child.mjs"), tag], {
  cwd: here,
  env: process.env,
  budgetMs: 120_000,
});
const poll = setInterval(() => {
  if (existsSync(`${tag}.pid`)) {
    clearInterval(poll);
    process.exit(1);
  }
}, 50);
