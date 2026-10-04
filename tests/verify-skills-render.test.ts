import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { sofficeToPdf } from "../harness/skills/_shared/office.ts";
import { chooseBackend, rasterizePages, type BackendProbes } from "../harness/skills/_shared/raster.ts";
import { findPython } from "../harness/skills/_shared/python.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "verify-skills");
const TABLES = join(FIXTURES, "tables.pdf"); // 4 pages, 612x792 pt

const HAVE_PYMUPDF = findPython(["fitz"]) !== null;
const HAVE_PDFTOPPM = spawnSync("pdftoppm", ["-v"], { stdio: "ignore" }).status === 0;

function scratch<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "vs-render-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): [number, number] {
  const b = readFileSync(path);
  expect(b.subarray(1, 4).toString("latin1")).toBe("PNG");
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

const none: BackendProbes = { pymupdf: () => null, pdftoppm: () => false };

describe("rasterizer selection", () => {
  test("PyMuPDF is used when a Python has it, as in the pre-port scripts", () => {
    expect(chooseBackend({ pymupdf: () => "py", pdftoppm: () => true })).toEqual({
      kind: "pymupdf",
      python: "py",
    });
    expect(chooseBackend({ pymupdf: () => "py", pdftoppm: () => false })).toEqual({
      kind: "pymupdf",
      python: "py",
    });
  });

  test("pdftoppm is used when no Python has PyMuPDF", () => {
    expect(chooseBackend({ pymupdf: () => null, pdftoppm: () => true })).toEqual({
      kind: "pdftoppm",
    });
  });

  test("nothing is chosen, and the error names both ways to fix it, when neither exists", () => {
    expect(chooseBackend(none)).toBeNull();
    scratch((dir) => {
      expect(() => rasterizePages(TABLES, dir, "page", { dpi: 72 }, none)).toThrow(
        /PyMuPDF.*pdftoppm|pdftoppm.*PyMuPDF/s,
      );
    });
  });

  test("the probe is not run for pdftoppm when PyMuPDF already answered", () => {
    let asked = false;
    chooseBackend({
      pymupdf: () => "py",
      pdftoppm: () => {
        asked = true;
        return true;
      },
    });
    expect(asked).toBe(false);
  });
});

// Each real backend must give the same result for the same page: 72 dpi means 1 px per pt.
for (const [name, available, kind] of [
  ["PyMuPDF", HAVE_PYMUPDF, "pymupdf"],
  ["pdftoppm", HAVE_PDFTOPPM, "pdftoppm"],
] as const) {
  describe(`rasterizePages with ${name}`, () => {
    const probes: BackendProbes =
      kind === "pymupdf"
        ? { pymupdf: () => findPython(["fitz"]), pdftoppm: () => false }
        : { pymupdf: () => null, pdftoppm: () => true };
    const t = test.skipIf(!available);

    t("renders every page, numbered by page, at the requested dpi", () => {
      scratch((dir) => {
        const pages = rasterizePages(TABLES, dir, "page", { dpi: 72 }, probes);
        expect(pages.map((p) => p.page)).toEqual([1, 2, 3, 4]);
        for (const p of pages) expect(pngSize(p.path)).toEqual([612, 792]);
        const pages144 = rasterizePages(TABLES, dir, "page", { dpi: 144 }, probes);
        expect(pngSize(pages144[0]!.path)).toEqual([1224, 1584]);
      });
    });

    t("renders only the pages asked for and drops stale pages of the same prefix", () => {
      scratch((dir) => {
        writeFileSync(join(dir, "page-9.png"), "stale");
        writeFileSync(join(dir, "other-1.png"), "keep");
        const pages = rasterizePages(TABLES, dir, "page", { dpi: 72, first: 2, last: 3 }, probes);
        expect(pages.map((p) => p.page)).toEqual([2, 3]);
        expect(readdirSync(dir).sort()).toEqual(["other-1.png", ...pages.map((p) => p.path.split(/[\\/]/).pop()!)].sort());
      });
    });

    t("crops to fractions of the page", () => {
      scratch((dir) => {
        const pages = rasterizePages(
          TABLES,
          dir,
          "crop",
          { dpi: 72, first: 2, last: 2, crop: { box: [0, 0.5, 0.5, 1], width: 612, height: 792 } },
          probes,
        );
        const [w, h] = pngSize(pages[0]!.path);
        // 306 x 396 pt; pdftoppm rounds to whole pixels
        expect(Math.abs(w - 306)).toBeLessThanOrEqual(1);
        expect(Math.abs(h - 396)).toBeLessThanOrEqual(1);
      });
    });

    t("a page outside the document is an error", () => {
      scratch((dir) => {
        expect(() => rasterizePages(TABLES, dir, "page", { dpi: 72, first: 9, last: 9 }, probes)).toThrow(
          /page/,
        );
      });
    });
  });
}

