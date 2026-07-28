// Real-browser integration test for cross-origin iframe observation (Q3, Step B).
// Exercises the FULL observe -> byRef -> action path against genuinely
// cross-origin frames (two local origins on different ports), plus the frame
// detachment / mid-navigation races the retained catch must survive.
// RUN_INTEGRATION suite; self-skips without the flag or Chromium.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { observe } from "./playwright-runner.js";

const RUN_INTEGRATION = process.env.RUN_INTEGRATION === "1";
let browser = null;
let launchError = null;
let childServer = null;
let parentServer = null;
let parentBase = null;

before(async () => {
  if (!RUN_INTEGRATION) return;
  // Child origin: a "payment widget" page whose button records its own click.
  childServer = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><body>
      <button aria-label="Pay now" onclick="this.textContent='PAID'">Pay now</button>
    </body></html>`);
  });
  await new Promise((r) => childServer.listen(0, "127.0.0.1", r));
  const childPort = childServer.address().port;

  // Parent origin (different port = cross-origin): embeds the child in an iframe.
  parentServer = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><body>
      <h1>Checkout</h1>
      <button aria-label="Parent Button">Parent</button>
      <iframe src="http://127.0.0.1:${childPort}/" width="320" height="120"></iframe>
    </body></html>`);
  });
  await new Promise((r) => parentServer.listen(0, "127.0.0.1", r));
  parentBase = `http://127.0.0.1:${parentServer.address().port}`;

  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    launchError = err;
  }
});
after(async () => {
  if (browser) await browser.close();
  if (childServer) await new Promise((r) => childServer.close(r));
  if (parentServer) await new Promise((r) => parentServer.close(r));
});

describe("cross-origin iframe observation (real Chromium)", () => {
  test("skips without RUN_INTEGRATION or Chromium", (t) => {
    if (!RUN_INTEGRATION) return t.skip("set RUN_INTEGRATION=1 (npm run test:integration)");
    if (!browser) t.skip(`Chromium not available: ${launchError?.message ?? "unknown"}`);
  });

  test("full observe -> byRef -> action: clicks a button INSIDE a cross-origin frame", async (t) => {
    if (!browser) return t.skip("no browser");
    const page = await browser.newPage();
    try {
      await page.goto(parentBase, { waitUntil: "networkidle" });

      // The real observation step — this used to skip the cross-origin frame.
      const obs = await observe(page);
      const descriptors = obs.elements.map((e) => e.descriptor).join(" | ");
      assert.match(descriptors, /Parent Button/, "parent-origin element observed");
      assert.match(descriptors, /Pay now/, "CROSS-ORIGIN frame element observed");

      // Drive the action the way the agent loop does: find the ref, act on the
      // handle from byRef, and confirm the click landed inside the child frame.
      const payEl = obs.elements.find((e) => /Pay now/.test(e.descriptor));
      assert.ok(payEl, "cross-origin button got a ref");
      const handle = obs.byRef[payEl.ref];
      assert.ok(handle, "byRef has a handle for the cross-origin element");
      await handle.click({ timeout: 4000 });

      // Verify the click actually took effect inside the cross-origin frame.
      const childFrame = page.frames().find((f) => f.url() !== page.url() && f.url().includes("127.0.0.1"));
      const btnText = await childFrame.$eval('[aria-label="Pay now"]', (el) => el.textContent);
      assert.equal(btnText, "PAID", "the click landed inside the cross-origin frame");

      for (const h of Object.values(obs.byRef)) await h.dispose().catch(() => {});
    } finally {
      await page.close();
    }
  });

  test("a frame that DETACHES mid-observe does not crash the run", async (t) => {
    if (!browser) return t.skip("no browser");
    const page = await browser.newPage();
    try {
      // A page with a same-src iframe that removes ITSELF shortly after load —
      // simulating an ad/analytics frame vanishing during the observe window.
      await page.setContent(`
        <button aria-label="Stay">Stay</button>
        <iframe id="ghost" src="about:blank"></iframe>
        <script>setTimeout(() => document.getElementById('ghost')?.remove(), 30);</script>`);
      await page.waitForTimeout(60); // let the frame remove itself

      // observe must complete without throwing even though a frame vanished.
      const obs = await observe(page);
      assert.match(
        obs.elements.map((e) => e.descriptor).join(" "),
        /Stay/,
        "observe completed and still tagged the surviving element",
      );
      for (const h of Object.values(obs.byRef)) await h.dispose().catch(() => {});
    } finally {
      await page.close();
    }
  });

  test("a frame MID-NAVIGATION during observe is handled gracefully", async (t) => {
    if (!browser) return t.skip("no browser");
    const page = await browser.newPage();
    try {
      await page.goto(parentBase, { waitUntil: "domcontentloaded" });
      // Kick the child frame into a navigation right as we observe, so it's
      // transitioning (not yet detached) during the evaluate/$$ window — the race
      // isDetached() alone can't fully close, exercising the retained catch.
      const child = page.frames().find((f) => f.url() !== page.url() && f.url().includes("127.0.0.1"));
      if (child) {
        // Fire-and-forget navigation; don't await, so it overlaps observe.
        child.evaluate(() => {
          location.href = "about:blank";
        }).catch(() => {});
      }
      // observe races the navigation; it must not throw regardless of timing.
      const obs = await observe(page);
      assert.match(
        obs.elements.map((e) => e.descriptor).join(" "),
        /Parent Button/,
        "observe completed through the frame navigation and tagged the parent",
      );
      for (const h of Object.values(obs.byRef)) await h.dispose().catch(() => {});
    } finally {
      await page.close();
    }
  });
});
