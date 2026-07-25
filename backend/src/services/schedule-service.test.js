// Unit tests for the cron matcher. Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { cronMatches } from "./schedule-service.js";

test("'* * * * *' matches any time", () => {
  assert.equal(cronMatches("* * * * *", new Date(2026, 5, 15, 9, 30)), true);
});

test("exact minute/hour matches only at that minute", () => {
  assert.equal(cronMatches("30 9 * * *", new Date(2026, 5, 15, 9, 30)), true);
  assert.equal(cronMatches("30 9 * * *", new Date(2026, 5, 15, 9, 31)), false);
  assert.equal(cronMatches("30 9 * * *", new Date(2026, 5, 15, 10, 30)), false);
});

test("day-of-month and month fields", () => {
  assert.equal(cronMatches("0 0 1 * *", new Date(2026, 0, 1, 0, 0)), true);
  assert.equal(cronMatches("0 0 1 * *", new Date(2026, 0, 2, 0, 0)), false);
  // month is 1-based in cron; June = 6
  assert.equal(cronMatches("0 0 1 6 *", new Date(2026, 5, 1, 0, 0)), true);
  assert.equal(cronMatches("0 0 1 7 *", new Date(2026, 5, 1, 0, 0)), false);
});

test("step values: */15 matches quarter hours", () => {
  for (const m of [0, 15, 30, 45]) {
    assert.equal(cronMatches("*/15 * * * *", new Date(2026, 5, 15, 8, m)), true);
  }
  assert.equal(cronMatches("*/15 * * * *", new Date(2026, 5, 15, 8, 7)), false);
});

test("ranges and lists", () => {
  // weekdays 1-5 (Mon–Fri) at 9am
  const d = new Date(2026, 5, 15, 9, 0);
  const wd = d.getDay();
  const inRange = wd >= 1 && wd <= 5;
  assert.equal(cronMatches("0 9 * * 1-5", d), inRange);
  // explicit weekday match is generic regardless of which day this is
  assert.equal(cronMatches(`0 9 * * ${wd}`, d), true);
  // minute list
  assert.equal(cronMatches("0,30 * * * *", new Date(2026, 5, 15, 8, 30)), true);
  assert.equal(cronMatches("0,30 * * * *", new Date(2026, 5, 15, 8, 15)), false);
});

test("malformed expressions never match", () => {
  assert.equal(cronMatches("* * * *", new Date()), false); // 4 fields
  assert.equal(cronMatches("", new Date()), false);
  assert.equal(cronMatches("nonsense", new Date()), false);
});
