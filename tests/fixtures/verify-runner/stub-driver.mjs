// Stand-in for harness/driver.ts in runner tests. It contacts no model.
//
//   node stub-driver.mjs <ws> <sleep-ms>
//
// Records which .cells.tsv views existed at launch and when it started, waits, then writes
// finish.json the way the real driver does when a task completes.
import { readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const [ws, sleepMs] = process.argv.slice(2);

const views = [];
const walk = (dir) => {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (p.endsWith(".cells.tsv")) views.push(relative(ws, p).split("\\").join("/"));
  }
};
walk(ws);

writeFileSync(join(ws, "launch.json"), JSON.stringify({ views, startedAt: Date.now() }));
setTimeout(() => {
  writeFileSync(join(ws, "finish.json"), JSON.stringify({ finishedAt: Date.now() }));
}, Number(sleepMs));
