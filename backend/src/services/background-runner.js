import { Test } from "../models/test.model.js";
import { Project } from "../models/project.model.js";
import { executeTestRun } from "./run-service.js";
import { publishProjectEvent } from "./run-bus.js";
import { config } from "../config.js";
import { systemColumn } from "./project-service.js";
import { orderByDependencies } from "./queue-deps.js";
import { evaluateProjectAlerts } from "./alert-service.js";
import { closeGroup } from "./browser-pool.js";
import { queueState } from "./queue-state.js";

const PRIORITY_WEIGHT = { critical: 0, high: 1, medium: 2, low: 3 };

// Stable batch ordering (applied before dependency ordering, which then only
// reorders where a dependency forces it): explicit queueOrder first, then
// priority (critical -> low), then creation time as the final tiebreak. Both the
// interactive and automation paths use this so critical tests run first.
function sortQueueTests(tests) {
  return [...tests].sort((a, b) => {
    const orderDiff = (a.queueOrder ?? 0) - (b.queueOrder ?? 0);
    if (orderDiff !== 0) return orderDiff;
    const priorityDiff = (PRIORITY_WEIGHT[a.priority] ?? 9) - (PRIORITY_WEIGHT[b.priority] ?? 9);
    if (priorityDiff !== 0) return priorityDiff;
    return String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""));
  });
}

// Dependency readiness for the parallel scheduler:
//   "ready"   — all in-set deps have passed
//   "wait"    — some dep is still pending/running
//   "blocked" — a dep has failed (this test can never satisfy its deps)
function depsState(test, passedCodes, failedCodes, knownCodes) {
  let waiting = false;
  for (const dep of test.dependsOn ?? []) {
    if (!knownCodes.has(dep)) continue;
    if (failedCodes.has(dep)) return "blocked";
    if (!passedCodes.has(dep)) waiting = true;
  }
  return waiting ? "wait" : "ready";
}

/**
 * The core dependency-aware, bounded-concurrency scheduling loop, extracted so
 * it can be unit-tested independently of Mongo/Playwright. It works entirely off
 * `state.pendingTestIds` (the LIVE queue), re-reading it every cycle so mid-run
 * cancel/clear/reorder mutations are honored on the next dispatch.
 *
 * Injected callbacks (all async-capable):
 *   runOne(id, test)   -> resolves "passed" | "failed" (or throws => treated failed)
 *   onBlocked(id, test, reason)
 *   onProgress(id)     -> e.g. emit queue_progress
 *   waitPause()        -> resolves true to continue, false to abort (pause gate)
 *   tick()             -> optional: resolves when at least one in-flight settles
 *                         (defaults to Promise.race on the internal set)
 * Returns { ranIds, completedIds }.
 */
export async function scheduleQueue({
  state,
  testById,
  knownCodes,
  concurrency,
  runOne,
  onBlocked = async () => {},
  onProgress = () => {},
  waitPause = null,
}) {
  const passedCodes = new Set();
  const failedCodes = new Set();
  const ranIds = [];
  const completedIds = [];
  const inFlight = new Set();

  const removePending = (id) => {
    state.pendingTestIds = state.pendingTestIds.filter((x) => x !== id);
  };

  const dispatch = (id, test) => {
    state.activeTestId = id;
    removePending(id);
    onProgress(id);
    const p = (async () => {
      try {
        const status = await runOne(id, test);
        ranIds.push(id);
        completedIds.push(id);
        if (status === "passed") passedCodes.add(test.code);
        else failedCodes.add(test.code);
      } catch {
        failedCodes.add(test.code);
        completedIds.push(id);
      }
    })();
    p.finally(() => inFlight.delete(p));
    inFlight.add(p);
  };

  while (true) {
    if (state.stopRequested) break;

    if (waitPause) {
      const ok = await waitPause();
      if (!ok) break;
    }

    let madeProgress = false;
    const order = [...state.pendingTestIds];
    for (const id of order) {
      if (inFlight.size >= concurrency) break;
      if (!state.pendingTestIds.includes(id)) continue; // cancelled since snapshot
      const test = testById.get(id);
      if (!test) {
        removePending(id);
        continue;
      }
      const ds = depsState(test, passedCodes, failedCodes, knownCodes);
      if (ds === "ready") {
        dispatch(id, test);
        madeProgress = true;
      } else if (ds === "blocked") {
        removePending(id);
        const unmet = (test.dependsOn || []).filter((c) => failedCodes.has(c));
        await onBlocked(id, test, `Blocked: depends on ${unmet.join(", ")} (did not pass)`);
        failedCodes.add(test.code);
        completedIds.push(id);
        madeProgress = true;
      }
      // ds === "wait": leave it, retry next cycle.
    }

    if (inFlight.size === 0) {
      if (state.pendingTestIds.length > 0 && !madeProgress) {
        for (const id of [...state.pendingTestIds]) {
          const test = testById.get(id);
          removePending(id);
          if (!test) continue;
          await onBlocked(id, test, "Blocked: a dependency did not run or pass.");
          completedIds.push(id);
        }
      }
      if (state.pendingTestIds.length === 0) break;
      continue;
    }

    await Promise.race([...inFlight]);
  }

  await Promise.allSettled([...inFlight]);
  return { ranIds, completedIds };
}

