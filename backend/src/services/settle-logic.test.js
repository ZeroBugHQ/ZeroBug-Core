import { test } from "node:test";
import assert from "node:assert/strict";
import { settleLoop } from "./playwright-runner.js";

// A deterministic fake clock: `now()` returns virtual ms; `sleep(ms)` advances
// it instantly. This lets us assert exact elapsed budgets without real waiting.
// Injected async "signals" advance the clock by however long they'd really take,
// or hang (advance to the budget they were given) to simulate a stuck sub-wait.
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms) => {
      t += Math.max(0, ms);
      return Promise.resolve();
    },
    advance: (ms) => {
      t += ms;
    },
    get t() {
      return t;
    },
  };
}

test("fast quiescence: proceeds quickly; secondary waits still run but bounded", async () => {
  const clk = fakeClock();
  const calls = [];
  const res = await settleLoop(
    {
      prewait: (budget) => {
        calls.push(["prewait", budget]);
        clk.advance(50); // domcontentloaded resolves fast
      },
      quiescence: (budget) => {
        calls.push(["quiescence", budget]);
        clk.advance(400); // DOM goes quiet after one quiet window
      },
      networkIdle: (budget) => {
        calls.push(["networkIdle", budget]);
        clk.advance(80); // network happens to idle quickly too
      },
      loadersGone: (budget) => {
        calls.push(["loadersGone", budget]);
        clk.advance(30);
      },
    },
    { maxMs: 8000, tailMs: 150, now: clk.now, sleep: clk.sleep },
  );

  // primary ran, elapsed ~= 50+400+ (max secondary 80) + tail 150 = 680
  assert.equal(calls[0][0], "prewait");
  assert.equal(calls[1][0], "quiescence");
  assert.ok(res.elapsedMs <= 8000 + 150, `elapsed ${res.elapsedMs} within ceiling+tail`);
  assert.ok(res.elapsedMs < 1000, `fast path stayed well under ceiling (${res.elapsedMs}ms)`);
});

test("never-idle polling app: networkIdle never resolves, still proceeds under ceiling", async () => {
  const clk = fakeClock();
  let proceeded = false;
  const res = await settleLoop(
    {
      prewait: () => clk.advance(50),
      quiescence: () => clk.advance(400), // DOM DOES stabilize
      // networkIdle simulates an app that polls forever: it runs until its
      // budget-bounded timeout, then rejects (Playwright throws TimeoutError).
      // A faithful signal never advances past the budget it was handed.
      networkIdle: (budget) => {
        clk.advance(Math.min(budget, 1500)); // real waiter caps at SETTLE_NETWORKIDLE_MS
        return Promise.reject(new Error("networkidle timeout"));
      },
      loadersGone: () => clk.advance(20),
    },
    { maxMs: 8000, tailMs: 150, now: clk.now, sleep: clk.sleep },
  );
  proceeded = true;
  assert.ok(proceeded, "returned instead of hanging on never-idle network");
  assert.ok(res.elapsedMs <= 8000 + 150, `elapsed ${res.elapsedMs} bounded by ceiling+tail`);
});

test("everything hangs: hard ceiling enforced (elapsed <= maxMs + tail)", async () => {
  const clk = fakeClock();
  const maxMs = 8000;
  const res = await settleLoop(
    {
      // Each hung sub-wait runs until its budget-bounded timeout (mirroring the
      // real settle() caps: prewait 4000, quiescence full budget, net/loaders
      // 1500). None ever advances past the budget it was handed.
      prewait: (budget) => {
        clk.advance(Math.min(budget, 4000));
      },
      quiescence: (budget) => {
        clk.advance(budget); // DOM never quiesces → runs to the ceiling
      },
      networkIdle: (budget) => {
        clk.advance(Math.min(budget, 1500));
      },
      loadersGone: (budget) => {
        clk.advance(Math.min(budget, 1500));
      },
    },
    { maxMs, tailMs: 150, now: clk.now, sleep: clk.sleep },
  );
  // quiescence alone exhausts the budget here; secondary phase sees 0 budget and
  // is skipped. Total must not exceed maxMs + tail.
  assert.ok(
    res.elapsedMs <= maxMs + 150,
    `elapsed ${res.elapsedMs} must not exceed ceiling ${maxMs}+tail`,
  );
  assert.ok(res.elapsedMs >= maxMs, `hung page ran to the ceiling (${res.elapsedMs})`);
});

test("no secondary signals: primary still runs, no crash", async () => {
  const clk = fakeClock();
  let ran = false;
  const res = await settleLoop(
    {
      quiescence: () => {
        ran = true;
        clk.advance(400);
      },
      // no networkIdle / loadersGone / prewait
    },
    { maxMs: 8000, tailMs: 0, now: clk.now, sleep: clk.sleep },
  );
  assert.ok(ran, "quiescence (primary) ran even with no secondary signals");
  assert.equal(res.elapsedMs, 400);
});

test("secondary rejection is swallowed (non-fatal)", async () => {
  const clk = fakeClock();
  await assert.doesNotReject(async () => {
    await settleLoop(
      {
        quiescence: () => clk.advance(400),
        networkIdle: () => Promise.reject(new Error("boom")),
        loadersGone: () => Promise.reject(new Error("boom2")),
      },
      { maxMs: 8000, tailMs: 0, now: clk.now, sleep: clk.sleep },
    );
  }, "secondary signal rejections must not propagate");
});

test("primary rejection is also swallowed (non-fatal)", async () => {
  const clk = fakeClock();
  await assert.doesNotReject(async () => {
    await settleLoop(
      {
        quiescence: () => Promise.reject(new Error("quiescence eval failed")),
        networkIdle: () => clk.advance(50),
      },
      { maxMs: 8000, tailMs: 0, now: clk.now, sleep: clk.sleep },
    );
  }, "primary signal rejection must not propagate");
});
