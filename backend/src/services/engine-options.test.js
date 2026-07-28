// Unit tests for engine resolution + per-engine viewport options. Pure, no
// browser. Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { viewportContextOptions, isDegradedMobile } from "./playwright-runner.js";
import { resolveEngine, SUPPORTED_ENGINES, DEFAULT_ENGINE } from "./browser-engines.js";

test("resolveEngine normalizes and defaults to chromium", () => {
  assert.equal(resolveEngine("firefox"), "firefox");
  assert.equal(resolveEngine("WebKit"), "webkit");
  assert.equal(resolveEngine("Chromium"), "chromium");
  assert.equal(resolveEngine(""), DEFAULT_ENGINE);
  assert.equal(resolveEngine(undefined), "chromium");
  assert.equal(resolveEngine("safari"), "chromium", "unknown -> default");
  assert.deepEqual(SUPPORTED_ENGINES, ["chromium", "firefox", "webkit"]);
});

test("desktop viewport is identical across engines", () => {
  const c = viewportContextOptions("desktop", "chromium");
  const f = viewportContextOptions("desktop", "firefox");
  assert.deepEqual(c, f);
  assert.deepEqual(c, { viewport: { width: 1280, height: 720 } });
});

test("chromium/webkit keep the full mobile descriptor (isMobile + touch)", () => {
  for (const engine of ["chromium", "webkit"]) {
    const m = viewportContextOptions("mobile", engine);
    assert.ok(m.viewport, "has a viewport");
    // The Pixel/iPad descriptors carry mobile/touch flags for these engines.
    assert.ok(m.isMobile === true || m.hasTouch === true, `${engine} keeps mobile flags`);
  }
});

test("firefox strips isMobile/hasTouch but keeps the viewport size", () => {
  const m = viewportContextOptions("mobile", "firefox");
  assert.ok(m.viewport, "still has the mobile viewport size");
  assert.equal(m.isMobile, undefined, "isMobile removed for firefox");
  assert.equal(m.hasTouch, undefined, "hasTouch removed for firefox");
  const tab = viewportContextOptions("tablet", "firefox");
  assert.equal(tab.isMobile, undefined);
  assert.equal(tab.hasTouch, undefined);
  assert.ok(tab.viewport, "tablet size preserved");
});

test("isDegradedMobile flags exactly the firefox mobile/tablet cases", () => {
  assert.equal(isDegradedMobile("mobile", "firefox"), true);
  assert.equal(isDegradedMobile("tablet", "firefox"), true);
  assert.equal(isDegradedMobile("desktop", "firefox"), false);
  assert.equal(isDegradedMobile("mobile", "chromium"), false);
  assert.equal(isDegradedMobile("mobile", "webkit"), false);
});
