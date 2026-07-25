import { randomBytes } from "node:crypto";
import { Router } from "express";
import { openSse, sendEvent, closeSse } from "../lib/sse.js";
import { Project } from "../models/project.model.js";
import { Schedule } from "../models/schedule.model.js";
import {
  getQueueState,
  setQueuePaused,
  stopQueue,
  clearQueuedBatch,
  cancelQueuedTest,
  reorderQueue,
  runQueue,
} from "../services/queue-service.js";

export const automationProjectsRouter = Router();
export const schedulesRouter = Router();
export const webhooksRouter = Router();

function normalizeScheduleInput(projectId, body = {}) {
  return {
    projectId,
    name: String(body.name ?? "").trim(),
    suite: String(body.suite ?? "").trim(),
    cron: String(body.cron ?? "").trim(),
    environmentId: body.environmentId || undefined,
    callbackUrl: String(body.callbackUrl ?? "").trim(),
    maxRetries: Math.max(0, Number(body.maxRetries) || 0),
    enabled: body.enabled !== false,
  };
}

automationProjectsRouter.get("/:id/queue", async (req, res, next) => {
  try {
    res.json(await getQueueState(req.params.id));
  } catch (err) {
    next(err);
  }
});

automationProjectsRouter.post("/:id/queue/run", async (req, res) => {
  openSse(res);
  try {
    await runQueue({
      projectId: req.params.id,
      environmentId: req.body?.environmentId,
      suite: req.body?.suite,
      source: req.body?.source || "queue",
      maxRetries: req.body?.maxRetries,
      callbackUrl: req.body?.callbackUrl,
      onEvent: (event) => sendEvent(res, event.type, event),
    });
  } catch (err) {
    sendEvent(res, "error", { type: "error", message: err.message });
  } finally {
    closeSse(res);
  }
});

automationProjectsRouter.post("/:id/queue/pause", async (req, res, next) => {
  try {
    res.json(await setQueuePaused(req.params.id, req.body?.paused));
  } catch (err) {
    next(err);
  }
});

automationProjectsRouter.post("/:id/queue/stop", async (req, res, next) => {
  try {
    res.json(await stopQueue(req.params.id));
  } catch (err) {
    next(err);
  }
});

automationProjectsRouter.post("/:id/queue/clear", async (req, res, next) => {
  try {
    res.json(await clearQueuedBatch(req.params.id));
  } catch (err) {
    next(err);
  }
});

automationProjectsRouter.post("/:id/queue/cancel", async (req, res, next) => {
  try {
    const testId = req.body?.testId;
    if (!testId) return res.status(400).json({ error: "testId is required" });
    res.json(await cancelQueuedTest(req.params.id, testId));
  } catch (err) {
    next(err);
  }
});

automationProjectsRouter.patch("/:id/queue/order", async (req, res, next) => {
  try {
    if (!Array.isArray(req.body?.orderedIds)) {
      return res.status(400).json({ error: "orderedIds must be an array" });
    }
    res.json(await reorderQueue(req.params.id, req.body.orderedIds));
  } catch (err) {
    next(err);
  }
});

automationProjectsRouter.get("/:id/schedules", async (req, res, next) => {
  try {
    const schedules = await Schedule.find({ projectId: req.params.id }).sort({ createdAt: 1 });
    res.json(schedules.map((s) => s.toJSON()));
  } catch (err) {
    next(err);
  }
});

automationProjectsRouter.post("/:id/schedules", async (req, res, next) => {
  try {
    const input = normalizeScheduleInput(req.params.id, req.body);
    if (!input.name) return res.status(400).json({ error: "name is required" });
    if (!input.cron) return res.status(400).json({ error: "cron is required" });
    const schedule = await Schedule.create(input);
    res.status(201).json(schedule.toJSON());
  } catch (err) {
    next(err);
  }
});

automationProjectsRouter.post("/:id/webhook-token", async (req, res, next) => {
  try {
    const project = await Project.findByIdAndUpdate(
      req.params.id,
      { webhookToken: randomBytes(18).toString("hex") },
      { new: true },
    );
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json(project.toJSON());
  } catch (err) {
    next(err);
  }
});

schedulesRouter.patch("/:id", async (req, res, next) => {
  try {
    const existing = await Schedule.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Schedule not found" });
    const input = normalizeScheduleInput(existing.projectId, { ...existing.toJSON(), ...req.body });
    const schedule = await Schedule.findByIdAndUpdate(req.params.id, input, { new: true });
    res.json(schedule.toJSON());
  } catch (err) {
    next(err);
  }
});

schedulesRouter.delete("/:id", async (req, res, next) => {
  try {
    const schedule = await Schedule.findByIdAndDelete(req.params.id);
    if (!schedule) return res.status(404).json({ error: "Schedule not found" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

webhooksRouter.post("/:token/run", async (req, res, next) => {
  try {
    const project = await Project.findOne({ webhookToken: req.params.token });
    if (!project) return res.status(404).json({ error: "Webhook token not found" });

    void runQueue({
      projectId: project.id,
      environmentId: req.body?.environmentId,
      suite: req.body?.suite,
      source: "webhook",
      maxRetries: req.body?.maxRetries,
      callbackUrl: req.body?.callbackUrl || project.webhookCallbackUrl,
    }).catch((err) => console.error("[webhook] queue run failed:", err.message));

    res.status(202).json({
      ok: true,
      projectId: project.id,
      acceptedAt: new Date().toISOString(),
      suite: req.body?.suite || null,
    });
  } catch (err) {
    next(err);
  }
});
