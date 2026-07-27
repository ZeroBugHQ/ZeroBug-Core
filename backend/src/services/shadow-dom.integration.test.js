// Real-browser integration test for shadow-DOM piercing in tagFrameElements
// (Q3, Step A). Runs the REAL tagFrameElements in-page via page.evaluate against
// pages with open / nested / closed shadow roots, and confirms tagging +
// handle-clickability + the host-vs-content dedup. RUN_INTEGRATION suite.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { tagFrameElements } from "./playwright-runner.js";

const RUN_INTEGRATION = process.env.RUN_INTEGRATION === "1";
let browser = null;
let launchError = null;

before(async () => {
  if (!RUN_INTEGRATION) return;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    launchError = err;
  }
});
after(async () => {
  if (browser) await browser.close();
});

// Tag a page and return the descriptor list (via the real, exported walker).
async function tag(page) {
  return page.evaluate(tagFrameElements, { startRef: 0, max: 60 });
}

describe("shadow DOM piercing (real Chromium)", () => {
  test("skips without RUN_INTEGRATION or Chromium", (t) => {
    if (!RUN_INTEGRATION) return t.skip("set RUN_INTEGRATION=1 (npm run test:integration)");
    if (!browser) t.skip(`Chromium not available: ${launchError?.message ?? "unknown"}`);
  });

  test("tags an element inside a single OPEN shadow root, and it's clickable", async (t) => {
    if (!browser) return t.skip("no browser");
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <button>Light Button</button>
        <div id="host"></div>
        <script>
          document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
            '<button aria-label="Shadow Save">Save</button>';
        </script>`);
      const els = await tag(page);
      const descriptors = els.map((e) => e.descriptor).join(" | ");
      assert.match(descriptors, /Light Button/, "light-DOM button still tagged");
      assert.match(descriptors, /Shadow Save/, "OPEN shadow-root button tagged");
      // observe() maps refs to handles via frame.$$, which pierces open shadow
      // roots — confirm both light + shadow tagged elements are found that way,
      // and the shadow one is actually clickable.
      const handles = await page.$$("[data-zerobug-ref]");
      assert.ok(handles.length >= 2, "both light + shadow elements carry a ref attribute");
      const shadowHandle = await page.$('[aria-label="Shadow Save"]');
      assert.ok(shadowHandle, "shadow button handle resolvable");
      await shadowHandle.click({ timeout: 2000 });
    } finally {
      await page.close();
    }
  });

  test("tags an element inside a NESTED (composed) shadow root", async (t) => {
    if (!browser) return t.skip("no browser");
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <div id="outer"></div>
        <script>
          const o = document.getElementById('outer').attachShadow({ mode: 'open' });
          const mid = document.createElement('div'); o.appendChild(mid);
          mid.attachShadow({ mode: 'open' }).innerHTML =
            '<button aria-label="Deep Confirm">Confirm</button>';
        </script>`);
      const descriptors = (await tag(page)).map((e) => e.descriptor).join(" | ");
      assert.match(descriptors, /Deep Confirm/, "doubly-nested shadow button tagged");
    } finally {
      await page.close();
    }
  });

  test("CLOSED shadow root is unreachable (documented limitation, not a crash)", async (t) => {
    if (!browser) return t.skip("no browser");
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <button>Visible Light</button>
        <div id="closed"></div>
        <script>
          document.getElementById('closed').attachShadow({ mode: 'closed' }).innerHTML =
            '<button aria-label="Hidden Closed">Nope</button>';
        </script>`);
      const descriptors = (await tag(page)).map((e) => e.descriptor).join(" | ");
      assert.match(descriptors, /Visible Light/, "light DOM still works alongside a closed root");
      assert.doesNotMatch(
        descriptors,
        /Hidden Closed/,
        "closed shadow content is unreachable, as expected",
      );
    } finally {
      await page.close();
    }
  });

  test("host-vs-content dedup: only the inner interactive element gets a ref", async (t) => {
    if (!browser) return t.skip("no browser");
    const page = await browser.newPage();
    try {
      // A custom-element-style host whose interactivity is its inner button.
      // The host div is itself made 'interactive' (role=button) to force the
      // ambiguity; the walker should drop the bare host in favor of the inner one.
      await page.setContent(`
        <div id="host" role="button" style="cursor:pointer">
          <span>wrapper</span>
        </div>
        <script>
          document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
            '<button aria-label="Inner Real">Go</button>';
        </script>`);
      const els = await tag(page);
      const descriptors = els.map((e) => e.descriptor);
      const joined = descriptors.join(" | ");
      assert.match(joined, /Inner Real/, "the real inner control is tagged");
      // The bare host (role=button) should be dropped since it composed-contains
      // the inner interactive element.
      const hostTagged = descriptors.some((d) => /role|host|wrapper/i.test(d) && !/Inner Real/.test(d));
      assert.ok(!hostTagged, "the bare shadow host wrapper was NOT tagged as a separate ref");
    } finally {
      await page.close();
    }
  });
});
