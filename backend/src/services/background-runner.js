import { Test } from "../models/test.model.js";
import { executeTestRun } from "./run-service.js";
import { publishProjectEvent } from "./run-bus.js";
import { config } from "../config.js";
import { systemColumn } from "./project-service.js";
import { orderByDependencies } from "./queue-deps.js";
import { evaluateProjectAlerts } from "./alert-service.js";
import { closeGroup } from "./browser-pool.js";

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

// Mark a test as blocked (skipped) because a dependency hasn't passed.
async function markBlocked(projectId, test, reason, publish) {
  const col = await systemColumn(projectId, "failed");
  await Test.findByIdAndUpdate(test._id, {
    status: "failed",
    failureReason: reason,
    ...(col ? { columnId: col._id } : {}),
    $unset: { durationMs: "" },
  });
  publish(projectId, test._id, { type: "status", status: "failed" });
  publish(projectId, test._id, { type: "result", status: "failed", failureReason: reason });
}

const projectQueues = new Map();

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

function queueState(projectId) {
  const key = String(projectId);
  let state = projectQueues.get(key);
  if (!state) {
    state = {
      projectId: key,
      kind: null,
      running: false,
      stopRequested: false,
      controller: null,
      activeTestId: null,
    };
    projectQueues.set(key, state);
  }
  return state;
}

export function getProjectRunState(projectId) {
  const state = projectQueues.get(String(projectId));
  return state
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
      });
      publishProjectEvent(test.projectId, {
        type: "queue_complete",
        projectId: String(test.projectId),
        kind: "single",
        stopped: state.stopRequested,
      });
    } catch (err) {
      publishProjectEvent(test.projectId, {
        type: "error",
        message: err.message,
      });
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

export async function startBackgroundQueuedRuns({ projectId, environmentId, mode }) {
  const state = queueState(projectId);
  if (state.running) throw new Error("A run is already in progress for this project.");

  const filter = { projectId, status: "queued", ...(mode ? { mode } : {}) };
  const found = await Test.find(filter)
    .sort({ queueOrder: 1, createdAt: 1 })
    .lean();
  if (!found.length) throw new Error("No queued tests to run.");
  // Run dependencies before their dependents.
  const queued = orderByDependencies(found);
  const knownCodes = new Set(queued.map((t) => t.code));
  const passedCodes = new Set();
  const ranTestIds = [];

  state.running = true;
  state.kind = "all";
  state.stopRequested = false;
  state.activeTestId = null;
  state.controller = new AbortController();

  publishProjectEvent(projectId, {
    type: "queue_started",
    projectId: String(projectId),
    kind: "all",
    total: queued.length,
    mode: mode || null,
  });

  void (async () => {
    try {
      const concurrency = config.runConcurrency;
      const failedCodes = new Set();
      const pending = [...queued];
      const inFlight = new Set();

      const dispatch = (test) => {
        const id = String(test._id);
        state.activeTestId = id;
        publishProjectEvent(projectId, {
          type: "queue_progress",
          projectId: String(projectId),
          testId: id,
        });
        const p = (async () => {
          try {
            const { result } = await executeTestRun({
              testId: id,
              environmentId,
              signal: state.controller.signal,
              onEvent: (event) => publishRunEvent(projectId, test._id, event),
              // Reuse one live browser context per category across the queue.
              pooled: true,
            });
            ranTestIds.push(id);
            if (result?.status === "passed") passedCodes.add(test.code);
            else failedCodes.add(test.code);
          } catch (err) {
            failedCodes.add(test.code);
            publishProjectEvent(projectId, { type: "error", message: err.message });
          }
        })();
        p.finally(() => inFlight.delete(p));
        inFlight.add(p);
      };

      // Schedule: keep up to `concurrency` ready tests in flight, respecting deps.
      while (true) {
        if (state.stopRequested) break;

        // Fill free slots with dependency-ready tests; remove blocked ones.
        let madeProgress = false;
        for (let i = 0; i < pending.length && inFlight.size < concurrency; ) {
          const ds = depsState(pending[i], passedCodes, failedCodes, knownCodes);
          if (ds === "ready") {
            dispatch(pending.splice(i, 1)[0]);
            madeProgress = true;
          } else if (ds === "blocked") {
            const test = pending.splice(i, 1)[0];
            const unmet = (test.dependsOn || []).filter((c) => failedCodes.has(c));
            await markBlocked(
              projectId,
              test,
              `Blocked: depends on ${unmet.join(", ")} (did not pass)`,
              publishRunEvent,
            );
            failedCodes.add(test.code);
            madeProgress = true;
          } else {
            i += 1; // waiting on an in-flight dep
          }
        }

        if (inFlight.size === 0) {
          // Nothing running. Anything left is waiting on deps that will never
          // resolve (not run / cyclic) — block it and finish.
          if (pending.length > 0 && !madeProgress) {
            for (const test of pending.splice(0)) {
              await markBlocked(
                projectId,
                test,
                "Blocked: a dependency did not run or pass.",
                publishRunEvent,
              );
            }
          }
          if (pending.length === 0) break;
          continue;
        }

        // Wait for at least one in-flight run to settle, then re-evaluate.
        await Promise.race([...inFlight]);
      }

      // Let any still-running tests finish (e.g. after a stop request aborts them).
      await Promise.allSettled([...inFlight]);
      await evaluateProjectAlerts(projectId, ranTestIds);
      publishProjectEvent(projectId, {
        type: "queue_complete",
        projectId: String(projectId),
        kind: "all",
        stopped: state.stopRequested,
      });
    } catch (err) {
      publishProjectEvent(projectId, {
        type: "error",
        message: err.message,
      });
      publishProjectEvent(projectId, {
        type: "queue_complete",
        projectId: String(projectId),
        kind: "all",
        stopped: false,
      });
    } finally {
      // Tear down all live category browser contexts opened during this queue run.
      await closeGroup(projectId).catch(() => {});
      state.running = false;
      state.kind = null;
      state.stopRequested = false;
      state.activeTestId = null;
      state.controller = null;
    }
  })();

  return { ok: true, total: queued.length };
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
