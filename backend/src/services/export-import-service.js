import { Project } from "../models/project.model.js";
import { Column } from "../models/column.model.js";
import { Test } from "../models/test.model.js";
import { Schedule } from "../models/schedule.model.js";
import { Environment } from "../models/environment.model.js";
import { createProject } from "./project-service.js";

export const EXPORT_VERSION = 1;

// Test fields that are portable (run history/state is intentionally excluded).
const TEST_FIELDS = [
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
  "maxRetries",
  "mode",
  "assertionTypes",
  "apiConfig",
];

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj[f] !== undefined && obj[f] !== null) out[f] = obj[f];
  return out;
}

/**
 * Build a portable JSON snapshot of a project. Pure — takes plain objects.
 */
export function buildProjectExport({ project, columns, tests, schedules, environments, exportedAt }) {
  const colTitleById = new Map(columns.map((c) => [String(c.id ?? c._id), c.title]));
  return {
    version: EXPORT_VERSION,
    exportedAt: exportedAt ?? null,
    project: pick(project, [
      "name",
      "description",
      "environmentKinds",
      "agentModel",
      "alertPassRateThreshold",
      "alertOnCriticalFail",
    ]),
    columns: columns
      .filter((c) => !c.systemKey)
      .map((c) => ({ title: c.title, order: c.order ?? 5 })),
    tests: tests.map((t) => ({
      ...pick(t, TEST_FIELDS),
      columnTitle: colTitleById.get(String(t.columnId)) ?? null,
    })),
    schedules: (schedules ?? []).map((s) =>
      pick(s, ["name", "cron", "suite", "callbackUrl", "maxRetries", "enabled"]),
    ),
    environments: (environments ?? []).map((e) => pick(e, ["name", "url", "kind", "active"])),
  };
}

export async function exportProject(projectId) {
  const [project, columns, tests, schedules, environments] = await Promise.all([
    Project.findById(projectId).lean(),
    Column.find({ projectId }).lean(),
    Test.find({ projectId }).lean(),
    Schedule.find({ projectId }).lean(),
    Environment.find({}).lean(),
  ]);
  if (!project) throw new Error("Project not found");
  return buildProjectExport({
    project,
    columns: columns.map((c) => ({ ...c, id: String(c._id) })),
    tests: tests.map((t) => ({ ...t, columnId: t.columnId ? String(t.columnId) : null })),
    schedules,
    environments,
    exportedAt: new Date().toISOString(),
  });
}

/**
 * Create a NEW project from an export snapshot. Tests come in fresh (queued, no
 * run history); custom-column placement is preserved by title.
 */
export async function importProject(data) {
  if (!data || typeof data !== "object") throw new Error("Invalid import payload");
  const meta = data.project ?? {};
  const project = await createProject({
    name: (meta.name || "Imported project").trim(),
    description: meta.description || "",
  });

  await Project.findByIdAndUpdate(project._id, {
    ...(Array.isArray(meta.environmentKinds) ? { environmentKinds: meta.environmentKinds } : {}),
    ...(meta.agentModel ? { agentModel: meta.agentModel } : {}),
    ...(meta.alertPassRateThreshold != null
      ? { alertPassRateThreshold: meta.alertPassRateThreshold }
      : {}),
    ...(meta.alertOnCriticalFail != null ? { alertOnCriticalFail: meta.alertOnCriticalFail } : {}),
  });

  // Custom columns (system ones already exist from createProject).
  for (const c of data.columns ?? []) {
    if (!c?.title) continue;
    await Column.create({ projectId: project._id, title: c.title, systemKey: null, order: c.order ?? 5 });
  }
  const cols = await Column.find({ projectId: project._id }).lean();
  const customByTitle = new Map(cols.filter((c) => !c.systemKey).map((c) => [c.title, c._id]));
  const queuedId = cols.find((c) => c.systemKey === "queued")?._id;

  let imported = 0;
  for (const t of data.tests ?? []) {
    if (!t?.title || !t?.code) continue;
    const columnId = customByTitle.get(t.columnTitle) ?? queuedId;
    await Test.create({
      ...pick(t, TEST_FIELDS),
      projectId: project._id,
      columnId,
      status: "queued",
    });
    imported += 1;
  }

  for (const s of data.schedules ?? []) {
    if (!s?.name || !s?.cron) continue;
    await Schedule.create({
      projectId: project._id,
      name: s.name,
      cron: s.cron,
      suite: s.suite || "",
      callbackUrl: s.callbackUrl || "",
      maxRetries: Math.max(0, Number(s.maxRetries) || 0),
      enabled: s.enabled !== false,
    });
  }

  // Global environments — create any whose name doesn't already exist.
  for (const e of data.environments ?? []) {
    if (!e?.name || !e?.url) continue;
    const exists = await Environment.findOne({ name: e.name });
    if (!exists) {
      await Environment.create({ name: e.name, url: e.url, kind: e.kind || "staging", active: e.active !== false });
    }
  }

  return { project: project.toJSON(), importedTests: imported };
}
