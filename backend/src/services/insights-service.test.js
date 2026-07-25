// Unit tests for flaky detection + run diff. Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFlaky, classifyDiff } from "./insights-service.js";

test("detectFlaky: needs both a pass and a fail", () => {
  assert.equal(detectFlaky([{ status: "passed" }, { status: "failed" }]).flaky, true);
  assert.equal(detectFlaky([{ status: "passed" }, { status: "passed" }]).flaky, false);
  assert.equal(detectFlaky([{ status: "failed" }, { status: "failed" }]).flaky, false);
  assert.equal(detectFlaky([]).flaky, false);
});

test("detectFlaky: counts passes and fails", () => {
  const f = detectFlaky([
    { status: "passed" },
    { status: "failed" },
    { status: "passed" },
    { status: "running" },
  ]);
  assert.equal(f.passes, 2);
  assert.equal(f.fails, 1);
});

test("classifyDiff: newly failed / passed", () => {
  assert.equal(classifyDiff({ status: "passed" }, { status: "failed" }), "newlyFailed");
  assert.equal(classifyDiff({ status: "failed" }, { status: "passed" }), "newlyPassed");
});

test("classifyDiff: slower only when meaningfully slower", () => {
  assert.equal(
    classifyDiff({ status: "passed", durationMs: 1000 }, { status: "passed", durationMs: 2000 }),
    "slower",
  );
  assert.equal(
    classifyDiff({ status: "passed", durationMs: 1000 }, { status: "passed", durationMs: 1100 }),
    "same",
  );
});

test("classifyDiff: missing runs → null", () => {
  assert.equal(classifyDiff(undefined, { status: "passed" }), null);
  assert.equal(classifyDiff({ status: "passed" }, undefined), null);
});
