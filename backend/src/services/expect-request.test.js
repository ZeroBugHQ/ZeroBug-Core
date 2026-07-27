// Unit tests for the expectRequest matcher. Pure over a requestLog, no browser.
// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { doExpectRequest } from "./playwright-runner.js";

// A representative captured log. `step` is the agent step each request fired on.
const LOG = [
  { url: "https://acme.io/api/session", method: "GET", postData: "", step: 0 },
  { url: "https://acme.io/api/orders", method: "GET", postData: "", step: 1 },
  { url: "https://acme.io/api/orders", method: "POST", postData: '{"item":"sku_42","qty":2}', step: 3 },
  { url: "https://acme.io/api/orders/history", method: "GET", postData: "", step: 4 },
];

test("matches by url glob + method", () => {
  const r = doExpectRequest(LOG, { urlPattern: "**/api/orders", method: "POST" });
  assert.equal(r.ok, true);
  assert.match(r.detail, /Saw POST/);
  assert.equal(r.evidence.matched.step, 3);
});

test("glob precision: **/api/orders does NOT match /api/orders/history", () => {
  // Only the GET(step1) and POST(step3) are exact /api/orders; history is excluded.
  const r = doExpectRequest(LOG, { urlPattern: "**/api/orders", method: "GET" });
  assert.equal(r.ok, true);
  assert.equal(r.evidence.matched.step, 1, "matched the exact /api/orders GET, not history");
});

test("bodyContains matches a substring of the post body", () => {
  const r = doExpectRequest(LOG, { urlPattern: "**/api/orders", method: "POST", bodyContains: "sku_42" });
  assert.equal(r.ok, true);
});

test("bodyContains that isn't present fails, with a helpful message", () => {
  const r = doExpectRequest(LOG, { urlPattern: "**/api/orders", method: "POST", bodyContains: "sku_999" });
  assert.equal(r.ok, false);
  assert.match(r.detail, /Expected a request matching POST \*\*\/api\/orders with body containing "sku_999"/);
  assert.match(r.detail, /Requests observed/);
});

test("no matching url fails and lists what WAS observed", () => {
  const r = doExpectRequest(LOG, { urlPattern: "**/api/checkout" });
  assert.equal(r.ok, false);
  assert.match(r.detail, /Expected a request matching \*\*\/api\/checkout, but none fired/);
  // the observed list should mention real requests to aid debugging
  assert.match(r.detail, /api\/orders/);
});

test("sinceStep EXCLUDES an earlier matching request", () => {
  // There's a GET /api/orders at step 1. Scoped to sinceStep:3, that earlier GET
  // must not satisfy a GET assertion — only requests at/after step 3 count.
  const r = doExpectRequest(LOG, { urlPattern: "**/api/orders", method: "GET", sinceStep: 3 });
  assert.equal(r.ok, false, "the step-1 GET is excluded by sinceStep:3");
  assert.match(r.detail, /since step 3/);
});

test("sinceStep INCLUDES a matching request at/after the step", () => {
  // The POST /api/orders is at step 3; sinceStep:3 is inclusive.
  const r = doExpectRequest(LOG, { urlPattern: "**/api/orders", method: "POST", sinceStep: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.evidence.matched.step, 3);
});

test("empty window reports 'no requests observed since step N'", () => {
  const r = doExpectRequest(LOG, { urlPattern: "**/anything", sinceStep: 99 });
  assert.equal(r.ok, false);
  assert.match(r.detail, /No requests were observed since step 99/);
});

test("missing urlPattern throws", () => {
  assert.throws(() => doExpectRequest(LOG, {}), /needs a "urlPattern"/);
});
