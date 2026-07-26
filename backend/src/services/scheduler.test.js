// Scheduler unit tests: exercise the extracted scheduleQueue() core with an
// injected runOne (no Mongo/Playwright). These specifically cover mid-run queue
// mutations (cancel / clear / reorder) happening WHILE tests are in flight under
// concurrency > 1 -- the behavior the automation API contract depends on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleQueue } from "./background-runner.js";

// Minimal state object matching queue-state's shape (only the fields the
// scheduler touches).
function makeState(ids) {
  return { pendingTestIds: [...ids], activeTestId: null, stopRequested: false };
}
// A controllable fake test executor. Each test id resolves when we release it,
// so we can deterministically hold tests "in flight" while we mutate the queue.
function makeRunner() {
  const gates = new Map(); // id -> { resolve }
  const started = [];
  const runOne = (id) => {
    started.push(id);
    return new Promise((resolve) => {
      gates.set(id, () => resolve("passed"));
    });
  };
  return {
    runOne,
    started,
    release: (id) => {
      const g = gates.get(id);
      if (g) {
        gates.delete(id);
        g();
      }
    },
    releaseAll: () => {
      for (const [, g] of gates) g();
      gates.clear();
    },
    inFlight: () => gates.size,
  };
}
const tests = (codes) => codes.map((c) => ({ _id: c, code: c, dependsOn: [] }));
const byId = (ts) => new Map(ts.map((t) => [String(t._id), t]));
// Poll until `fn()` is truthy (or time out) — avoids racing a fixed sleep
// against the scheduler's dispatch timing.
async function until(fn, timeoutMs = 1000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("until() timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

test("cancel a queued (not-yet-dispatched) test mid-run: it never dispatches", async () => {
  const ts = tests(["A", "B", "C", "D"]);
  const state = makeState(["A", "B", "C", "D"]);
  const r = makeRunner();
  const done = scheduleQueue({
    state,
    testById: byId(ts),
    knownCodes: new Set(["A", "B", "C", "D"]),
    concurrency: 2, // A and B go in flight; C, D still pending
    runOne: r.runOne,
  });
  await until(() => r.started.length === 2);
  assert.deepEqual(r.started, ["A", "B"], "concurrency=2 dispatched exactly A,B");
  assert.ok(state.pendingTestIds.includes("C") && state.pendingTestIds.includes("D"));

  // Cancel C while A,B are still in flight.
  state.pendingTestIds = state.pendingTestIds.filter((id) => id !== "C");

  r.release("A"); // frees a slot -> scheduler should pick D next, skipping cancelled C
  await until(() => r.started.includes("D"));
  r.releaseAll();
  await done;

  assert.ok(!r.started.includes("C"), "cancelled C was never dispatched");
  assert.ok(r.started.includes("D"), "D still ran");
});

test("clear the batch mid-run: remaining pending tests don't dispatch", async () => {
  const ts = tests(["A", "B", "C", "D", "E"]);
  const state = makeState(["A", "B", "C", "D", "E"]);
  const r = makeRunner();
  const done = scheduleQueue({
    state,
    testById: byId(ts),
    knownCodes: new Set(["A", "B", "C", "D", "E"]),
    concurrency: 2,
    runOne: r.runOne,
  });
  await until(() => r.started.length === 2);
  assert.deepEqual(r.started, ["A", "B"]);

  // Clear everything still queued (C, D, E) mid-flight.
  state.pendingTestIds = [];

  r.releaseAll();
  await done;

  assert.deepEqual(r.started, ["A", "B"], "no further tests dispatched after clear");
});

test("reorder mid-run: the new order is honored for subsequent dispatches", async () => {
  const ts = tests(["A", "B", "C", "D"]);
  const state = makeState(["A", "B", "C", "D"]);
  const r = makeRunner();
  const done = scheduleQueue({
    state,
    testById: byId(ts),
    knownCodes: new Set(["A", "B", "C", "D"]),
    concurrency: 1, // strictly one at a time so order is observable
    runOne: r.runOne,
  });
  await until(() => r.started.length === 1);
  assert.deepEqual(r.started, ["A"], "A dispatched first");

  // While A is in flight, reorder the remaining queue to D, C, B.
  state.pendingTestIds = ["D", "C", "B"];

  r.release("A");
  await until(() => r.started.length === 2);
  assert.deepEqual(r.started, ["A", "D"], "after reorder, D (new head) dispatched next");
  r.release("D");
  await until(() => r.started.length === 3);
  assert.deepEqual(r.started, ["A", "D", "C"], "then C");
  r.release("C");
  await until(() => r.started.length === 4);
  r.release("B");
  await done;
  assert.deepEqual(r.started, ["A", "D", "C", "B"], "full reordered order honored");
});

test("dependency blocking still works through the extracted scheduler", async () => {
  // B depends on A; A fails -> B must be blocked, never dispatched.
  const ts = [
    { _id: "A", code: "A", dependsOn: [] },
    { _id: "B", code: "B", dependsOn: ["A"] },
  ];
  const state = makeState(["A", "B"]);
  const blocked = [];
  const runOne = async (id) => (id === "A" ? "failed" : "passed");
  const { completedIds } = await scheduleQueue({
    state,
    testById: byId(ts),
    knownCodes: new Set(["A", "B"]),
    concurrency: 3,
    runOne,
    onBlocked: async (id) => blocked.push(id),
  });
  assert.deepEqual(blocked, ["B"], "B blocked because its dependency A failed");
  assert.ok(completedIds.includes("A") && completedIds.includes("B"));
});
