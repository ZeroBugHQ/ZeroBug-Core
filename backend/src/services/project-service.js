import { Project } from "../models/project.model.js";
import { Column, SYSTEM_COLUMNS } from "../models/column.model.js";
import { Test } from "../models/test.model.js";
import { Environment } from "../models/environment.model.js";
import { Report } from "../models/report.model.js";

/** Create a project and its four system columns. Returns the project. */
export async function createProject({ name, description }) {
  const project = await Project.create({ name, description });
  await Column.insertMany(SYSTEM_COLUMNS.map((c) => ({ ...c, projectId: project._id })));
  return project;
}

/** Delete a project and everything scoped to it. */
export async function deleteProject(projectId) {
  await Promise.all([
    Test.deleteMany({ projectId }),
    Environment.deleteMany({ projectId }),
    Report.deleteMany({ projectId }),
    Column.deleteMany({ projectId }),
  ]);
  await Project.findByIdAndDelete(projectId);
}

/** Find a project's column carrying a given systemKey (queued/running/passed/failed). */
export function systemColumn(projectId, systemKey) {
  return Column.findOne({ projectId, systemKey });
}

/**
 * On a brand-new install (no projects), seed a demo project with a few sample
 * tests so the board isn't empty. No-op once any project exists.
 * @returns the created project, or null
 */
export async function ensureSampleProject() {
  const count = await Project.estimatedDocumentCount();
  if (count > 0) return null;
  const project = await createProject({
    name: "Sample Project",
    description: "A demo project to explore ZeroBug — edit or delete these tests anytime.",
  });
  const queued = await systemColumn(project._id, "queued");
  const samples = [
    {
      code: "DEMO-1",
      title: "Homepage loads",
      suite: "Smoke",
      description: "The homepage renders without errors and the main heading is visible.",
      steps: ["Open the home page", "Assert the main heading is visible"],
      tags: ["smoke"],
      priority: "high",
    },
    {
      code: "DEMO-2",
      title: "Search returns results",
      suite: "Search",
      description: "Searching for a known term shows matching results.",
      steps: ["Open the home page", "Search for a known term", "Assert results are shown"],
      tags: ["smoke"],
    },
    {
      code: "DEMO-3",
      title: "API health check",
      suite: "API",
      mode: "api",
      description: "The health endpoint returns HTTP 200.",
      apiConfig: { method: "GET", url: "https://example.com", expectedStatus: 200 },
    },
  ];
  await Test.insertMany(
    samples.map((s) => ({ ...s, projectId: project._id, columnId: queued?._id, status: "queued" })),
  );
  return project;
}

/**
 * Ensure at least one (global) environment exists, so the run target picker is
 * always populated. Environments are shared across projects.
 * @returns number of environments created (0 or 1)
 */
export async function ensureDefaultEnvironment() {
  const count = await Environment.estimatedDocumentCount();
  if (count > 0) return 0;
  await Environment.create({ name: "Local", url: "http://localhost:3000", kind: "dev", active: true });
  return 1;
}
