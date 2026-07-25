import { Router } from "express";
import { collectStats, collectPassRateHistory } from "../services/stats-service.js";
import { collectInsights } from "../services/insights-service.js";

export const statsRouter = Router();

// Flaky tests + run-over-run diff (newly failed/passed/slower).
statsRouter.get("/insights", async (req, res, next) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: "projectId is required" });
    res.json(await collectInsights(projectId));
  } catch (err) {
    next(err);
  }
});

statsRouter.get("/", async (req, res, next) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: "projectId is required" });
    res.json(await collectStats(projectId));
  } catch (err) {
    next(err);
  }
});

// Daily pass-rate history: last N days (default 30).
statsRouter.get("/history", async (req, res, next) => {
  try {
    const { projectId, days } = req.query;
    if (!projectId) return res.status(400).json({ error: "projectId is required" });
    res.json(await collectPassRateHistory(projectId, Number(days) || 30));
  } catch (err) {
    next(err);
  }
});
