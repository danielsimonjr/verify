// Test stand-in for `soffice --headless ... --convert-to pdf --outdir DIR FILE`.
// Copies $VS_STUB_PDF to DIR/<stem of FILE>.pdf. With $VS_STUB_FAIL set it fails the way
// LibreOffice does: that message on stderr, exit 1, no PDF.
import { copyFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

const args = process.argv.slice(2);
if (process.env.VS_STUB_FAIL) {
  console.error(process.env.VS_STUB_FAIL);
  process.exit(1);
}
const outdir = args[args.indexOf("--outdir") + 1]!;
const input = args[args.length - 1]!;
copyFileSync(process.env.VS_STUB_PDF!, join(outdir, `${basename(input, extname(input))}.pdf`));
