// Test stand-in for `soffice ... --convert-to xlsx --outdir DIR FILE` as xlsx_recalc runs it:
// "recalculating" copies FILE into DIR under its own name. The workbook keeps whatever cached
// values it was written with, which is all the script's report needs.
import { copyFileSync } from "node:fs";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const outdir = args[args.indexOf("--outdir") + 1]!;
const input = args[args.length - 1]!;
copyFileSync(input, join(outdir, basename(input)));
