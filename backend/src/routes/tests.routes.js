import { Router } from "express";
import { Test } from "../models/test.model.js";
import { Run } from "../models/run.model.js";
import { Column } from "../models/column.model.js";
import fs from "node:fs/promises";
import { openSse, sendEvent, closeSse } from "../lib/sse.js";
import { executeTestRun } from "../services/run-service.js";
import { systemColumn } from "../services/project-service.js";
import { baselinePathForTest } from "../services/artifact-service.js";

const PRIORITIES = ["low", "medium", "high", "critical"];

export const testsRouter = Router();

function genCode(suite) {
  const prefix = (suite || "TEST").slice(0, 4).toUpperCase();
  return `${prefix}-${Math.floor(Math.random() * 90 + 10)}`;
}

function normalizeTestPayload(body = {}) {
  const steps = Array.isArray(body.steps)
    ? body.steps.map((s) => String(s).trim()).filter(Boolean)
    : undefined;
  const assertionTypes = Array.isArray(body.assertionTypes)
    ? body.assertionTypes.map((item) => String(item).trim()).filter(Boolean)
    : undefined;
  const tags = Array.isArray(body.tags)
    ? [...new Set(body.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))]
    : undefined;
  const dependsOn = Array.isArray(body.dependsOn)
    ? [...new Set(body.dependsOn.map((c) => String(c).trim()).filter(Boolean))]
    : undefined;
  const dataRows = Array.isArray(body.dataRows)
    ? body.dataRows.filter((r) => r && typeof r === "object" && Object.keys(r).length > 0)
    : undefined;
  const apiConfig = body.apiConfig
    ? {
        method: String(body.apiConfig.method || "GET").toUpperCase(),
        url: String(body.apiConfig.url || "").trim(),
        headers:
          body.apiConfig.headers && typeof body.apiConfig.headers === "object"
            ? Object.fromEntries(
                Object.entries(body.apiConfig.headers).map(([key, value]) => [key, String(value)]),
              )
            : undefined,
        body: String(body.apiConfig.body || ""),
        expectedStatus: Number(body.apiConfig.expectedStatus ?? 200),
        expectedBodyContains: String(body.apiConfig.expectedBodyContains || ""),
        expectedJsonPath: String(body.apiConfig.expectedJsonPath || ""),
        expectedJsonValue: String(body.apiConfig.expectedJsonValue || ""),
      }
    : undefined;

  return {
    title: body.title,
    description: body.description || "No description provided.",
    suite: body.suite || "General",
    tags,
    dependsOn,
    dataRows,
    priority: body.priority || "medium",
    estMs: body.estMs ?? 1800 + (steps?.length ?? 0) * 400,
    budgetMs: Math.max(0, Number(body.budgetMs ?? 0) || 0),
    steps: steps && steps.length ? steps : undefined,
    attachments:
      Array.isArray(body.attachments) && body.attachments.length ? body.attachments : undefined,
    maxRetries: Math.max(0, Math.min(Number(body.maxRetries ?? 0) || 0, 5)),
    mode: body.mode === "api" ? "api" : "ui",
    categoryId: body.categoryId || undefined,
    viewport: ["desktop", "tablet", "mobile"].includes(body.viewport) ? body.viewport : "desktop",
    assertionTypes:
      assertionTypes && assertionTypes.length
        ? assertionTypes
        : body.mode === "api"
          ? ["functional"]
          : ["functional"],
    apiConfig,
  };
}

// All test reads are scoped to a project (?projectId=...).
testsRouter.get("/", async (req, res, next) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: "projectId is required" });
    const tests = await Test.find({ projectId }).sort({ createdAt: 1 });
    res.json(tests.map((t) => t.toJSON()));
  } catch (err) {
    next(err);
  }
});

testsRouter.post("/", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    if (!body.projectId) return res.status(400).json({ error: "projectId is required" });
    const queued = await systemColumn(body.projectId, "queued");
    const payload = normalizeTestPayload(body);
    const test = await Test.create({
      projectId: body.projectId,
      columnId: body.columnId ?? queued?._id,
      code: body.code || genCode(body.suite),
      status: "queued",
      ...payload,
    });
    res.status(201).json(test.toJSON());
  } catch (err) {
    next(err);
  }
});

