import { Test } from "../models/test.model.js";
import { Environment } from "../models/environment.model.js";
import { Run } from "../models/run.model.js";
import { Project } from "../models/project.model.js";
import { runTest as runWithPlaywright } from "./playwright-runner.js";
import { runApiTest } from "./api-runner.js";
import { systemColumn } from "./project-service.js";
import { askQuestion } from "./question-broker.js";
import { recordTokens } from "./usage-service.js";
import { notifyRunCompletion } from "./notification-service.js";
import { resolveAvailableModel } from "./ollama.js";
import { getSecretMap } from "./secret-service.js";
import { sessionPath, sessionExists, ensureSessionDir } from "./session-store.js";
import { acquirePooledContext } from "./browser-pool.js";
import { refreshFlakyFlag } from "./insights-service.js";
import { getHints, reinforce, recordLessons } from "./site-memory-service.js";

/**
 * Resolve the environment a run should target: the explicit one, else the first
 * active environment, else any. Environments are global (no projectId filter).
 */
async function resolveEnvironment(environmentId) {
  if (environmentId) {
    const env = await Environment.findById(environmentId).lean();
    if (env) return env;
  }
  return (
    (await Environment.findOne({ active: true }).lean()) ?? (await Environment.findOne({}).lean())
  );
}

async function resolveAgentModel() {
  return {
    model: await resolveAvailableModel(),
  };
}

// Move a test to the project's system column matching its execution status.
async function moveToSystemColumn(test, status) {
  const col = await systemColumn(test.projectId, status);
  if (col) test.columnId = col._id;
}

function isStopped(resultOrError) {
  return (resultOrError?.failureReason || resultOrError?.message || "") === "Stopped by user.";
}

// Coerce a data row's values to strings for {{col}} substitution.
function rowToStringMap(row) {
  const out = {};
  if (row && typeof row === "object") {
    for (const [k, v] of Object.entries(row)) out[String(k)] = v == null ? "" : String(v);
  }
  return out;
}
function rowLabel(row) {
  return Object.entries(rowToStringMap(row))
    .map(([k, v]) => `${k}=${v}`)
    .join(", ")
    .slice(0, 80);
}
function dedupeArtifacts(list) {
  return list.filter((a, i, arr) => a?.url && arr.findIndex((x) => x.url === a.url) === i);
}

/**
 * Finalise runs left dangling by a crash/restart. A test stuck in "running" has
 * no live run behind it after the process restarts, so it would otherwise spin
 * forever and stay un-draggable/un-runnable. Mark such tests failed (interrupted)
 * and move them to the failed column so the user can re-run or move them.
 * @returns number of tests reclaimed
 */
export async function reclaimOrphanRuns() {
  const stuck = await Test.find({ status: "running" });
  for (const test of stuck) {
    test.status = "failed";
    test.durationMs = undefined;
    test.failureReason =
      "Interrupted — the run didn't finish (the server restarted or was stopped mid-run).";
    await moveToSystemColumn(test, "failed");
    await test.save();
  }
  await Run.updateMany(
    { status: "running" },
    { status: "failed", finishedAt: new Date(), failureReason: "Interrupted — server restarted." },
  );
  return stuck.length;
}

/**
 * Execute a test: mark it running, drive Playwright or HTTP assertions, persist a
 * Run and the test's result, streaming each event through onEvent.
 * @returns the final result object (with the updated test).
 */
