// Unit tests for the mockRequest/expectRequest URL matcher. Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchUrlGlob } from "./playwright-runner.js";

test("no pattern matches anything", () => {
  assert.equal(matchUrlGlob("https://x/api/orders", ""), true);
  assert.equal(matchUrlGlob("https://x/api/orders", undefined), true);
});

test("plain substring when no glob metacharacters", () => {
  assert.equal(matchUrlGlob("https://acme.io/api/orders", "/api/orders"), true);
  assert.equal(matchUrlGlob("https://acme.io/api/orders", "/api/users"), false);
  assert.equal(matchUrlGlob("https://ACME.io/API/Orders", "/api/orders"), true, "case-insensitive");
});

test("** matches across path separators", () => {
  assert.equal(matchUrlGlob("https://acme.io/api/orders", "**/api/orders"), true);
  assert.equal(matchUrlGlob("https://acme.io/v2/api/orders", "**/api/orders"), true);
  assert.equal(matchUrlGlob("https://acme.io/api/orders/history", "**/api/orders"), false, "anchored to end");
});

test("* glob", () => {
  assert.equal(matchUrlGlob("https://acme.io/api/orders", "https://acme.io/api/*"), true);
  assert.equal(matchUrlGlob("https://acme.io/api/orders", "*://acme.io/**"), true);
});

test("? matches a single char", () => {
  assert.equal(matchUrlGlob("https://acme.io/api/v1", "**/api/v?"), true);
  assert.equal(matchUrlGlob("https://acme.io/api/v12", "**/api/v?"), false);
});

test("precision: /api/orders vs /api/orders/history", () => {
  // The example from the audit — a glob can distinguish these; substring can't.
  assert.equal(matchUrlGlob("https://x/api/orders", "**/api/orders"), true);
  assert.equal(matchUrlGlob("https://x/api/orders/history", "**/api/orders"), false);
});

test("dots in the pattern are literal, not regex wildcards", () => {
  assert.equal(matchUrlGlob("https://acmeXio/api", "https://acme.io/*"), false);
  assert.equal(matchUrlGlob("https://acme.io/api", "https://acme.io/*"), true);
});
