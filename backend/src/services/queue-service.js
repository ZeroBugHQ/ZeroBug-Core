// Automation / CI / webhook / schedule entry point. Since the runner unification
// (Q6), this is a THIN WRAPPER over the single canonical batch engine in
// background-runner.js (runProjectBatch). It keeps the queue-management API the
// automation routes depend on -- status, pause/resume, stop, cancel/clear/reorder
// -- all operating on the shared queue-state so they see the same in-flight run
// the interactive "Run all" uses.
import { Test } from "../models/test.model.js";
import { Project } from "../models/project.model.js";
import { queueState } from "./queue-state.js";
import { runProjectBatch, buildQueueSummary } from "./background-runner.js";

export async function getQueueState(projectId) {
  const project = await Project.findById(projectId).select("queuePaused").lean();
  const state = queueState(projectId);
  return {
    projectId: String(projectId),
    running: state.running,
    paused: !!project?.queuePaused,
    activeTestId: state.activeTestId,
    pendingTestIds: [...state.pendingTestIds],
    pendingCount: state.pendingTestIds.length,
    lastSource: state.lastSource,
    lastStartedAt: state.lastStartedAt,
    lastFinishedAt: state.lastFinishedAt,
    lastSummary: state.lastSummary,
  };
}

export async function setQueuePaused(projectId, paused) {
  const project = await Project.findByIdAndUpdate(
    projectId,
    { queuePaused: !!paused },
    { new: true },
  );
  if (!project) throw new Error("Project not found");
  return getQueueState(projectId);
}

// Remove a not-yet-dispatched test from the live queue. Because the scheduler
// re-reads state.pendingTestIds each cycle, this takes effect on the next
// dispatch even mid-run under concurrency.
export async function cancelQueuedTest(projectId, testId) {
  const state = queueState(projectId);
  const before = state.pendingTestIds.length;
  state.pendingTestIds = state.pendingTestIds.filter((id) => id !== String(testId));
  return { ok: before !== state.pendingTestIds.length, pendingCount: state.pendingTestIds.length };
}

export async function clearQueuedBatch(projectId) {
  const state = queueState(projectId);
  const cleared = state.pendingTestIds.length;
  state.pendingTestIds = [];
  return { ok: true, cleared };
}

export async function stopQueue(projectId) {
  const state = queueState(projectId);
  state.stopRequested = true;
  state.pendingTestIds = [];
  state.controller?.abort();
  return { ok: true };
}

export async function reorderQueue(projectId, orderedIds) {
  const ids = orderedIds.map((id) => String(id));
  const queued = await Test.find({ projectId, status: "queued" }).select("_id").lean();
  const queuedIds = new Set(queued.map((t) => String(t._id)));
  const filtered = ids.filter((id) => queuedIds.has(id));
  const missing = [...queuedIds].filter((id) => !filtered.includes(id));
  const finalIds = [...filtered, ...missing];

  await Promise.all(
    finalIds.map((id, index) => Test.findByIdAndUpdate(id, { queueOrder: index + 1 })),
  );

  // If a batch is in flight, reorder the LIVE pending list too (minus whatever is
  // already active/dispatched) so the new order is honored on the next cycle.
  const state = queueState(projectId);
  if (state.running) {
    const activeId = state.activeTestId;
    state.pendingTestIds = finalIds.filter(
      (id) => id !== activeId && state.pendingTestIds.includes(id),
    );
  }

  return { ok: true };
}

/**
 * Automation/CI/webhook/schedule batch run. Delegates to the unified engine with
 * automation-flavored options: honor pause, build a summary, fire the webhook
 * callback, and forward events to the caller's onEvent sink (in addition to the
 * SSE bus). Preserves the QUEUE_RUNNING coded error for callers.
 */
export async function runQueue({
  projectId,
  environmentId,
  suite,
  source = "queue",
  maxRetries,
  callbackUrl,
  onEvent = () => {},
  runTest, // testing seam; omitted in production -> real executor
}) {
  const project = await Project.findById(projectId).select("name webhookCallbackUrl").lean();
  if (!project) throw new Error("Project not found");

  try {
    return await runProjectBatch({
      projectId,
      environmentId,
      suite,
      source,
      maxRetries,
      pause: true,
      callbackUrl: callbackUrl || project.webhookCallbackUrl,
      buildSummary: true,
      onEvent,
      ...(runTest ? { runTest } : {}),
    });
  } catch (err) {
    // An empty queue is a no-op for automation (a scheduled run with nothing
    // queued shouldn't error) -- return an empty summary, matching prior
    // behavior. Any other error (incl. QUEUE_RUNNING) propagates unchanged.
    if (err.message === "No queued tests to run.") {
      const summary = await buildQueueSummary(projectId, source, new Date().toISOString(), []);
      summary.stopped = false;
      onEvent({ type: "queue_complete", projectId: String(projectId), total: 0, stopped: false });
      return summary;
    }
    throw err;
  }
}