export async function executeTestRun({
  testId,
  environmentId,
  onEvent = () => {},
  signal,
  pooled = false,
}) {
  const test = await Test.findById(testId);
  if (!test) throw new Error("Test not found");

  // Data-driven UI tests run the agent once per row (own isolated path).
  if (test.mode !== "api" && Array.isArray(test.dataRows) && test.dataRows.length > 0) {
    return executeDataDrivenRun({ test, environmentId, onEvent, signal });
  }

  const [environment, previousRun, { model }, project] = await Promise.all([
    resolveEnvironment(environmentId),
    Run.findOne({ testId: test._id }).sort({ createdAt: -1 }).lean(),
    resolveAgentModel(),
    Project.findById(test.projectId)
      .lean()
      .catch(() => null),
  ]);

  // Resolve this environment's secrets (decrypted, server-side) and any saved
  // logged-in session to reuse — both UI runs only.
  const envId = environment?._id ? String(environment._id) : null;
  // One persisted browser session PER CATEGORY (per environment): the first test
  // in a category logs in, saves its cookies/localStorage, and every other test
  // in that category reuses it — so we don't re-login (and burn tokens) each run.
  // Uncategorized tests share a per-environment session.
  const sessionKey = envId ? (test.categoryId ? `${envId}__${test.categoryId}` : envId) : null;
  const [secrets, hasSession] = await Promise.all([
    envId ? getSecretMap(envId) : Promise.resolve({}),
    test.mode !== "api" && sessionKey ? sessionExists(sessionKey) : Promise.resolve(false),
  ]);
  if (test.mode !== "api" && envId) await ensureSessionDir().catch(() => {});

  const maxAttempts = Math.max(1, Number(test.maxRetries ?? 0) + 1);

  test.status = "running";
  test.durationMs = undefined;
  test.failureReason = undefined;
  await moveToSystemColumn(test, "running");
  await test.save();

  const run = await Run.create({
    testId: test._id,
    status: "running",
    mode: test.mode || "ui",
    assertionTypes: test.assertionTypes || ["functional"],
    attempt: 1,
    maxAttempts,
  });

  let persistQueue = Promise.resolve();
  const emit = (event) => {
    persistQueue = persistQueue
      .then(async () => {
        if (event.type === "attempt") {
          run.attempt = event.attempt;
          run.maxAttempts = event.maxAttempts;
          await run.save();
        } else if (event.type === "step") {
          const nextSteps = [...(run.steps || [])];
          const idx = nextSteps.findIndex((step) => step.index === event.index);
          const next = {
            index: event.index,
            label: event.label,
            status: event.status,
            detail: event.detail,
          };
          if (idx >= 0) nextSteps[idx] = next;
          else nextSteps.push(next);
          run.steps = nextSteps;
          await run.save();
        }
      })
      .catch(() => null);
    // Tag every forwarded event with the test id so the client can associate
    // step/screenshot events (which the runner emits without one) to this test.
    onEvent(event.testId ? event : { ...event, testId: test.id });
  };

  emit({ type: "status", testId: test.id, status: "running" });

  // During a queue run, reuse ONE live browser context per category (keyed by
  // env + category + viewport) so the whole category logs in once and stays
  // logged in. Best-effort: if it can't be acquired, fall back to a fresh
  // browser per run (standalone). Only for UI tests.
  let pool = null;
  if (pooled && test.mode !== "api" && sessionKey) {
    try {
      pool = await acquirePooledContext({
        poolKey: `${sessionKey}__${test.viewport || "desktop"}`,
        groupId: String(test.projectId),
        viewport: test.viewport,
        storageStateLoad: hasSession && sessionKey ? sessionPath(sessionKey) : undefined,
        storageStatePath: sessionKey ? sessionPath(sessionKey) : undefined,
      });
    } catch {
      pool = null; // fall back to standalone
    }
  }

  let result;
  let attemptsUsed = 1;

  // Site-memory: lessons learned from past runs on this site, injected as fallible
  // hints. `memory.ids` are reinforced (up on pass, down on fail) after the run.
  const memory =
    test.mode !== "api"
      ? await getHints({ projectId: test.projectId, url: environment?.url })
      : { ids: [], text: "" };

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attemptsUsed = attempt;
      emit({ type: "attempt", testId: test.id, attempt, maxAttempts });

      result =
        test.mode === "api"
          ? await runApiTest({
              test: test.toJSON(),
              environment,
              onEvent: emit,
              signal,
              secrets,
            })
          : await runWithPlaywright({
              test: test.toJSON(),
              environment,
              onEvent: emit,
              ask: (payload) => askQuestion(payload, emit, { signal }),
              savedLogin: environment?.loginInstructions || "",
              onLearnLogin: async (instructions) => {
                if (environment?._id) {
                  await Environment.findByIdAndUpdate(environment._id, {
                    loginInstructions: instructions,
                  });
                }
              },
              onUsage: (usage) => {
                recordTokens(test.projectId, usage);
                emit({ type: "usage", testId: test.id, ...usage });
              },
              secrets,
              storageStateLoad: hasSession && sessionKey ? sessionPath(sessionKey) : undefined,
              storageStatePath: sessionKey ? sessionPath(sessionKey) : undefined,
              onSaveStorageState: async () => {
                if (envId) {
                  await Environment.findByIdAndUpdate(envId, { storageStateSavedAt: new Date() });
                }
              },
              signal,
              runId: run.id,
              attempt,
              model,
              // Reuse the live category context; the pool was authenticated once.
              sharedContext: pool?.context,
              sessionReused: pool ? pool.reused : hasSession,
              hints: memory.text,
            });

      // Wait for any queued saves from emit() — the emit({ type: "attempt" })
      // handler already saves run.attempt, so the explicit save below is skipped
      // to avoid a parallel-save conflict on the same Mongoose document.
      await persistQueue.catch(() => null);

      if (result.status === "passed" || isStopped(result) || signal?.aborted) break;
      if (attempt < maxAttempts) {
        emit({
          type: "retry",
          testId: test.id,
          attempt: attempt + 1,
          maxAttempts,
          failureReason: result.failureReason,
        });
      }
    }
  } finally {
    pool?.release();
  }

  test.status = result.status;
  test.durationMs = result.durationMs;
  test.failureReason = result.failureReason;
  if (Number.isFinite(result.durationMs) && result.durationMs > 0) {
    test.estMs = result.durationMs;
  }
  await moveToSystemColumn(test, result.status);
  await test.save();

  await persistQueue.catch(() => null);

  run.status = result.status;
  run.finishedAt = new Date();
  run.durationMs = result.durationMs;
  run.failureReason = result.failureReason;
  run.actions = result.actions;
  run.steps = result.steps;
  run.output = result.output;
  run.artifacts = result.artifacts || [];
  run.forensics = result.forensics;
  run.attempt = attemptsUsed;
  run.maxAttempts = maxAttempts;
  await run.save();

  await refreshFlakyFlag(test._id).catch(() => {});

  await reinforce({ usedLessonIds: memory.ids, passed: result.status === "passed" }).catch(
    () => {},
  );
  await recordLessons({
    projectId: test.projectId,
    run: run.toJSON(),
    test: test.toJSON(),
    observations: result.observations,
    model,
  }).catch(() => {});

  await notifyRunCompletion({
    projectName: project?.name || "project",
    test: test.toJSON(),
    run: run.toJSON(),
    previousStatus: previousRun?.status,
  }).catch(() => null);

  emit({
    type: "result",
    testId: test.id,
    status: result.status,
    durationMs: result.durationMs,
    failureReason: result.failureReason,
    attempt: attemptsUsed,
    maxAttempts,
    artifacts: result.artifacts || [],
  });

  return { test: test.toJSON(), result };
}

