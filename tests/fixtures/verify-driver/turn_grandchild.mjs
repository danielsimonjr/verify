// Test fixture: the long-lived grandchild of a fake pi turn. It records its pid and idles.
// It exits by itself after 60 s so a failing test cannot leave it behind for long.
import { writeFileSync } from "node:fs";

writeFileSync(`${process.argv[2]}.pid`, String(process.pid));
setTimeout(() => process.exit(0), 60_000);
setInterval(() => {}, 1000);
