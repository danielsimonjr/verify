// Test stand-in for pdftoppm. `-v` succeeds (the probe). Otherwise it writes one stub PNG per
// page from -f to -l (default 1..$VS_STUB_PAGES) as <base>-<n>.png, where <base> is the last
// argument, and pads n the way pdftoppm does for a document of that many pages.
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "-v") {
  console.error("pdftoppm stub");
  process.exit(0);
}
const pages = parseInt(process.env.VS_STUB_PAGES ?? "4", 10);
const flag = (name: string, dflt: number) => {
  const i = args.indexOf(name);
  return i < 0 ? dflt : parseInt(args[i + 1]!, 10);
};
const first = flag("-f", 1);
const last = flag("-l", pages);
const base = args[args.length - 1]!;
const width = String(pages).length;
for (let n = first; n <= last; n++) {
  writeFileSync(`${base}-${String(n).padStart(width, "0")}.png`, "PNGSTUB");
}