/**
 * Data-driven run: execute the UI agent once per data row, substituting {{col}}
 * placeholders with that row's values. The test passes only if every row passes.
 * Isolated from executeTestRun so it can't affect normal runs.
 */
async function executeDataDrivenRun({ test, environmentId, onEvent = () => {}, signal }) {
  const rows = test.dataRows;
  const [environment, previousRun, { model }, project] = await Promise.all([
    resolveEnvironment(environmentId),
    Run.findOne({ testId: test._id }).sort({ createdAt: -1 }).lean(),
    resolveAgentModel(),
    Project.findById(test.projectId)
      .lean()
      .catch(() => null),
  ]);
  const envId = environment?._id ? String(environment._id) : null;
  const sessionKey = envId ? (test.categoryId ? `${envId}__${test.categoryId}` : envId) : null;
  const [baseSecrets, hasSession] = await Promise.all([
    envId ? getSecretMap(envId) : Promise.resolve({}),
    sessionKey ? sessionExists(sessionKey) : Promise.resolve(false),
  ]);
  if (envId) await ensureSessionDir().catch(() => {});

  test.status = "running";
  test.durationMs = undefined;
  test.failureReason = undefined;
  await moveToSystemColumn(test, "running");
  await test.save();

  const run = await Run.create({
    testId: test._id,
    status: "running",
    mode: "ui",
    assertionTypes: test.assertionTypes || ["functional"],
    attempt: 1,
    maxAttempts: rows.length,
  });

  onEvent({ type: "status", testId: test.id, status: "running" });

  const combinedSteps = [];
  let stepOffset = 0;
  let aggStatus = "passed";
  let aggFailure;
  let totalDuration = 0;
  const allArtifacts = [];
  let lastOutput;
  let lastForensics;

  // Site-memory hints (shared across all rows) + aggregated observations to learn from.
  const memory = await getHints({ projectId: test.projectId, url: environment?.url });
  const aggDialogHeadings = new Set();
  let aggSawLoginForm = false;

  for (let r = 0; r < rows.length; r += 1) {
    if (signal?.aborted) {
      aggStatus = "failed";
      aggFailure = "Stopped by user.";
      break;
    }
    const row = rows[r];
    const label = rowLabel(row);
    onEvent({ type: "attempt", testId: test.id, attempt: r + 1, maxAttempts: rows.length });

    // Stream this row's steps live with a row prefix + offset indices so they
    // don't collide with other rows in the combined Run.
    const rowEmit = (event) => {
      if (event.type === "step") {
        const e = {
          ...event,
          testId: test.id,
          index: event.index + stepOffset,
          label: `Row ${r + 1}: ${event.label}`,
        };
        const idx = combinedSteps.findIndex((s) => s.index === e.index);
        if (idx >= 0) combinedSteps[idx] = e;
        else combinedSteps.push(e);
        onEvent(e);
      } else {
        onEvent(event.testId ? event : { ...event, testId: test.id });
      }
    };

    const result = await runWithPlaywright({
      test: test.toJSON(),
      environment,
      onEvent: rowEmit,
      ask: (payload) => askQuestion(payload, rowEmit, { signal }),
      savedLogin: environment?.loginInstructions || "",
      onLearnLogin: async (instructions) => {
        if (envId) await Environment.findByIdAndUpdate(envId, { loginInstructions: instructions });
      },
      onUsage: (usage) => {
        recordTokens(test.projectId, usage);
        onEvent({ type: "usage", testId: test.id, ...usage });
      },
      secrets: { ...baseSecrets, ...rowToStringMap(row) },
      storageStateLoad: hasSession && sessionKey ? sessionPath(sessionKey) : undefined,
      storageStatePath: sessionKey ? sessionPath(sessionKey) : undefined,
      onSaveStorageState: async () => {
        if (envId) await Environment.findByIdAndUpdate(envId, { storageStateSavedAt: new Date() });
      },
      signal,
      runId: run.id,
      attempt: r + 1,
      model,
      hints: memory.text,
    });

    stepOffset += result.steps?.length || 0;
    totalDuration += result.durationMs || 0;
    allArtifacts.push(...(result.artifacts || []));
    lastOutput = result.output || lastOutput;
    lastForensics = result.forensics || lastForensics;
    for (const h of result.observations?.dialogHeadings || []) aggDialogHeadings.add(h);
    if (result.observations?.sawLoginForm) aggSawLoginForm = true;
    if (result.status !== "passed") {
      aggStatus = "failed";
      if (!aggFailure) aggFailure = `Row ${r + 1} (${label}): ${result.failureReason || "failed"}`;
    }
  }

  test.status = aggStatus;
  test.durationMs = totalDuration;
  test.failureReason = aggFailure;
  if (totalDuration > 0) test.estMs = totalDuration;
  await moveToSystemColumn(test, aggStatus);
  await test.save();

  run.status = aggStatus;
  run.finishedAt = new Date();
  run.durationMs = totalDuration;
  run.failureReason = aggFailure;
  run.steps = combinedSteps;
  run.output = lastOutput;
  run.forensics = lastForensics;
  run.artifacts = dedupeArtifacts(allArtifacts);
  run.attempt = rows.length;
  run.maxAttempts = rows.length;
  await run.save();

  await refreshFlakyFlag(test._id).catch(() => {});

  await reinforce({ usedLessonIds: memory.ids, passed: aggStatus === "passed" }).catch(() => {});
  await recordLessons({
    projectId: test.projectId,
    run: run.toJSON(),
    test: test.toJSON(),
    observations: { dialogHeadings: [...aggDialogHeadings], sawLoginForm: aggSawLoginForm },
    model,
  }).catch(() => {});

  await notifyRunCompletion({
    projectName: project?.name || "project",
    test: test.toJSON(),
    run: run.toJSON(),
    previousStatus: previousRun?.status,
  }).catch(() => null);

  onEvent({
    type: "result",
    testId: test.id,
    status: aggStatus,
    durationMs: totalDuration,
    failureReason: aggFailure,
    attempt: rows.length,
    maxAttempts: rows.length,
    artifacts: run.artifacts,
  });

  return {
    test: test.toJSON(),
    result: {
      status: aggStatus,
      durationMs: totalDuration,
      failureReason: aggFailure,
      steps: combinedSteps,
      output: lastOutput,
      artifacts: run.artifacts,
    },
  };
}