describe("soffice conversion", () => {
  type Call = { cmd: string; args: string[]; env: NodeJS.ProcessEnv | undefined };

  function stub(produce: (args: string[]) => void, result: Record<string, unknown> = {}) {
    const calls: Call[] = [];
    const run = ((cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ cmd, args, env: opts.env });
      produce(args);
      return { status: 0, stdout: "", stderr: "", ...result };
    }) as unknown as Parameters<typeof sofficeToPdf>[2];
    return { run, calls };
  }

  test("converts a copy with a private file:// profile and returns the PDF path", () => {
    scratch((dir) => {
      const copy = join(dir, "deck.pptx");
      writeFileSync(copy, "x");
      const { run, calls } = stub((args) => {
        const outdir = args[args.indexOf("--outdir") + 1]!;
        writeFileSync(join(outdir, "deck.pdf"), "%PDF");
      });
      const r = sofficeToPdf(copy, dir, run);
      expect(r).toEqual({ pdf: join(dir, "deck.pdf") });
      const [call] = calls;
      expect(call!.cmd).toBe("soffice");
      expect(call!.args).toContain("--headless");
      expect(call!.args.slice(call!.args.indexOf("--convert-to"))).toEqual([
        "--convert-to",
        "pdf",
        "--outdir",
        dir,
        copy,
      ]);
      // LibreOffice needs a real file URL; "file://C:\..." is not one.
      const profile = call!.args.find((a) => a.startsWith("-env:UserInstallation="))!;
      expect(profile).toMatch(/^-env:UserInstallation=file:\/\/\/.+\/profile$/);
      expect(call!.env?.HOME).toBe(dir);
    });
  });

  test("reports LibreOffice's own output when no PDF appears", () => {
    scratch((dir) => {
      const { run } = stub(() => {}, { stderr: "javaldx: Could not find a Java Runtime" });
      const r = sofficeToPdf(join(dir, "a.xlsx"), dir, run);
      expect(r).toEqual({ error: "javaldx: Could not find a Java Runtime" });
    });
  });

  test("says soffice could not be started instead of printing nothing", () => {
    scratch((dir) => {
      const { run } = stub(() => {}, { status: null, error: new Error("spawnSync soffice ENOENT") });
      const r = sofficeToPdf(join(dir, "a.xlsx"), dir, run);
      expect(r).toEqual({ error: "spawnSync soffice ENOENT" });
      expect(existsSync(join(dir, "a.pdf"))).toBe(false);
    });
  });
});

const SKILLS = join(import.meta.dir, "..", "harness", "skills");

