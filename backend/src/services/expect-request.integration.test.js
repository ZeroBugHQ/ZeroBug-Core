// Real-browser integration test for expectRequest + the Q10 UI->API chain.
// A genuine UI click triggers an API call; expectRequest (over a live-captured
// requestLog, exactly as the runner captures it) asserts the call fired with the
// right method and body — all in one flow, proving UI and network assertions mix
// with zero mode restructuring. RUN_INTEGRATION suite; self-skips otherwise.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { doExpectRequest, doMockRequest } from "./playwright-runner.js";

const RUN_INTEGRATION = process.env.RUN_INTEGRATION === "1";

let browser = null;
let launchError = null;
let server = null;
let base = null;

// A page with a "Place order" button that POSTs /api/orders when clicked, plus
// some page-load traffic (GET /api/session) so sinceStep has something to exclude.
const HTML = `<!doctype html><html><body>
  <button id="place">Place order</button>
  <div id="out">idle</div>
  <script>
    fetch('/api/session');  // page-load traffic (step 0)
    document.getElementById('place').addEventListener('click', () => {
      fetch('/api/orders', { method: 'POST', body: JSON.stringify({ sku: 'abc_123', qty: 1 }) })
        .then(r => r.text()).then(t => { document.getElementById('out').textContent = t; });
    });
  </script>
</body></html>`;

before(async () => {
  if (!RUN_INTEGRATION) return;
  server = http.createServer((req, res) => {
    if (req.url === "/api/orders") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"id":"ord_1"}');
      return;
    }
    if (req.url === "/api/session") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
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

// Attach the same kind of request capture the runner uses, with a mutable step
// stamp so we can exercise sinceStep the way the agent loop does.
function capture(page) {
  const log = [];
  const ctl = { step: 0 };
  page.on("request", (req) => {
    let postData = "";
    try {
      postData = req.postData() || "";
    } catch {
      /* ignore */
    }
    log.push({ url: req.url(), method: req.method(), postData, step: ctl.step });
  });
  return { log, ctl };
}

describe("expectRequest + Q10 UI->API chain (real Chromium)", () => {
  test("skips without RUN_INTEGRATION or Chromium", (t) => {
    if (!RUN_INTEGRATION) return t.skip("set RUN_INTEGRATION=1 (npm run test:integration)");
    if (!browser) t.skip(`Chromium not available: ${launchError?.message ?? "unknown"}`);
  });

  test("UI click triggers a POST; expectRequest asserts it fired with the right body", async (t) => {
    if (!browser) return t.skip("no browser");
    const page = await browser.newPage();
    const { log, ctl } = capture(page);
    try {
      await page.goto(base, { waitUntil: "networkidle" }); // page-load traffic at step 0
      ctl.step = 5; // simulate the agent advancing to the click step
      await page.click("#place");
      await page.waitForFunction(() => document.getElementById("out").textContent !== "idle", {
        timeout: 8000,
      });

      // The chain: assert the click's POST fired, scoped to since the click step.
      const res = doExpectRequest(log, {
        urlPattern: "**/api/orders",
        method: "POST",
        bodyContains: "abc_123",
        sinceStep: 5,
      });
      assert.equal(res.ok, true, res.detail);
      assert.equal(res.evidence.matched.method, "POST");
      assert.ok(res.evidence.matched.step >= 5, "matched the click-triggered request, not page load");
    } finally {
      await page.close();
    }
  });

  test("expectRequest fails clearly when the expected call never fires", async (t) => {
    if (!browser) return t.skip("no browser");
    const page = await browser.newPage();
    const { log, ctl } = capture(page);
    try {
      await page.goto(base, { waitUntil: "networkidle" });
      ctl.step = 5;
      // Do NOT click. Assert the POST that never happened.
      const res = doExpectRequest(log, { urlPattern: "**/api/orders", method: "POST", sinceStep: 5 });
      assert.equal(res.ok, false);
      assert.match(res.detail, /none fired/);
    } finally {
      await page.close();
    }
  });

  test("mock + expect together: force a 500, confirm the app still SENT the request", async (t) => {
    if (!browser) return t.skip("no browser");
    const page = await browser.newPage();
    const { log, ctl } = capture(page);
    try {
      // Mock the order endpoint to 500 BEFORE navigating.
      await doMockRequest(page, { urlPattern: "**/api/orders", method: "POST", status: 500, body: "boom" }, []);
      await page.goto(base, { waitUntil: "networkidle" });
      ctl.step = 5;
      await page.click("#place");
      await page.waitForFunction(() => document.getElementById("out").textContent === "boom", {
        timeout: 8000,
      });
      // Even though the response was a forced 500, the app still SENT the POST —
      // expectRequest asserts on the outgoing request, independent of the mock.
      const res = doExpectRequest(log, { urlPattern: "**/api/orders", method: "POST", sinceStep: 5 });
      assert.equal(res.ok, true, res.detail);
    } finally {
      await page.close();
    }
  });

  test("mock + expect together: SLOW endpoint (delayMs), request still asserted", async (t) => {
    if (!browser) return t.skip("no browser");
    const page = await browser.newPage();
    const { log, ctl } = capture(page);
    try {
      // Mock the endpoint to respond slowly (500ms) — simulating a laggy backend.
      await doMockRequest(
        page,
        { urlPattern: "**/api/orders", method: "POST", status: 200, body: "slow-ok", delayMs: 500 },
        [],
      );
      await page.goto(base, { waitUntil: "networkidle" });
      ctl.step = 5;
      const clickedAt = Date.now();
      await page.click("#place");
      await page.waitForFunction(() => document.getElementById("out").textContent === "slow-ok", {
        timeout: 8000,
      });
      // The response was deliberately delayed, but the request itself fired
      // promptly on click — expectRequest sees it regardless of response timing.
      assert.ok(Date.now() - clickedAt >= 450, "the mocked response was actually delayed");
      const res = doExpectRequest(log, { urlPattern: "**/api/orders", method: "POST", sinceStep: 5 });
      assert.equal(res.ok, true, res.detail);
    } finally {
      await page.close();
    }
  });
});