// Mark a test as "blocked" because a dependency didn't pass. The test never ran,
// so it's excluded from pass-rate math (see stats-service). It shares the "failed"
// board column (no separate Blocked column) but carries a distinct status so the
// UI can render it apart from a real failure.
async function markBlocked(projectId, test, reason, publish) {
  const col = await systemColumn(projectId, "failed");
  await Test.findByIdAndUpdate(test._id, {
    status: "blocked",
    failureReason: reason,
    ...(col ? { columnId: col._id } : {}),
    $unset: { durationMs: "" },
  });
  publish(projectId, test._id, { type: "status", status: "blocked" });
  publish(projectId, test._id, { type: "result", status: "blocked", failureReason: reason });
}

// ── Pause gate (automation only) ─────────────────────────────────────────────
async function currentProjectQueuePaused(projectId) {
  const project = await Project.findById(projectId).select("queuePaused").lean();
  return !!project?.queuePaused;
}

async function waitForUnpause(projectId, state) {
  while (await currentProjectQueuePaused(projectId)) {
    if (state.stopRequested) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return true;
}

// ── Automation completion: summary + webhook callback ────────────────────────
async function postCallback(callbackUrl, payload) {
  if (!callbackUrl) return;
  try {
    await fetch(callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[queue] callback failed:", err.message);
  }
}

// Build the automation summary from FINAL PERSISTED test statuses (not in-loop
// counters) so the pass/fail/blocked tallies are correct under concurrency.
async function buildQueueSummary(projectId, source, startedAt, completedTestIds = []) {
  const [project, tests] = await Promise.all([
    Project.findById(projectId).select("name webhookCallbackUrl").lean(),
    Test.find({ projectId }).sort({ queueOrder: 1, createdAt: 1 }).lean(),
  ]);
  const done = tests.filter((t) => completedTestIds.includes(String(t._id)));
  return {
    projectId: String(projectId),
    projectName: project?.name ?? "Project",
    source,
    startedAt,
    finishedAt: new Date().toISOString(),
    totals: {
      queued: tests.filter((t) => t.status === "queued").length,
      running: tests.filter((t) => t.status === "running").length,
      passed: tests.filter((t) => t.status === "passed").length,
      failed: tests.filter((t) => t.status === "failed").length,
      blocked: tests.filter((t) => t.status === "blocked").length,
    },
    finished: done.map((t) => ({
      id: String(t._id),
      code: t.code,
      title: t.title,
      status: t.status,
      durationMs: t.durationMs,
      failureReason: t.failureReason,
      attempts: t.lastRunAttempts ?? 1,
    })),
  };
}

// The default per-test executor: runs the agent via Playwright, reusing a
// pooled per-category browser context. Returns "passed" | "failed" for the
// scheduler's dependency tracking. Tests inject a lightweight stand-in instead.
async function defaultRunTest({ id, environmentId, signal, onEvent, source, maxRetries, engine }) {
  const { result } = await executeTestRun({
    testId: id,
    environmentId,
    signal,
    onEvent,
    pooled: true,
    source,
    maxRetries,
    engine,
  });
  return result?.status === "passed" ? "passed" : "failed";
}

function publishRunEvent(projectId, testId, event) {
  if (!event || typeof event !== "object") {
    publishProjectEvent(projectId, event);
    return;
  }
  publishProjectEvent(projectId, {
    ...(testId && !("testId" in event) ? { testId: String(testId) } : {}),
    ...event,
  });
}

export function getProjectRunState(projectId) {
  const state = queueState(projectId);
  return state.running
    ? {
        running: state.running,
        kind: state.kind,
        activeTestId: state.activeTestId,
      }
    : { running: false, kind: null, activeTestId: null };
}

export async function startBackgroundSingleRun({ testId, environmentId }) {
  const test = await Test.findById(testId).lean();
  if (!test) throw new Error("Test not found");

  const state = queueState(test.projectId);
  if (state.running) throw new Error("A run is already in progress for this project.");

  state.running = true;
  state.kind = "single";
  state.stopRequested = false;
  state.activeTestId = String(test._id);
  state.controller = new AbortController();

  publishProjectEvent(test.projectId, {
    type: "queue_started",
    projectId: String(test.projectId),
    kind: "single",
    total: 1,
    testId: String(test._id),
  });

  void (async () => {
    try {
      await executeTestRun({
        testId: String(test._id),
        environmentId,
        signal: state.controller.signal,
        onEvent: (event) => publishRunEvent(test.projectId, test._id, event),
        source: "interactive",
      });
      publishProjectEvent(test.projectId, {
        type: "queue_complete",
        projectId: String(test.projectId),
        kind: "single",
        stopped: state.stopRequested,
      });
    } catch (err) {
      publishProjectEvent(test.projectId, { type: "error", message: err.message });
      publishProjectEvent(test.projectId, {
        type: "queue_complete",
        projectId: String(test.projectId),
        kind: "single",
        stopped: false,
      });
    } finally {
      state.running = false;
      state.kind = null;
      state.stopRequested = false;
      state.activeTestId = null;
      state.controller = null;
    }
  })();

  return { ok: true };
}

/**
 * The single canonical batch engine. Runs a project's queued tests with a
 * dependency-aware, bounded-concurrency scheduler. Both the interactive
 * "Run all" and the automation/webhook/schedule path go through here.
 *
 * opts:
 *   projectId, environmentId
 *   mode?      — filter to a test mode (interactive "Run all" uses this)
 *   suite?     — filter to a suite (automation uses this)
 *   source     — recorded on each run ("interactive" | "queue" | "schedule" | …)
 *   concurrency, maxRetries?
 *   pause?     — honor the project's queuePaused flag between dispatches (automation)
 *   callbackUrl?, buildSummary? — automation completion callback + summary
 *   onEvent?   — extra event sink (automation SSE route); events ALSO always go
 *                to the SSE project bus, so summary/callback never depend on a
 *                consumer being attached.
 *
 * Returns (when awaited) the run outcome; for automation, the summary object.
 */
export async function runProjectBatch({
  projectId,
  environmentId,
  mode,
  suite,
  source,
  concurrency = config.runConcurrency,
  maxRetries,
  engine,
  pause = false,
  callbackUrl,
  buildSummary = false,
  onEvent,
  // Testing seam: the per-test executor. Defaults to the real Playwright-backed
  // executeTestRun; injected by tests to exercise the scheduler/engine without a
  // browser or Ollama. When omitted (every real call site), behavior is
  // identical to before this parameter existed.
  runTest = defaultRunTest,
}) {
  const state = queueState(projectId);
  if (state.running) {
    const err = new Error("A run is already in progress for this project.");
    err.code = "QUEUE_RUNNING";
    throw err;
  }

  const found = await Test.find({
    projectId,
    status: "queued",
    ...(mode ? { mode } : {}),
    ...(suite ? { suite } : {}),
  }).lean();
  if (!found.length) throw new Error("No queued tests to run.");

  // Priority-aware ordering, then dependency ordering (deps only reorder where
  // a dependency forces it).
  const queued = orderByDependencies(sortQueueTests(found));
  const knownCodes = new Set(queued.map((t) => t.code));
  const ranTestIds = [];
  const completedTestIds = [];
  // Resolve IDs -> test objects. The scheduler works off state.pendingTestIds
  // (the LIVE queue, shared via queue-state) so mid-run cancel/clear/reorder
  // from the automation API take effect on the next dispatch cycle.
  const testById = new Map(queued.map((t) => [String(t._id), t]));

  state.running = true;
  state.kind = "all";
  state.stopRequested = false;
  state.activeTestId = null;
  state.controller = new AbortController();
  state.pendingTestIds = queued.map((t) => String(t._id));
  state.lastSource = source ?? null;
  state.lastStartedAt = new Date().toISOString();
  state.lastFinishedAt = null;
  state.lastSummary = null;

  // Emit to the SSE project bus AND (if supplied) the caller's sink.
  const emit = (event) => {
    publishProjectEvent(projectId, event);
    if (onEvent) onEvent(event);
  };
  const emitRun = (testId, event) => {
    const withId =
      event && typeof event === "object" && testId && !("testId" in event)
        ? { ...event, testId: String(testId) }
        : event;
    publishProjectEvent(projectId, withId);
    if (onEvent) onEvent(withId);
  };

  emit({
    type: "queue_started",
    projectId: String(projectId),
    kind: "all",
    total: queued.length,
    mode: mode || null,
    suite: suite || null,
    source: source || null,
  });

  const run = (async () => {
    try {
      // Per-test executor. Delegates to the injected `runTest` (the real
      // Playwright-backed executor by default), passing everything it needs;
      // returns the run status for the scheduler's dep tracking.
      const runOne = async (id, test) =>
        runTest({
          id,
          test,
          environmentId,
          signal: state.controller.signal,
          onEvent: (event) => emitRun(test._id, event),
          source,
          maxRetries,
          engine,
        });

      const { ranIds, completedIds } = await scheduleQueue({
        state,
        testById,
        knownCodes,
        concurrency,
        runOne,
        onProgress: (id) =>
          emit({ type: "queue_progress", projectId: String(projectId), testId: id }),
        onBlocked: (id, test, reason) => markBlocked(projectId, test, reason, emitRun),
        waitPause: pause ? () => waitForUnpause(projectId, state) : null,
      });
      ranTestIds.push(...ranIds);
      completedTestIds.push(...completedIds);

      await evaluateProjectAlerts(projectId, ranTestIds);
      emit({
        type: "queue_complete",
        projectId: String(projectId),
        kind: "all",
        stopped: state.stopRequested,
      });
    } catch (err) {
      emit({ type: "error", message: err.message });
      emit({
        type: "queue_complete",
        projectId: String(projectId),
        kind: "all",
        stopped: false,
      });
    } finally {
      // Tear down all live category browser contexts opened during this batch.
      // Runs for every path (interactive AND headless automation with no SSE
      // consumer) so pooled contexts never leak.
      await closeGroup(projectId).catch(() => {});
      state.lastFinishedAt = new Date().toISOString();
      state.running = false;
      state.kind = null;
      state.stopRequested = false;
      state.activeTestId = null;
      state.controller = null;
    }
  })();

  // Automation callers await the summary; the interactive path fires-and-forgets.
  if (buildSummary || callbackUrl) {
    await run;
    const stopped = false; // stop sets state.stopRequested; summary reads DB regardless
    const summary = await buildQueueSummary(projectId, source, state.lastStartedAt, completedTestIds);
    summary.stopped = state.lastSummary?.stopped ?? stopped;
    state.lastSummary = summary;
    await postCallback(callbackUrl, summary);
    return summary;
  }

  void run;
  return { ok: true, total: queued.length };
}

// Interactive "Run all": fire-and-forget, priority + dependency ordering, pooled.
export async function startBackgroundQueuedRuns({ projectId, environmentId, mode, runTest }) {
  return runProjectBatch({
    projectId,
    environmentId,
    mode,
    source: "interactive",
    concurrency: config.runConcurrency,
    ...(runTest ? { runTest } : {}),
  });
}

export function stopBackgroundRuns(projectId) {
  const state = queueState(projectId);
  if (!state.running) return { ok: false };
  state.stopRequested = true;
  state.controller?.abort();
  publishProjectEvent(projectId, {
    type: "queue_stopping",
    projectId: String(projectId),
    activeTestId: state.activeTestId,
  });
  return { ok: true };
}

export { waitForUnpause, buildQueueSummary, postCallback };
