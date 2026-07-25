import { Router } from "express";
import { Test } from "../models/test.model.js";
import { Run } from "../models/run.model.js";
import { Project } from "../models/project.model.js";
import { Category } from "../models/category.model.js";
import {
  buildReportHtml,
  buildReportRows,
  buildReportWorkbook,
  reportFileName,
} from "../services/report-builder.js";

export const reportsRouter = Router();

reportsRouter.get("/", async (req, res, next) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: "projectId is required" });
    const { rows } = await collectReport(projectId);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

reportsRouter.get("/export", async (req, res, next) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: "projectId is required" });

    const { rows, projectName } = await collectReport(projectId);
    const wb = buildReportWorkbook(projectName, rows);
    const filename = reportFileName(projectName);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

reportsRouter.get("/html", async (req, res, next) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: "projectId is required" });
    const { rows, projectName } = await collectReport(projectId);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(buildReportHtml(projectName, rows));
  } catch (err) {
    next(err);
  }
});

async function collectReport(projectId) {
  const [project, tests, categories] = await Promise.all([
    Project.findById(projectId),
    Test.find({ projectId }).sort({ createdAt: 1 }).lean(),
    Category.find({ projectId }).lean(),
  ]);

  const categoriesById = new Map(categories.map((c) => [String(c._id), c.name]));

  const runsByTestId = new Map();
  await Promise.all(
    tests.map(async (t) => {
      const run = await Run.findOne({ testId: t._id }).sort({ createdAt: -1 }).lean();
      if (run) runsByTestId.set(String(t._id), run);
    }),
  );

  const rows = await buildReportRows(
    tests.map((t) => ({ ...t, id: String(t._id) })),
    runsByTestId,
    categoriesById,
  );
  return { rows, projectName: project?.name || "project" };
}
