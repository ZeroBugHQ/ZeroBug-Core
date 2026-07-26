// Unit tests for the expectDownload filename matcher. Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchFilename } from "./playwright-runner.js";

test("no pattern matches anything (filename check is optional)", () => {
  assert.equal(matchFilename("report.pdf", undefined), true);
  assert.equal(matchFilename("report.pdf", ""), true);
});

test("extension glob", () => {
  assert.equal(matchFilename("report.pdf", "*.pdf"), true);
  assert.equal(matchFilename("report.csv", "*.pdf"), false);
  assert.equal(matchFilename("REPORT.PDF", "*.pdf"), true, "case-insensitive");
});

test("prefix + extension glob", () => {
  assert.equal(matchFilename("report-2026.csv", "report-*.csv"), true);
  assert.equal(matchFilename("summary-2026.csv", "report-*.csv"), false);
});

test("substring fallback when no glob star", () => {
  assert.equal(matchFilename("q3-invoice-1234.pdf", "invoice"), true);
  assert.equal(matchFilename("statement.pdf", "invoice"), false);
});

test("dots in the pattern are literal, not regex wildcards", () => {
  // "a.pdf" must NOT match "axpdf" (the dot is escaped for the glob path; for the
  // substring path it's a plain includes()).
  assert.equal(matchFilename("axpdfx", "*a.pdf"), false);
  assert.equal(matchFilename("data.pdf", "*a.pdf"), true);
});
