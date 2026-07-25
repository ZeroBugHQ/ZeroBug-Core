// Unit tests for the pure stats helpers. Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeOutcomes, topSlowest, topFailing } from "./stats-service.js";

const TESTS = [
  { code: "A-1", title: "Alpha", status: "passed", durationMs: 3000 },
  { code: "A-2", title: "Beta", status: "failed", durationMs: 9000 },
  { code: "A-3", title: "Gamma", status: "passed", durationMs: 1000 },
  { code: "A-4", title: "Delta", status: "queued" },
  { code: "A-5", title: "Eps", status: "running" },
];

test("computeOutcomes tallies statuses, pass rate and avg duration", () => {
  const o = computeOutcomes(TESTS);
  assert.equal(o.passed, 2);
  assert.equal(o.failed, 1);
  assert.equal(o.queued, 1);
  assert.equal(o.running, 1);
  assert.equal(o.total, 5);
  // pass rate is over finished (passed+failed) = 2/3 → 67
  assert.equal(o.passRate, 67);
  // avg over the 3 tests with a duration: (3000+9000+1000)/3 = 4333
  assert.equal(o.avgDurationMs, 4333);
});

test("computeOutcomes handles an empty board without dividing by zero", () => {
  const o = computeOutcomes([]);
  assert.equal(o.total, 0);
  assert.equal(o.passRate, 0);
  assert.equal(o.avgDurationMs, 0);
});

test("topSlowest returns timed tests in descending duration order", () => {
  const slow = topSlowest(TESTS, 2);
  assert.deepEqual(
    slow.map((t) => t.code),
    ["A-2", "A-1"],
  );
  assert.equal(slow[0].durationMs, 9000);
});

test("topFailing maps fail counts to test rows, dropping unknown ids", () => {
  const byId = new Map([
    ["t1", { code: "A-2", title: "Beta" }],
    ["t2", { code: "A-9", title: "Zeta" }],
  ]);
  const rows = topFailing(
    [
      { testId: "t1", fails: 3 },
      { testId: "ghost", fails: 2 },
      { testId: "t2", fails: 1 },
    ],
    byId,
  );
  assert.deepEqual(rows, [
    { code: "A-2", title: "Beta", fails: 3 },
    { code: "A-9", title: "Zeta", fails: 1 },
  ]);
});
