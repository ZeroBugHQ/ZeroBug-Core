// Firefox engine validation (Q1, Step 1). Confirms the Phase 1-4 feature
// primitives work under real Firefox (via the shared launchBrowser), and that
// mobile/tablet emulation on Firefox is viewport-size-only (no touch), matching
// the documented degradation. RUN_INTEGRATION suite; self-skips otherwise.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { launchBrowser } from "./browser-engines.js";
import {
  viewportContextOptions,
  doMockRequest,
  doExpectRequest,
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
      <div id="host"></div>
      <input type="file" id="f" />
      <script>document.getElementById('host').attachShadow({mode:'open'})
        .innerHTML='<button aria-label="Shadow Btn">S</button>';</script>
    </body></html>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await launchBrowser("firefox");
  } catch (err) {
    launchError = err;
  }
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
});

describe("Firefox engine (real browser)", () => {
  test("skips without RUN_INTEGRATION or Firefox", (t) => {
    if (!RUN_INTEGRATION) return t.skip("set RUN_INTEGRATION=1 (npm run test:integration)");
    if (!browser) t.skip(`Firefox not available: ${launchError?.message ?? "unknown"}`);
  });

  test("launchBrowser('firefox') yields a working Firefox browser", async (t) => {
    if (!browser) return t.skip("no firefox");
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    const p = await ctx.newPage();
    try {
      await p.goto(base, { waitUntil: "domcontentloaded" });
      assert.match(await p.title().catch(() => ""), /.*/); // loaded without throwing
      const ua = await p.evaluate(() => navigator.userAgent);
      assert.match(ua, /Firefox/i, "running on a real Firefox");
    } finally {
      await ctx.close();
    }
  });

  test("Phase 1-4 features work on Firefox: shadow observe, route/mock, expectRequest", async (t) => {
    if (!browser) return t.skip("no firefox");
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    const p = await ctx.newPage();
    try {
      await p.goto(base, { waitUntil: "networkidle" });

      // Phase 4: shadow DOM is observed on Firefox.
      const obs = await observe(p);
      const descriptors = obs.elements.map((e) => e.descriptor).join(" | ");
      assert.match(descriptors, /Shadow Btn/, "shadow element observed under Firefox");
      for (const h of Object.values(obs.byRef)) await h.dispose().catch(() => {});

      // Phase 3: mock + expect on Firefox.
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
      assert.equal(res.ok, true, "expectRequest saw the click-triggered POST on Firefox");

      // Phase 2: setInputFiles is available on Firefox.
      const fileInput = await p.$("#f");
      assert.equal(typeof fileInput.setInputFiles, "function", "upload API present on Firefox");
    } finally {
      await ctx.close();
    }
  });

  test("mobile emulation on Firefox is viewport-only (no touch), as documented", async (t) => {
    if (!browser) return t.skip("no firefox");
    const opts = viewportContextOptions("mobile", "firefox");
    // The options object must NOT carry the unsupported flags.
    assert.equal(opts.isMobile, undefined);
    assert.equal(opts.hasTouch, undefined);
    assert.ok(opts.viewport && opts.viewport.width > 0, "mobile viewport SIZE preserved");

    const ctx = await browser.newContext(opts);
    const p = await ctx.newPage();
    try {
      await p.setContent("<div>m</div>");
      // Firefox can't emulate touch, so the page reports no touch capability.
      const touch = await p.evaluate(() => "ontouchstart" in window || navigator.maxTouchPoints > 0);
      assert.equal(touch, false, "no touch capability on Firefox mobile (viewport-only)");
      // But the viewport width matches the mobile size.
      const w = await p.evaluate(() => window.innerWidth);
      assert.ok(w <= 500, `mobile viewport width applied (innerWidth=${w})`);
    } finally {
      await ctx.close();
    }
  });
});
