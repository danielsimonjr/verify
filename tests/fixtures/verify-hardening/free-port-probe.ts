// Runs grade/wb.ts freePort() while recording the arguments of every Server.listen call, and prints
// them as one "RESULT <json>" line. A subprocess, because importing wb.ts needs VERIHARNESS_BENCH_ROOT
// and the test process must keep its own environment.
import net from "node:net";

const seen: unknown[][] = [];
const real = net.Server.prototype.listen;
net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]) {
  seen.push(args.filter((a) => typeof a !== "function"));
  return (real as (...a: unknown[]) => net.Server).apply(this, args);
} as typeof net.Server.prototype.listen;

const { freePort } = await import("../../../harness/grade/wb.ts");
const port = await freePort();
console.log(`RESULT ${JSON.stringify({ listen: seen, port })}`);
