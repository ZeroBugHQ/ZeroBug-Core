// Dual-path integration test: proves the UNIFIED engine drives BOTH the
// interactive "Run all" (background-runner.startBackgroundQueuedRuns) and the
// automation path (queue-service.runQueue) with consistent behavior.
//
// Runs in the normal `node --test` suite. It needs a reachable MongoDB; if none
// is available (e.g. a CI job without a DB service) the whole suite self-skips
// rather than failing. The heavy per-test executor is injected via runProjectBatch's
// `runTest` seam, so no Playwright/Ollama is involved.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { config } from "../config.js";

// Point at an isolated DB so we never touch real data.
config.mongoDb = "zerobug_dualpath_test";

const { Project } = await import("../models/project.model.js");
const { Test } = await import("../models/test.model.js");
const { startBackgroundQueuedRuns, getProjectRunState } = await import("./background-runner.js");
const { runQueue, getQueueState } = await import("./queue-service.js");

// Injected executor: mimics executeTestRun's effect on the Test document. A test
// whose code ends in "-FAIL" fails; everything else passes. Records the calls so
// we can assert ordering + threaded params (source, maxRetries).
function makeExecutor() {
  const calls = [];
  const runTest = async ({ id, test, source, maxRetries }) => {
    calls.push({ id: String(id), code: test.code, source, maxRetries });
    const fail = test.code.endsWith("-FAIL");
    const status = fail ? "failed" : "passed";
    await Test.findByIdAndUpdate(id, {
      status,
      durationMs: 5,
      failureReason: fail ? "scripted failure" : undefined,
    });
    return status;
  };
  return { runTest, calls };
}

let dbAvailable = false;
let projectId;

before(async () => {
  try {
    await mongoose.connect(config.mongoUri, { dbName: config.mongoDb, serverSelectionTimeoutMS: 4000 });
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

after(async () => {
  if (dbAvailable) {
    if (projectId) {
      await Test.deleteMany({ projectId });
      await Project.deleteMany({ _id: projectId });
    }
    await mongoose.disconnect();
  }
});

async function seed({ withDep = true } = {}) {
  await Test.deleteMany({ projectId });
  const mk = (code, priority, dependsOn = []) =>
    Test.create({
      projectId,
      code,
      title: code,
      status: "queued",
      priority,
      dependsOn,
      mode: "ui",
      steps: ["noop step"],
    });
  await mk("A-1-LOW", "low");
  await mk("A-2-FAIL", "critical"); // critical -> dispatches before low A-1
  if (withDep) await mk("A-3-DEP", "medium", ["A-2-FAIL"]); // blocked when A-2 fails
}

async function waitIdle() {
  for (let i = 0; i < 200; i++) {
    if (!getProjectRunState(projectId).running) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("run did not finish");
}

describe("unified engine: dual-path (UI + automation)", () => {
  test("setup project (skips all if no Mongo)", async (t) => {
    if (!dbAvailable) {
      t.skip("MongoDB not reachable — skipping dual-path integration tests");
      return;
    }
    await Project.deleteMany({ name: "DualPath Test" });
    const p = await Project.create({ name: "DualPath Test" });
    projectId = String(p._id);
  });

  test("UI path: priority order, blocked dependent, source=interactive", async (t) => {
    if (!dbAvailable || !projectId) return t.skip("no db");
    const { runTest, calls } = makeExecutor();
    await seed();
    await startBackgroundQueuedRuns({ projectId, environmentId: null, runTest });
    await waitIdle();

    const ranCodes = calls.map((c) => c.code);
    assert.ok(
      ranCodes.indexOf("A-2-FAIL") < ranCodes.indexOf("A-1-LOW"),
      `critical before low: ${ranCodes.join(",")}`,
    );
    assert.ok(calls.every((c) => c.source === "interactive"), "source=interactive");
    assert.ok(!ranCodes.includes("A-3-DEP"), "blocked dependent never ran");
    const a3 = await Test.findOne({ projectId, code: "A-3-DEP" }).lean();
    assert.equal(a3.status, "blocked", "dependent is blocked, not failed");
  });

  test("Automation path: same engine, summary counts, source=queue, maxRetries", async (t) => {
    if (!dbAvailable || !projectId) return t.skip("no db");
    const { runTest, calls } = makeExecutor();
    await seed();
    const summary = await runQueue({
      projectId,
      environmentId: null,
      source: "queue",
      maxRetries: 0,
      runTest,
    });

    const a3 = await Test.findOne({ projectId, code: "A-3-DEP" }).lean();
    assert.equal(a3.status, "blocked", "automation blocks the dependent identically");
    assert.equal(summary.totals.blocked, 1, "summary blocked=1");
    assert.equal(summary.totals.failed, 1, "summary failed=1");
    assert.equal(summary.totals.passed, 1, "summary passed=1");
    assert.ok(calls.every((c) => c.source === "queue"), "source=queue threaded");
    assert.ok(calls.every((c) => c.maxRetries === 0), "maxRetries override threaded");
  });

  test("Shared state: automation status API sees a UI-started run", async (t) => {
    if (!dbAvailable || !projectId) return t.skip("no db");
    const { runTest } = makeExecutor();
    await seed({ withDep: false });
    await startBackgroundQueuedRuns({ projectId, environmentId: null, runTest });
    const st = await getQueueState(projectId);
    assert.equal(st.running, true, "getQueueState sees the interactive run (merged state)");
    await waitIdle();
  });
});
