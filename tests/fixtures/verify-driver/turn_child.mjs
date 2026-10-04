// Test fixture: a fake pi turn. It starts a DETACHED grandchild that inherits stderr (so the
// grandchild is outside the child's process group and holds the stderr pipe open), then idles.
// argv[2] is the path prefix for the pid file; argv[3] "noisy" makes the child flood stderr first.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv[3] === "noisy") {
  process.stderr.write("x".repeat(2_000_000) + "END-OF-NOISE\n");
}
spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "turn_grandchild.mjs"), process.argv[2]], {
  detached: true,
  stdio: ["ignore", "ignore", "inherit"],
});
setTimeout(() => process.exit(0), 60_000);
setInterval(() => {}, 1000);
