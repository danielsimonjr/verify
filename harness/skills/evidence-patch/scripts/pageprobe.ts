// Copyright 2026 The VeriHarness Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { basename, join, resolve } from "node:path";
import { chromium } from "playwright";
import { serve } from "../../_shared/static_server.js";

const COUNTS = `() => ({
  text: document.body ? document.body.innerText.length : 0,
  buttons: document.querySelectorAll('button,[role=button],input[type=button],input[type=submit]').length,
  inputs: document.querySelectorAll('input,select,textarea').length,
  svg_children: [...document.querySelectorAll('svg')].reduce((n, s) => n + s.querySelectorAll('*').length, 0),
  canvases: document.querySelectorAll('canvas').length,
  images_broken: [...document.images].filter(i => i.complete && i.naturalWidth === 0).length,
  overflow_x: document.documentElement.scrollWidth - document.documentElement.clientWidth})`;

const LAYOUT = `() => {
  const sel = e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') +
      (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const vw = document.documentElement.clientWidth, clipped = [], overflow = [];
  for (const e of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (e.scrollWidth > e.clientWidth + 2 && /(auto|scroll)/.test(cs.overflowX) && e.clientWidth > 0)
      clipped.push({selector: sel(e), scrollWidth: e.scrollWidth, clientWidth: e.clientWidth});
    const r = e.getBoundingClientRect(), pr = e.parentElement ? e.parentElement.getBoundingClientRect() : null;
    if (r.width > 0 && r.right > vw + 2 && !(pr && pr.right > vw + 2) && overflow.length < 20)
      overflow.push({selector: sel(e), right: Math.round(r.right), viewport: vw});
  }
  return {clipped: clipped.slice(0, 20), overflow};
}`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    page: { type: "string", default: "index.html" },
    mobile: { type: "boolean", default: false },
    click: { type: "string", default: "12" },
    out: { type: "string" },
  },
});
const rootArg = positionals[0];
if (!rootArg) {
  console.error("usage: pageprobe.js SERVED_DIR [--page index.html] [--mobile] [--click 12] [--out DIR]");
  process.exit(2);
}

const root = resolve(rootArg);
const pageName = values.page ?? "index.html";
if (!existsSync(join(root, pageName))) {
  console.log(JSON.stringify({ error: `${pageName} not found under ${root}` }));
  process.exit(1);
}

let playwrightOk = true;
try {
  await import("playwright");
} catch {
  playwrightOk = false;
}
if (!playwrightOk) {
  console.log(JSON.stringify({ error: "playwright is not installed; fall back to static checks" }));
  process.exit(2);
}

const { server, port } = serve(root);
const origin = `http://127.0.0.1:${port}`;
const rep: Record<string, unknown> = {
  failed_requests: [],
  outside_root: [],
  console_errors: [],
  page_errors: [],
  clicks: [],
};

try {
  let browser;
  try {
    browser = await chromium.launch({
      args: [
        "--disable-gpu",
        "--no-sandbox",
        "--disable-software-rasterizer",
        "--disable-dev-shm-usage",
      ],
    });
  } catch (e) {
    console.log(
      JSON.stringify({
        error: `browser will not launch (${String(e).slice(0, 160)}); fall back to static checks`,
      }),
    );
    process.exit(2);
  }

  const mobile = values.mobile ?? false;
  const page = await browser.newPage({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
  });

  const failed = rep.failed_requests as string[];
  const outside = rep.outside_root as string[];
  const consoleErrors = rep.console_errors as string[];
  const pageErrors = rep.page_errors as string[];

  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
  page.on("response", (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });
  page.on("requestfailed", (r) => {
    const u = r.url();
    if (u.startsWith(origin) || u.startsWith("data:") || u.startsWith("blob:") || u.startsWith("about:")) {
      failed.push(`failed ${u}`);
    }
  });
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith(origin) && !u.startsWith("data:") && !u.startsWith("blob:") && !u.startsWith("about:")) {
      outside.push(u.slice(0, 200));
    }
  });
  await page.route("**/*", (route) => {
    const u = route.request().url();
    if (!u.startsWith(origin) && !u.startsWith("data:") && !u.startsWith("blob:") && !u.startsWith("about:")) {
      route.abort();
    } else route.continue();
  });

  await page.goto(`${origin}/${pageName}`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);
  rep.dom = await page.evaluate(COUNTS);
  try {
    rep.layout = await page.evaluate(LAYOUT);
  } catch (e) {
    rep.layout = { error: String(e).slice(0, 120) };
  }

  const digest = async () =>
    createHash("md5").update(await page.content()).digest("hex");

  const controls = page.locator(
    "button:visible, [role=button]:visible, select:visible, input[type=checkbox]:visible",
  );
  const maxClick = parseInt(values.click ?? "12", 10);
  const count = await controls.count();
  const clicks = rep.clicks as { control: string; dom_changed?: boolean; error?: string }[];
  for (let i = 0; i < Math.min(maxClick, count); i++) {
    const el = controls.nth(i);
    try {
      const label = (
        (await el.innerText({ timeout: 500 }).catch(() => "")) ||
        (await el.getAttribute("aria-label")) ||
        ""
      ).slice(0, 40);
      const before = await digest();
      await el.click({ timeout: 1500 });
      await page.waitForTimeout(300);
      clicks.push({ control: label, dom_changed: (await digest()) !== before });
    } catch (e) {
      clicks.push({ control: `#${i}`, error: String(e).slice(0, 120) });
    }
  }

  const outDir = values.out ?? "/tmp";
  mkdirSync(outDir, { recursive: true });
  const shot = join(
    outDir,
    `pageprobe_${basename(resolve(root))}_${mobile ? "m" : "d"}.png`,
  );
  try {
    await page.screenshot({ path: shot, fullPage: true, timeout: 5000 });
    rep.screenshot = shot;
  } catch (e) {
    rep.screenshot = "";
    rep.screenshot_error = String(e).slice(0, 200);
  }
  await browser.close();
} finally {
  server.close();
}

for (const k of ["failed_requests", "outside_root", "console_errors", "page_errors"]) {
  rep[k] = [...new Set(rep[k] as string[])].sort().slice(0, 20);
}
console.log(JSON.stringify(rep, null, 1));
process.exit(0);
