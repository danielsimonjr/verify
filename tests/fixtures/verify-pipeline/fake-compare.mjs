// A stand-in for sb2_compare.py: reads the JSON payload on stdin and prints a result as
// FAKE_COMPARE_MODE says. Test fixture only.
import { readFileSync } from "node:fs";

const payload = JSON.parse(readFileSync(0, "utf8"));
const mode = process.env.FAKE_COMPARE_MODE ?? "ok";
if (mode === "ok") {
  process.stdout.write(JSON.stringify({ score: 1, detail: { id: payload.data.id, cat: payload.cat }, grader: "fake", utf8: process.env.PYTHONUTF8 ?? null }) + "\n");
} else if (mode === "empty") process.exit(0);
else if (mode === "garbage") process.stdout.write("this is not json\n");
else if (mode === "noscore") process.stdout.write(JSON.stringify({ detail: {} }) + "\n");
else if (mode === "fail") {
  process.stderr.write("Traceback: ModuleNotFoundError: No module named 'openpyxl'\n");
  process.exit(1);
} else if (mode === "hang") setTimeout(() => {}, 60000);