function script(skill: string, name: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [join(SKILLS, skill, "scripts", name), ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

describe("pdf_render", () => {
  const t = test.skipIf(!HAVE_PYMUPDF && !HAVE_PDFTOPPM);

  t("writes the page under the render root and prints its path", () => {
    scratch((root) => {
      const r = script("evidence-pdf", "pdf_render.ts", [TABLES, "2", "--dpi", "72"], {
        VERIHARNESS_RENDER_DIR: root,
      });
      expect(r.status).toBe(0);
      const png = join(root, "pdf_pages", "tables_p2.png");
      expect(r.stdout.trim()).toContain(png);
      expect(r.stdout).toContain("(4 pages in document;");
      expect(pngSize(png)).toEqual([612, 792]);
      expect(readdirSync(join(root, "pdf_pages"))).toEqual(["tables_p2.png"]);
    });
  });

  t("--crop keeps the fractions of the page", () => {
    scratch((root) => {
      const r = script(
        "evidence-pdf",
        "pdf_render.ts",
        [TABLES, "2", "--dpi", "72", "--crop", "0,0,1,0.5"],
        { VERIHARNESS_RENDER_DIR: root },
      );
      expect(r.status).toBe(0);
      const [w, h] = pngSize(join(root, "pdf_pages", "tables_p2_crop.png"));
      expect(w).toBe(612);
      expect(Math.abs(h - 396)).toBeLessThanOrEqual(1);
    });
  });

  test("a page outside the document is reported, not rendered", () => {
    scratch((root) => {
      const r = script("evidence-pdf", "pdf_render.ts", [TABLES, "9"], { VERIHARNESS_RENDER_DIR: root });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("page 9 out of range 1..4");
    });
  });

  // PATH cannot hide the Windows "py" launcher, so the no-rasterizer case is POSIX only.
  test.skipIf(process.platform === "win32")("says what to install when neither rasterizer exists", () => {
    scratch((root) => {
      mkdirSync(join(root, "empty"));
      const r = script("evidence-pdf", "pdf_render.ts", [TABLES, "2"], {
        VERIHARNESS_RENDER_DIR: root,
        VERIHARNESS_PYTHON: "no-such-python-vs",
        PATH: join(root, "empty"),
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/PyMuPDF/);
      expect(r.stderr).toMatch(/pdftoppm/);
    });
  });
});

// Stand-ins for LibreOffice and pdftoppm (fixtures/verify-skills/stubs/*.ts, run by the same
// bun as the tests) sit behind a one-line launcher per OS, so the render scripts run end to
// end on any host without either program. Node cannot spawn a .cmd; Bun can.
const STUBS = join(FIXTURES, "stubs");

function installStubs(bin: string) {
  for (const name of ["soffice", "pdftoppm"]) {
    const stub = join(STUBS, `${name}.ts`);
    if (process.platform === "win32") {
      writeFileSync(join(bin, `${name}.cmd`), `@"%VS_BUN%" "${stub}" %*\r\n`);
    } else {
      const path = join(bin, name);
      writeFileSync(path, `#!/bin/sh\nexec "$VS_BUN" "${stub}" "$@"\n`);
      chmodSync(path, 0o755);
    }
  }
}

describe("office render scripts with stub soffice and pdftoppm", () => {
  type Ctx = { root: string; env: NodeJS.ProcessEnv; input: (name: string) => string };

  function withStubs<T>(fn: (ctx: Ctx) => T): T {
    return scratch((root) => {
      const bin = join(root, "bin");
      const tmp = join(root, "tmp");
      mkdirSync(bin);
      mkdirSync(tmp);
      installStubs(bin);
      const env: NodeJS.ProcessEnv = {
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        // no PyMuPDF for the run: the pdftoppm stub is the rasterizer
        VERIHARNESS_PYTHON: "no-such-python-vs",
        VERIHARNESS_RENDER_DIR: join(root, "render"),
        VS_BUN: process.execPath,
        VS_STUB_PDF: TABLES,
        TMPDIR: tmp,
        TEMP: tmp,
        TMP: tmp,
      };
      const input = (name: string) => {
        const p = join(root, name);
        writeFileSync(p, "not a real office file; the stub soffice does not read it");
        return p;
      };
      return fn({ root, env, input });
    });
  }

  test("pptx_render writes slide-NN.png per page, drops stale slides and removes its scratch", () => {
    withStubs(({ root, env, input }) => {
      const out = join(root, "render", "pptx_render", "deck");
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "slide-09.png"), "stale");
      const r = script("evidence-pptx", "pptx_render.ts", [input("deck.pptx"), "--dpi", "72"], env);
      expect(r.status).toBe(0);
      expect(readdirSync(out).sort()).toEqual([
        "slide-01.png",
        "slide-02.png",
        "slide-03.png",
        "slide-04.png",
      ]);
      expect(r.stdout.trim().split(/\r?\n/).at(-1)).toBe("# 4 slides rendered");
      expect(readdirSync(join(root, "tmp")).filter((f) => f.startsWith("pptx_render_"))).toEqual([]);
    });
  });

  test("pptx_render reports LibreOffice's message, and removes its scratch, when conversion fails", () => {
    withStubs(({ root, env, input }) => {
      const r = script("evidence-pptx", "pptx_render.ts", [input("deck.pptx")], {
        ...env,
        VS_STUB_FAIL: "boom",
      });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("conversion failed: boom");
      expect(readdirSync(join(root, "tmp")).filter((f) => f.startsWith("pptx_render_"))).toEqual([]);
    });
  });

  test("xlsx_render lists the pages of this run only", () => {
    withStubs(({ root, env, input }) => {
      const out = join(root, "render", "xlsx_render", "book");
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "page-9.png"), "stale");
      const r = script("evidence-xlsx", "xlsx_render.ts", [input("book.xlsx"), "--dpi", "72"], env);
      expect(r.status).toBe(0);
      const lines = r.stdout.trim().split(/\r?\n/);
      expect(lines[0]).toBe("4 page(s) rendered from book.xlsx:");
      expect(lines.slice(1).map((l) => l.split(/[\\/]/).pop())).toEqual([
        "page-1.png",
        "page-2.png",
        "page-3.png",
        "page-4.png",
      ]);
      expect(existsSync(join(out, "page-9.png"))).toBe(false);
    });
  });

  test("xlsx_render reports LibreOffice's message when conversion fails", () => {
    withStubs(({ env, input }) => {
      const r = script("evidence-xlsx", "xlsx_render.ts", [input("book.xlsx")], {
        ...env,
        VS_STUB_FAIL: "boom",
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("LibreOffice conversion failed: boom");
    });
  });

  test("with no rasterizer the scripts say what to install instead of exiting silently", () => {
    withStubs(({ root, env, input }) => {
      // soffice stub only: a PATH of just that, no Python, no pdftoppm
      rmSync(join(root, "bin", process.platform === "win32" ? "pdftoppm.cmd" : "pdftoppm"));
      const only = { ...env, PATH: join(root, "bin") };
      if (process.platform === "win32") only.PATH += `${delimiter}${process.env.SystemRoot}\\System32`;
      const r = script("evidence-xlsx", "xlsx_render.ts", [input("book.xlsx")], only);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/PyMuPDF/);
      expect(r.stderr).toMatch(/pdftoppm/);
    });
  });
});
