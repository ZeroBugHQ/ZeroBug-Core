// Unit tests for the pure site-memory logic. Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROBATION_CONFIDENCE,
  PRUNE_FLOOR,
  MAX_HINTS,
  originOf,
  pathOf,
  lessonKey,
  updateConfidence,
  corroborate,
  shouldPrune,
  rankHints,
  formatHints,
  categorizeFailure,
  mineLessons,
  parseJsonSafe,
} from "./memory-logic.js";

test("originOf extracts scheme://host and strips path/query", () => {
  assert.equal(originOf("https://app.example.com/dash?x=1"), "https://app.example.com");
  assert.equal(originOf("http://localhost:3000/a/b"), "http://localhost:3000");
  assert.equal(originOf(""), "");
  assert.equal(originOf("not a url"), "");
});

test("pathOf returns the pathname, or / when unparseable", () => {
  assert.equal(pathOf("https://x.com/a/b?q=1"), "/a/b");
  assert.equal(pathOf("garbage"), "/");
});

test("lessonKey is stable across whitespace/quote/case differences", () => {
  const a = lessonKey({ origin: "https://x.com", kind: "popup", lesson: 'Dismiss the "banner".' });
  const b = lessonKey({ origin: "https://x.com", kind: "popup", lesson: "dismiss  the banner." });
  assert.equal(a, b);
});

test("updateConfidence moves toward 1 on pass and toward 0 on fail, staying in [0,1]", () => {
  const up = updateConfidence(0.3, true);
  assert.ok(up > 0.3 && up < 1);
  const down = updateConfidence(0.3, false);
  assert.ok(down < 0.3 && down >= 0);
  // Bounds hold at the extremes.
  assert.equal(updateConfidence(1, true) <= 1, true);
  assert.equal(updateConfidence(0, false) >= 0, true);
});

test("repeated passes converge upward; repeated fails converge downward", () => {
  let c = PROBATION_CONFIDENCE;
  for (let i = 0; i < 8; i++) c = updateConfidence(c, true);
  assert.ok(c > 0.8, `expected high confidence, got ${c}`);
  let d = 0.8;
  for (let i = 0; i < 5; i++) d = updateConfidence(d, false);
  assert.ok(d < PRUNE_FLOOR, `expected below floor, got ${d}`);
});

test("corroborate nudges up but never exceeds 1", () => {
  assert.ok(corroborate(0.3) > 0.3);
  assert.ok(corroborate(1) <= 1);
});

test("shouldPrune only fires below the floor AND after enough uses", () => {
  assert.equal(shouldPrune({ confidence: 0.05, uses: 3 }), true);
  assert.equal(shouldPrune({ confidence: 0.05, uses: 2 }), false); // not enough uses yet
  assert.equal(shouldPrune({ confidence: 0.5, uses: 10 }), false); // confidence fine
});

test("rankHints sorts by confidence then uses, drops pruned, and caps the count", () => {
  const lessons = [
    { lesson: "a", confidence: 0.2, uses: 1, status: "active" },
    { lesson: "b", confidence: 0.9, uses: 5, status: "active" },
    { lesson: "c", confidence: 0.9, uses: 9, status: "active" },
    { lesson: "d", confidence: 0.99, uses: 1, status: "pruned" },
  ];
  const ranked = rankHints(lessons);
  assert.equal(ranked[0].lesson, "c"); // 0.9 conf, more uses than b
  assert.equal(ranked[1].lesson, "b");
  assert.equal(ranked[2].lesson, "a");
  assert.equal(
    ranked.find((l) => l.lesson === "d"),
    undefined,
  ); // pruned excluded
  const many = Array.from({ length: MAX_HINTS + 3 }, (_, i) => ({
    lesson: `x${i}`,
    confidence: 0.5,
    uses: 1,
    status: "active",
  }));
  assert.equal(rankHints(many).length, MAX_HINTS);
});

test("formatHints returns empty for no lessons and a labeled block otherwise", () => {
  assert.equal(formatHints([]), "");
  const text = formatHints([
    { kind: "popup", lesson: "Dismiss the cookie banner.", confidence: 0.8, status: "active" },
    { kind: "login", lesson: "Log in first.", confidence: PROBATION_CONFIDENCE, status: "active" },
  ]);
  assert.match(text, /LESSONS FROM PAST RUNS/);
  assert.match(text, /\[popup\] Dismiss the cookie banner\./);
  assert.match(text, /\(unproven\)/); // the probation-confidence one is tagged
});

test("categorizeFailure maps stuck/timeout, skips internal-model noise", () => {
  assert.match(
    categorizeFailure(
      "Agent got stuck: repeated actions with no progress after several recovery attempts.",
    ),
    /stuck in an action loop/i,
  );
  assert.match(categorizeFailure("Timeout 30000ms exceeded"), /slow to load/i);
  assert.equal(categorizeFailure("Agent could not get a valid decision after 4 tries"), null);
  assert.equal(categorizeFailure("Stopped by user."), null);
  assert.equal(categorizeFailure(""), null);
});

test("mineLessons derives popup, login, failure and network lessons", () => {
  const origin = "https://app.example.com";
  const run = {
    status: "failed",
    failureReason:
      "Agent got stuck: repeated actions with no progress after several recovery attempts.",
    forensics: {
      network: [
        { url: "https://app.example.com/api/leads", method: "GET", status: 500 },
        { url: "https://other.com/x", status: 500 }, // cross-origin → ignored
      ],
    },
  };
  const observations = { dialogHeadings: ["Cookie consent", "Cookie consent"], sawLoginForm: true };
  const lessons = mineLessons({ run, observations, origin });
  const kinds = lessons.map((l) => l.kind);

  assert.ok(kinds.includes("popup"));
  assert.ok(kinds.includes("failure"));
  assert.ok(kinds.includes("note")); // the 500 on the same origin
  // Login lesson is only learned on a PASS, so a failed run shouldn't produce it.
  assert.ok(!kinds.includes("login"));
  // Duplicate popup heading collapses to one.
  assert.equal(lessons.filter((l) => l.kind === "popup").length, 1);
  // Cross-origin network failure is excluded.
  assert.ok(!lessons.some((l) => l.lesson.includes("other.com")));
  // Every lesson carries the origin.
  assert.ok(lessons.every((l) => l.origin === origin));
});

test("mineLessons learns the login lesson only when the run passed", () => {
  const passed = mineLessons({
    run: { status: "passed" },
    observations: { sawLoginForm: true, dialogHeadings: [] },
    origin: "https://x.com",
  });
  assert.ok(passed.some((l) => l.kind === "login"));
});

test("parseJsonSafe accepts objects, fenced JSON, and embedded JSON; returns null otherwise", () => {
  assert.deepEqual(parseJsonSafe({ lessons: ["a"] }), { lessons: ["a"] });
  assert.deepEqual(parseJsonSafe('```json\n{"lessons":["a"]}\n```'), { lessons: ["a"] });
  assert.deepEqual(parseJsonSafe('here you go: {"lessons":[]} thanks'), { lessons: [] });
  assert.equal(parseJsonSafe("no json here"), null);
  assert.equal(parseJsonSafe(""), null);
});