// Bulk operations over many tests at once (requeue / delete / move / tag / priority).
testsRouter.post("/bulk", async (req, res, next) => {
  try {
    const { action, ids } = req.body ?? {};
    if (!action || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "action and ids are required" });
    }
    const tests = await Test.find({ _id: { $in: ids } }).select("projectId");
    if (!tests.length) return res.json({ ok: true, affected: 0 });
    const projectId = tests[0].projectId;

    switch (action) {
      case "delete":
        await Test.deleteMany({ _id: { $in: ids } });
        break;
      case "requeue": {
        const queued = await systemColumn(projectId, "queued");
        await Test.updateMany(
          { _id: { $in: ids } },
          { status: "queued", columnId: queued?._id, $unset: { durationMs: "", failureReason: "" } },
        );
        break;
      }
      case "addTag":
      case "removeTag": {
        const tag = String(req.body.tag || "").trim().toLowerCase();
        if (!tag) return res.status(400).json({ error: "tag is required" });
        const op = action === "addTag" ? { $addToSet: { tags: tag } } : { $pull: { tags: tag } };
        await Test.updateMany({ _id: { $in: ids } }, op);
        break;
      }
      case "setPriority": {
        const priority = String(req.body.priority || "");
        if (!PRIORITIES.includes(priority)) return res.status(400).json({ error: "invalid priority" });
        await Test.updateMany({ _id: { $in: ids } }, { priority });
        break;
      }
      case "setCategory": {
        // categoryId "" / null → move to Uncategorized.
        const categoryId = req.body.categoryId || null;
        await Test.updateMany(
          { _id: { $in: ids } },
          categoryId ? { categoryId } : { $unset: { categoryId: "" } },
        );
        break;
      }
      case "move": {
        const { columnId } = req.body;
        if (!columnId) return res.status(400).json({ error: "columnId is required" });
        const col = await Column.findById(columnId);
        const update = { columnId };
        if (col?.systemKey) {
          update.status = col.systemKey;
          if (col.systemKey === "queued") update.$unset = { durationMs: "", failureReason: "" };
        }
        await Test.updateMany({ _id: { $in: ids } }, update);
        break;
      }
      default:
        return res.status(400).json({ error: `unknown action "${action}"` });
    }
    res.json({ ok: true, affected: ids.length });
  } catch (err) {
    next(err);
  }
});

testsRouter.patch("/:id", async (req, res, next) => {
  try {
    const allowed = [
      "code",
      "title",
      "description",
      "suite",
      "tags",
      "dependsOn",
      "dataRows",
      "priority",
      "estMs",
      "budgetMs",
      "steps",
      "attachments",
      "status",
      "columnId",
      "durationMs",
      "failureReason",
      "maxRetries",
      "mode",
      "viewport",
      "assertionTypes",
      "apiConfig",
      "categoryId",
    ];
    const normalized = normalizeTestPayload(req.body ?? {});
    const update = {};
    for (const key of allowed) {
      if (key in (req.body ?? {})) update[key] = normalized[key] ?? req.body[key];
    }
    const test = await Test.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!test) return res.status(404).json({ error: "Test not found" });
    res.json(test.toJSON());
  } catch (err) {
    next(err);
  }
});

testsRouter.post("/:id/reset", async (req, res, next) => {
  try {
    const existing = await Test.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Test not found" });
    const queued = await systemColumn(existing.projectId, "queued");
    const test = await Test.findByIdAndUpdate(
      req.params.id,
      { status: "queued", columnId: queued?._id, $unset: { durationMs: "", failureReason: "" } },
      { new: true },
    );
    res.json(test.toJSON());
  } catch (err) {
    next(err);
  }
});

// Latest run (steps + captured output) for a test, or null if it hasn't run.
testsRouter.get("/:id/runs/latest", async (req, res, next) => {
  try {
    const run = await Run.findOne({ testId: req.params.id }).sort({ createdAt: -1 });
    res.json(run ? run.toJSON() : null);
  } catch (err) {
    next(err);
  }
});

// Reset the visual baseline so the next run re-captures it ("reject" a baseline).
testsRouter.delete("/:id/baseline", async (req, res, next) => {
  try {
    const { absolutePath } = baselinePathForTest(req.params.id);
    await fs.unlink(absolutePath).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

testsRouter.delete("/:id", async (req, res, next) => {
  try {
    const test = await Test.findByIdAndDelete(req.params.id);
    if (!test) return res.status(404).json({ error: "Test not found" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Stream a real Playwright run over SSE.
testsRouter.post("/:id/run", async (req, res) => {
  openSse(res);
  let aborted = false;
  const abort = new AbortController();
  res.on("close", () => {
    aborted = true;
    abort.abort();
  });
  try {
    await executeTestRun({
      testId: req.params.id,
      environmentId: req.body?.environmentId,
      signal: abort.signal,
      onEvent: (event) => {
        if (!aborted) sendEvent(res, event.type, event);
      },
    });
  } catch (err) {
    sendEvent(res, "error", { type: "error", message: err.message });
  } finally {
    closeSse(res);
  }
});
