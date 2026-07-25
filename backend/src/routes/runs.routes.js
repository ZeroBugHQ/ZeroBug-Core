import { Router } from "express";
import { Test } from "../models/test.model.js";
import { Run } from "../models/run.model.js";
import { explainFailure, resolveAvailableModel } from "../services/ollama.js";
import { answerQuestion } from "../services/question-broker.js";
import {
  getProjectRunState,
  startBackgroundQueuedRuns,
  startBackgroundSingleRun,
  stopBackgroundRuns,
} from "../services/background-runner.js";
import { subscribeProjectEvents } from "../services/run-bus.js";
import { recordAudit } from "../services/audit-service.js";
import { openSse, sendEvent, closeSse } from "../lib/sse.js";

export const runsRouter = Router();

runsRouter.get("/stream", async (req, res, next) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: "projectId is required" });

    openSse(res);
    const unsubscribe = subscribeProjectEvents(projectId, (event) =>
      sendEvent(res, event.type, event),
    );
    const ping = setInterval(() => sendEvent(res, "ping", { type: "ping" }), 15000);
    const state = getProjectRunState(projectId);
    sendEvent(res, "state", { type: "state", ...state, projectId: String(projectId) });

    res.on("close", () => {
      clearInterval(ping);
      unsubscribe();
      closeSse(res);
    });
  } catch (err) {
    next(err);
  }
});

runsRouter.post("/start", async (req, res, next) => {
  try {
    const { testId, environmentId } = req.body ?? {};
    if (!testId) return res.status(400).json({ error: "testId is required" });
    await startBackgroundSingleRun({ testId, environmentId });
    recordAudit("run.start", `Started test ${testId}`);
    res.json({ ok: true });
  } catch (err) {
    // "not found" → 404; an in-progress run is a genuine conflict → 409.
    const status = /not found/i.test(err.message) ? 404 : 409;
    res.status(status).json({ error: err.message });
  }
});

runsRouter.post("/start-all", async (req, res, next) => {
  try {
    const { projectId, environmentId, mode } = req.body ?? {};
    if (!projectId) return res.status(400).json({ error: "projectId is required" });
    const started = await startBackgroundQueuedRuns({ projectId, environmentId, mode });
    recordAudit("run.start-all", `Started ${started?.total ?? 0} queued run(s)`, projectId);
    res.json(started);
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

runsRouter.post("/stop", async (req, res, next) => {
  try {
    const { projectId, testId } = req.body ?? {};
    let resolvedProjectId = projectId;
    if (!resolvedProjectId && testId) {
      const test = await Test.findById(testId).lean();
      resolvedProjectId = test?.projectId ? String(test.projectId) : null;
    }
    if (!resolvedProjectId)
      return res.status(400).json({ error: "projectId or testId is required" });
    recordAudit("run.stop", `Stopped runs`, resolvedProjectId);
    res.json(stopBackgroundRuns(resolvedProjectId));
  } catch (err) {
    next(err);
  }
});

// AI failure triage: explain why the latest (or a specific) run failed + propose a fix.
runsRouter.post("/explain", async (req, res, next) => {
  try {
    const { testId, runId } = req.body ?? {};
    if (!testId && !runId) return res.status(400).json({ error: "testId or runId is required" });
    const run = runId
      ? await Run.findById(runId).lean()
      : await Run.findOne({ testId }).sort({ createdAt: -1 }).lean();
    if (!run) return res.status(404).json({ error: "No run found for this test." });
    const test = await Test.findById(run.testId).lean();
    if (!test) return res.status(404).json({ error: "Test not found." });
    const model = await resolveAvailableModel();
    const explanation = await explainFailure({ test, run, model });
    res.json(explanation);
  } catch (err) {
    next(err);
  }
});

runsRouter.post("/answer", (req, res) => {
  const { questionId, text } = req.body ?? {};
  if (!questionId) return res.status(400).json({ error: "questionId is required" });
  const delivered = answerQuestion(questionId, typeof text === "string" ? text : "");
  res.json({ ok: delivered });
});
