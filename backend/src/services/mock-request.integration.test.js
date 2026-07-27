// Real-browser integration test for mockRequest (Q5 interception primitive).
// Drives doMockRequest against a live Chromium page and confirms the page
// actually receives the stubbed response. Part of the RUN_INTEGRATION suite
// (npm run test:integration); self-skips without the flag or Chromium.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { doMockRequest } from "./playwright-runner.js";

const RUN_INTEGRATION = process.env.RUN_INTEGRATION === "1";

let browser = null;
let launchError = null;
let server = null;
let base = null;

// A page that POSTs /api/orders on load and renders the result, so we can prove
// the mock's body/status reached the app. Served from a REAL local origin (not
// setContent), so a relative fetch resolves to a routable http:// URL.
const HTML = `<!doctype html><html><body>
  <div id="out">loading</div>
  <div id="status">?</div>
  <script>
    fetch('/api/orders', { method: 'POST', body: JSON.stringify({ item: 42 }) })
      .then(async (r) => {
        document.getElementById('status').textContent = String(r.status);
        document.getElementById('out').textContent = await r.text();
      })
      .catch((e) => { document.getElementById('out').textContent = 'ERR ' + e.message; });
  </script>
</body></html>`;

before(async () => {
  if (!RUN_INTEGRATION) return;
  // Local origin: serves the page at /, and a REAL /api/orders (200 "REAL") so
  // an un-mocked request has something to hit — letting us tell "mock applied"
  // from "fell through to the real server".
  server = http.createServer((req, res) => {
    if (req.url === "/api/orders") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("REAL");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(HTML);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    launchError = err;
  }
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
});

describe("mockRequest (real Chromium)", () => {
  test("skips without RUN_INTEGRATION or Chromium", (t) => {
    if (!RUN_INTEGRATION) return t.skip("set RUN_INTEGRATION=1 (npm run test:integration)");
    if (!browser) t.skip(`Chromium not available: ${launchError?.message ?? "unknown"}`);
  });

  test("stubs a matching request with the given status + body", async (t) => {
    if (!browser) return t.skip("no browser");
    const page = await browser.newPage();
    const mocked = [];
    try {
      // Arm the mock BEFORE the page loads and fires its fetch.
      const detail = await doMockRequest(
        page,
        { urlPattern: "**/api/orders", method: "POST", status: 201, body: '{"id":"ord_777"}' },
        mocked,
      );
      assert.match(detail, /Mocking \*\*\/api\/orders \(POST\) → 201/);
      assert.deepEqual(mocked, ["**/api/orders"], "pattern recorded for forensics-skip");

      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.getElementById("status").textContent !== "?", {
        timeout: 8000,
      });
      const status = await page.$eval("#status", (el) => el.textContent);
      const bodyText = await page.$eval("#out", (el) => el.textContent);
      assert.equal(status, "201", "app saw the mocked status, not the real server's 200");
      assert.match(bodyText, /ord_777/, "app saw the mocked body, not the real server's REAL");
    } finally {
      await page.close();
    }
  });

  test("method filter: a non-matching method falls through (not mocked)", async (t) => {
    if (!browser) return t.skip("no browser");
    const page = await browser.newPage();
    try {
      // Mock only PUT; the page does POST, so the mock must NOT apply and the
      // POST should fall through to the REAL server (which returns "REAL").
      await doMockRequest(page, { urlPattern: "**/api/orders", method: "PUT", status: 200, body: "x" }, []);
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.getElementById("out").textContent !== "loading", {
        timeout: 8000,
      });
      const out = await page.$eval("#out", (el) => el.textContent);
      assert.equal(out, "REAL", "unmocked POST fell through to the real server");
    } finally {
      await page.close();
    }
  });

  test("delayMs holds the response before fulfilling", async (t) => {
    if (!browser) return t.skip("no browser");
    const page = await browser.newPage();
    try {
      await doMockRequest(
        page,
        { urlPattern: "**/api/orders", method: "POST", status: 200, body: "ok", delayMs: 600 },
        [],
      );
      const start = Date.now();
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.getElementById("out").textContent === "ok", {
        timeout: 8000,
      });
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 550, `response was delayed (elapsed ${elapsed}ms >= ~600ms)`);
    } finally {
      await page.close();
    }
  });

  test("missing urlPattern throws a clear error", async (t) => {
    if (!browser) return t.skip("no browser");
    const page = await browser.newPage();
    try {
      await assert.rejects(() => doMockRequest(page, {}, []), /needs a "urlPattern"/);
    } finally {
      await page.close();
    }
  });
});
