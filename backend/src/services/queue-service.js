import { Test } from "../models/test.model.js";
import { Project } from "../models/project.model.js";
import { executeTestRun } from "./run-service.js";
import { systemColumn } from "./project-service.js";
import { orderByDependencies, dependenciesMet } from "./queue-deps.js";
import { evaluateProjectAlerts } from "./alert-service.js";

const PRIORITY_WEIGHT = { critical: 0, high: 1, medium: 2, low: 3 };
const stateByProject = new Map();

function queueState(projectId) {
  const key = String(projectId);
  let state = stateByProject.get(key);
  if (!state) {
    state = {
      running: false,
      pendingTestIds: [],
      activeTestId: null,
      stopRequested: false,
      abortController: null,
      lastSource: null,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastSummary: null,
    };
    stateByProject.set(key, state);
  }
  return state;
}

function sortQueueTests(tests) {
  return [...tests].sort((a, b) => {
    const orderDiff = (a.queueOrder ?? 0) - (b.queueOrder ?? 0);
    if (orderDiff !== 0) return orderDiff;
    const priorityDiff = (PRIORITY_WEIGHT[a.priority] ?? 9) - (PRIORITY_WEIGHT[b.priority] ?? 9);
    if (priorityDiff !== 0) return priorityDiff;
    return String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""));
  });
}

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

async function buildQueueSummary(projectId, source, startedAt, completedTestIds = []) {
  const [project, tests] = await Promise.all([
    Project.findById(projectId).select("name webhookCallbackUrl").lean(),
    Test.find({ projectId }).sort({ queueOrder: 1, createdAt: 1 }).lean(),
  ]);
  const finished = tests.filter((t) => completedTestIds.includes(String(t._id)));
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
    },
    finished: finished.map((t) => ({
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
  state.abortController?.abort();
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

  const state = queueState(projectId);
  if (state.running) {
    const activeId = state.activeTestId;
    state.pendingTestIds = finalIds.filter(
      (id) => id !== activeId && state.pendingTestIds.includes(id),
    );
  }

  return { ok: true };
}

export async function runQueue({
  projectId,
  environmentId,
  suite,
  source = "queue",
  maxRetries,
  callbackUrl,
  onEvent = () => {},
}) {
  const state = queueState(projectId);
  if (state.running) {
    const err = new Error("Queue is already running for this project.");
    err.code = "QUEUE_RUNNING";
    throw err;
  }

  const project = await Project.findById(projectId).select("name webhookCallbackUrl").lean();
  if (!project) throw new Error("Project not found");

  const queued = orderByDependencies(
    sortQueueTests(
      await Test.find({
        projectId,
        status: "queued",
        ...(suite ? { suite } : {}),
      }).lean(),
    ),
  );
  const testById = new Map(queued.map((t) => [t.id ?? String(t._id), t]));
  const knownCodes = new Set(queued.map((t) => t.code));
  const passedCodes = new Set();

  state.running = true;
  state.stopRequested = false;
  state.activeTestId = null;
  state.pendingTestIds = queued.map((t) => t.id ?? String(t._id));
  state.abortController = new AbortController();
  state.lastSource = source;
  state.lastStartedAt = new Date().toISOString();
  state.lastFinishedAt = null;
  state.lastSummary = null;

  const completedTestIds = [];
  let failed = 0;
  let stopped = false;
  let lastError = null;

  onEvent({
    type: "queue_started",
    projectId: String(projectId),
    total: queued.length,
    suite: suite || null,
    source,
  });

  try {
    while (state.pendingTestIds.length > 0) {
      if (state.stopRequested) {
        stopped = true;
        break;
      }
      const canContinue = await waitForUnpause(projectId, state);
      if (!canContinue) {
        stopped = true;
        break;
      }

      const nextId = state.pendingTestIds.shift();
      if (!nextId) continue;

      // Skip tests whose dependencies haven't passed in this run.
      const queuedTest = testById.get(nextId);
      if (queuedTest && !dependenciesMet(queuedTest, passedCodes, knownCodes)) {
        const unmet = (queuedTest.dependsOn || []).filter(
          (c) => knownCodes.has(c) && !passedCodes.has(c),
        );
        const col = await systemColumn(projectId, "failed");
        await Test.findByIdAndUpdate(nextId, {
          status: "failed",
          failureReason: `Blocked: depends on ${unmet.join(", ")} (not passed)`,
          ...(col ? { columnId: col._id } : {}),
          $unset: { durationMs: "" },
        });
        onEvent({ type: "result", testId: nextId, status: "failed" });
        failed += 1;
        completedTestIds.push(nextId);
        continue;
      }

      state.activeTestId = nextId;

      onEvent({
        type: "queue_progress",
        projectId: String(projectId),
        activeTestId: nextId,
        pendingCount: state.pendingTestIds.length,
      });

      const runResult = await executeTestRun({
        testId: nextId,
        environmentId,
        maxRetries,
        source,
        signal: state.abortController.signal,
        onEvent,
      }).catch((err) => {
        lastError = err;
        throw err;
      });

      if (runResult?.result?.status === "passed" && queuedTest) {
        passedCodes.add(queuedTest.code);
      }
      completedTestIds.push(nextId);
      if (runResult.result.status === "failed") failed += 1;
      if (
        state.abortController.signal.aborted &&
        runResult.result.failureReason === "Cancelled by user."
      ) {
        stopped = true;
        break;
      }
    }
  } catch (err) {
    lastError = err;
    onEvent({ type: "error", message: err.message });
  } finally {
    state.running = false;
    state.activeTestId = null;
    state.abortController = null;
    state.stopRequested = false;
    state.pendingTestIds = [];
    const summary = await buildQueueSummary(
      projectId,
      source,
      state.lastStartedAt,
      completedTestIds,
    );
    summary.stopped = stopped;
    summary.error = lastError?.message || null;
    state.lastFinishedAt = new Date().toISOString();
    state.lastSummary = summary;
    onEvent({
      type: "queue_complete",
      projectId: String(projectId),
      total: queued.length,
      completed: completedTestIds.length,
      failed,
      stopped,
      error: lastError?.message,
    });
    await postCallback(callbackUrl || project.webhookCallbackUrl, summary);
    await evaluateProjectAlerts(projectId, completedTestIds);
    return summary;
  }
}
