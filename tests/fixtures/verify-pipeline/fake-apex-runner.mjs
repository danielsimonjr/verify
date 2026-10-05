// A stand-in for the APEX grading runner (`python -m runner.main`). It records how it was started
// and then behaves as FAKE_MODE says. Test fixture only.
import { spawn } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const flags = {};
for (let i = 2; i < process.argv.length; i += 2) flags[process.argv[i]] = process.argv[i + 1];

const capture = process.env.CAPTURE_DIR;
mkdirSync(capture, { recursive: true });
appendFileSync(
  join(capture, "calls.jsonl"),
  JSON.stringify({ key: process.env.GEMINI_API_KEY ?? null, cwd: process.cwd(), flags: Object.keys(flags) }) + "\n",
);
copyFileSync(flags["--final-snapshot"], join(capture, `final-${process.pid}.zip`));

const done = () => {
  writeFileSync(
    flags["--output"],
    JSON.stringify({
      grading_run_status: "completed",
      verifier_results: [
        { verifier_id: "v1", score: 1, status: "ok" },
        { verifier_id: "v2", score: 0, status: "ok" },
      ],
      scoring_results: { final_score: 0.5 },
    }),
  );
  process.exit(0);
};

const mode = process.env.FAKE_MODE ?? "ok";
if (mode === "ok") done();
else if (mode === "sleep") setTimeout(done, Number(process.env.SLEEP_MS ?? 500));
else if (mode === "tree") {
  const gc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 25000)"], { stdio: "ignore" });
  writeFileSync(process.env.PID_FILE, String(gc.pid));
  setTimeout(() => {}, 60000);
} else if (mode === "fail") {
  process.stderr.write("runner exploded: bad credentials\n");
  process.exit(2);
} else if (mode === "silent") process.exit(1);
else if (mode === "done-then-fail") {
  // A complete result file, then a failing exit: a crash after the write, or a file that is not final.
  writeFileSync(
    flags["--output"],
    JSON.stringify({
      grading_run_status: "completed",
      verifier_results: [
        { verifier_id: "v1", score: 1, status: "ok" },
        { verifier_id: "v2", score: 1, status: "ok" },
      ],
      scoring_results: { final_score: 1 },
    }),
  );
  process.stderr.write("runner crashed during shutdown\n");
  process.exit(3);
} else if (mode === "done-then-kill") {
  writeFileSync(flags["--output"], JSON.stringify({ grading_run_status: "completed", verifier_results: [] }));
  process.kill(process.pid, "SIGKILL");
}
