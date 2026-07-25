import { Router } from "express";
import { listLessons, forgetLesson, forgetAll } from "../services/site-memory-service.js";
import { recordAudit } from "../services/audit-service.js";

export const memoryRouter = Router();

// All lessons the agent has learned for a project (read-only panel).
memoryRouter.get("/", async (req, res, next) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: "projectId is required" });
    res.json(await listLessons({ projectId }));
  } catch (err) {
    next(err);
  }
});

// Forget everything for a project (optionally scoped to one origin). Registered
// before "/:id" so the bare DELETE isn't captured by the param route.
memoryRouter.delete("/", async (req, res, next) => {
  try {
    const { projectId, origin } = req.query;
    if (!projectId) return res.status(400).json({ error: "projectId is required" });
    const result = await forgetAll({ projectId, origin });
    recordAudit("memory.forget-all", `Forgot ${result.deleted} lesson(s)`, projectId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Forget a single lesson (the "forget" button).
memoryRouter.delete("/:id", async (req, res, next) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: "projectId is required" });
    const result = await forgetLesson({ projectId, id: req.params.id });
    if (!result.deleted) return res.status(404).json({ error: "Lesson not found" });
    recordAudit("memory.forget", `Forgot lesson ${req.params.id}`, projectId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
