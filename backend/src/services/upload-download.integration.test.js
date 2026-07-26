// Real-browser integration test for the uploadFile + expectDownload actions.
// Drives doUpload/doExpectDownload against a live Chromium page built with
// setContent (no network, no Mongo). Self-skips if a Chromium binary isn't
// installed. Run with: node --test
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { doUpload, doExpectDownload } from "./playwright-runner.js";
import { config } from "../config.js";

// Real-browser tests are excluded from the default `npm test` (fast/unit-only)
// and run via `npm run test:integration`, which sets RUN_INTEGRATION=1. When the
// flag is unset every test here self-skips, so a stray default run stays green.
const RUN_INTEGRATION = process.env.RUN_INTEGRATION === "1";

let chromium = null;
let browser = null;
let launchError = null;

before(async () => {
  if (!RUN_INTEGRATION) return;
  try {
    ({ chromium } = await import("playwright"));
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    launchError = err;
  }
});
after(async () => {
  if (browser) await browser.close();
});

const HTML = `<!doctype html><html><body>
  <input id="file" type="file" />
  <button id="uploadBtn">Choose file</button>
  <input id="hiddenFile" type="file" style="display:none" />
  <a id="dl" download="report.csv"
     href="data:text/csv;charset=utf-8,name%2Cvalue%0Aalpha%2C1%0Abeta%2C2%0A">Download report</a>
  <button id="noDl">Does nothing</button>
  <script>
    // Route the visible button to the hidden file input, so it acts as a trigger.
    document.getElementById('uploadBtn').addEventListener('click', () =>
      document.getElementById('hiddenFile').click());
  </script>
</body></html>`;

describe("uploadFile + expectDownload (real Chromium)", () => {
  test("skips cleanly when not in integration mode or Chromium is unavailable", (t) => {
    if (!RUN_INTEGRATION) return t.skip("set RUN_INTEGRATION=1 (npm run test:integration)");
    if (!browser) t.skip(`Chromium not available: ${launchError?.message ?? "unknown"}`);
  });

  test("uploadFile via setInputFiles on a raw <input type=file>", async (t) => {
    if (!browser) return t.skip("no browser");
    const page = await browser.newPage();
    try {
      await page.setContent(HTML);
      const handle = await page.$("#file");
      const detail = await doUpload(page, { fixture: "csv" }, handle, { _id: "t1" });
      assert.match(detail, /Uploaded sample\.csv/);
      const uploadedName = await page.$eval("#file", (el) => el.files[0]?.name);
      assert.equal(uploadedName, "sample.csv", "the input received the fixture file");
    } finally {
      await page.close();
    }
  });

  test("uploadFile falls back to filechooser when ref is a trigger button", async (t) => {
    if (!browser) return t.skip("no browser");
    const page = await browser.newPage();
    try {
      await page.setContent(HTML);
      const handle = await page.$("#uploadBtn"); // a button, not the input
      const detail = await doUpload(page, { fixture: "png" }, handle, { _id: "t2" });
      assert.match(detail, /Uploaded sample\.png/);
      const name = await page.$eval("#hiddenFile", (el) => el.files[0]?.name);
      assert.equal(name, "sample.png", "the hidden input received the file via the chooser");
    } finally {
      await page.close();
    }
  });

  test("expectDownload captures the file, saves it, returns an artifact", async (t) => {
    if (!browser) return t.skip("no browser");
    const page = await browser.newPage();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zb-dl-"));
    const artifactScope = { dir: tmpDir, publicUrlBase: "/artifacts/run/attempt-1" };
    try {
      // Downloads require accept_downloads (default true) on the context; newPage
      // uses the default context which allows it.
      await page.setContent(HTML);
      const handle = await page.$("#dl");
      const r = await doExpectDownload(page, { expectFilename: "*.csv" }, handle, artifactScope);
      assert.match(r.detail, /Downloaded report\.csv \(\d+ bytes\)/);
      assert.equal(r.artifact.kind, "file");
      assert.match(r.artifact.label, /Download: report\.csv/);
      assert.ok(r.artifact.url.endsWith("/downloads/report.csv"));
      // File actually saved, non-zero.
      const saved = path.join(tmpDir, "downloads", "report.csv");
      const stat = await fs.stat(saved);
      assert.ok(stat.size > 0, "saved download is non-empty");
    } finally {
      await page.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("expectDownload fails clearly when the filename doesn't match", async (t) => {
    if (!browser) return t.skip("no browser");
    const page = await browser.newPage();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zb-dl-"));
    const artifactScope = { dir: tmpDir, publicUrlBase: "/artifacts/run/attempt-1" };
    try {
      await page.setContent(HTML);
      const handle = await page.$("#dl");
      await assert.rejects(
        () => doExpectDownload(page, { expectFilename: "*.pdf" }, handle, artifactScope),
        /expected the filename to match "\*\.pdf"/,
      );
    } finally {
      await page.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("expectDownload times out clearly when no download starts", async (t) => {
    if (!browser) return t.skip("no browser");
    const page = await browser.newPage();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zb-dl-"));
    const artifactScope = { dir: tmpDir, publicUrlBase: "/x" };
    // Shrink the download wait so this negative case is fast (config is read at
    // call time, so overriding the live value works).
    const orig = config.downloadTimeoutMs;
    config.downloadTimeoutMs = 800;
    try {
      await page.setContent(HTML);
      const handle = await page.$("#noDl"); // clicking this downloads nothing
      await assert.rejects(
        () => doExpectDownload(page, {}, handle, artifactScope),
        /Expected a file download, but none started/,
      );
    } finally {
      config.downloadTimeoutMs = orig;
      await page.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
