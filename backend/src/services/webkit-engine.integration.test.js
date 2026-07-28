// WebKit engine validation (Q1, Step 2). Mirrors the Firefox integration test's
// coverage (launch, Phase 1-4 feature parity) and additionally confirms WebKit's
// WORKING touch emulation (unlike Firefox's degraded case) and its download-path
// behavior — the two spots the audit flagged as WebKit's historical trouble.
// RUN_INTEGRATION suite; self-skips without the flag or WebKit.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { launchBrowser } from "./browser-engines.js";
import {
  viewportContextOptions,
  isDegradedMobile,
  doMockRequest,
  doExpectRequest,
  doExpectDownload,
  observe,
} from "./playwright-runner.js";

const RUN_INTEGRATION = process.env.RUN_INTEGRATION === "1";
let browser = null;
let launchError = null;
let server = null;
let base = null;

before(async () => {
  if (!RUN_INTEGRATION) return;
  server = http.createServer((req, res) => {
    if (req.url === "/api/ping") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><body>
      <button aria-label="Go" onclick="fetch('/api/ping',{method:'POST',body:'x'})">Go</button>
      <a id="dl" download="report.csv" href="data:text/csv,name%2Cval%0Aalpha%2C1%0A">Export</a>
      <div id="host"></div>
      <input type="file" id="f" />
      <script>document.getElementById('host').attachShadow({mode:'open'})
        .innerHTML='<button aria-label="Shadow Btn">S</button>';</script>
    </body></html>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await launchBrowser("webkit");
  } catch (err) {
    launchError = err;
  }
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
});

describe("WebKit engine (real browser)", () => {
  test("skips without RUN_INTEGRATION or WebKit", (t) => {
    if (!RUN_INTEGRATION) return t.skip("set RUN_INTEGRATION=1 (npm run test:integration)");
    if (!browser) t.skip(`WebKit not available: ${launchError?.message ?? "unknown"}`);
  });

  test("launchBrowser('webkit') yields a working WebKit browser", async (t) => {
    if (!browser) return t.skip("no webkit");
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    const p = await ctx.newPage();
    try {
      await p.goto(base, { waitUntil: "domcontentloaded" });
      const ua = await p.evaluate(() => navigator.userAgent);
      assert.match(ua, /WebKit/i, "running on WebKit");
      assert.doesNotMatch(ua, /Chrome\//, "not Chromium masquerading");
    } finally {
      await ctx.close();
    }
  });

  test("Phase 1-4 features work on WebKit: shadow observe, mock, expectRequest", async (t) => {
    if (!browser) return t.skip("no webkit");
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    const p = await ctx.newPage();
    try {
      await p.goto(base, { waitUntil: "networkidle" });

      const obs = await observe(p);
      assert.match(
        obs.elements.map((e) => e.descriptor).join(" | "),
        /Shadow Btn/,
        "shadow element observed under WebKit",
      );
      for (const h of Object.values(obs.byRef)) await h.dispose().catch(() => {});

      const log = [];
      p.on("request", (req) => {
        let postData = "";
        try {
          postData = req.postData() || "";
        } catch {
          /* ignore */
        }
        log.push({ url: req.url(), method: req.method(), postData, step: 5 });
      });
      await doMockRequest(p, { urlPattern: "**/api/ping", method: "POST", status: 200, body: "ok" }, []);
      await p.click('[aria-label="Go"]');
      await p.waitForTimeout(300);
      const res = doExpectRequest(log, { urlPattern: "**/api/ping", method: "POST", sinceStep: 5 });
      assert.equal(res.ok, true, "expectRequest saw the click-triggered POST on WebKit");
    } finally {
      await ctx.close();
    }
  });

  test("download path works on WebKit (audit-flagged trouble spot)", async (t) => {
    if (!browser) return t.skip("no webkit");
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    const p = await ctx.newPage();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zb-wk-dl-"));
    const artifactScope = { dir: tmpDir, publicUrlBase: "/artifacts/run/attempt-1" };
    try {
      await p.goto(base, { waitUntil: "domcontentloaded" });
      const handle = await p.$("#dl");
      const r = await doExpectDownload(p, { expectFilename: "*.csv" }, handle, artifactScope);
      assert.match(r.detail, /Downloaded report\.csv \(\d+ bytes\)/);
      const saved = path.join(tmpDir, "downloads", "report.csv");
      const stat = await fs.stat(saved);
      assert.ok(stat.size > 0, "WebKit download saved, non-empty");
    } finally {
      await p.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("WebKit has WORKING touch emulation on mobile/tablet (unlike Firefox)", async (t) => {
    if (!browser) return t.skip("no webkit");
    // WebKit keeps the full device descriptor — it is NOT a degraded-mobile case.
    assert.equal(isDegradedMobile("mobile", "webkit"), false);
    const opts = viewportContextOptions("tablet", "webkit");
    assert.ok(opts.viewport, "tablet viewport applied");
    const ctx = await browser.newContext(opts);
    const p = await ctx.newPage();
    try {
      await p.setContent("<div>x</div>");
      const touch = await p.evaluate(() => "ontouchstart" in window || navigator.maxTouchPoints > 0);
      assert.equal(touch, true, "WebKit emulates touch (real, unlike Firefox)");
    } finally {
      await ctx.close();
    }
  });
});
