import { Router } from "express";
import {
  Project,
  DEFAULT_ENVIRONMENT_KINDS,
  MAX_ENVIRONMENT_KINDS,
} from "../models/project.model.js";
import { Column } from "../models/column.model.js";
import { Category } from "../models/category.model.js";
import { Test } from "../models/test.model.js";
import { Environment } from "../models/environment.model.js";
import { createProject, deleteProject, systemColumn } from "../services/project-service.js";
import { exportProject, importProject } from "../services/export-import-service.js";
import { generateTestSuite, resolveAvailableModel } from "../services/ollama.js";
import { explorePage } from "../services/playwright-runner.js";
import { getSecretMap } from "../services/secret-service.js";
import { sessionPath, sessionExists, ensureSessionDir } from "../services/session-store.js";
import { openSse, sendEvent, closeSse } from "../lib/sse.js";
import { recordAudit } from "../services/audit-service.js";

export const projectsRouter = Router();

// Import a project from an export snapshot (creates a new project). Declared
// before "/:id" routes so "import" isn't captured as an id.
projectsRouter.post("/import", async (req, res, next) => {
  try {
    const result = await importProject(req.body);
    recordAudit("project.import", `Imported "${result?.project?.name ?? "project"}"`, result?.project?.id);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// Normalise a kind label: trimmed, lowercased, spaces collapsed to hyphens.
function normalizeKind(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

// Existing projects created before kinds existed have no list yet — fall back
// to the defaults so the UI always has something to show.
function kindsOf(project) {
  return project.environmentKinds?.length
    ? project.environmentKinds
    : [...DEFAULT_ENVIRONMENT_KINDS];
}

projectsRouter.get("/", async (_req, res, next) => {
  try {
    const projects = await Project.find().sort({ createdAt: 1 });
    res.json(projects.map((p) => p.toJSON()));
  } catch (err) {
    next(err);
  }
});

projectsRouter.post("/", async (req, res, next) => {
  try {
    if (!req.body?.name?.trim()) return res.status(400).json({ error: "A name is required." });
    const project = await createProject({
      name: req.body.name.trim(),
      description: req.body.description ?? "",
    });
    recordAudit("project.create", `Created "${project.name}"`, project.id);
    res.status(201).json(project.toJSON());
  } catch (err) {
    next(err);
  }
});

projectsRouter.patch("/:id", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const update = {};
    if ("name" in body) update.name = body.name;
    if ("description" in body) update.description = body.description;
    if ("alertPassRateThreshold" in body)
      update.alertPassRateThreshold = Math.max(0, Math.min(100, Number(body.alertPassRateThreshold) || 0));
    if ("alertOnCriticalFail" in body) update.alertOnCriticalFail = !!body.alertOnCriticalFail;
    const project = await Project.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json(project.toJSON());
  } catch (err) {
    next(err);
  }
});

projectsRouter.delete("/:id", async (req, res, next) => {
  try {
    await deleteProject(req.params.id);
    recordAudit("project.delete", `Deleted project ${req.params.id}`, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Generate a suite of tests from a prompt/URL via the agent model. Streams live
// progress + screenshots over SSE (especially while exploring the live app).
projectsRouter.post("/:id/generate-suite", async (req, res) => {
  openSse(res);
  const send = (type, data = {}) => sendEvent(res, type, { type, ...data });
  let aborted = false;
  const abort = new AbortController();
  res.on("close", () => {
    aborted = true;
    abort.abort();
  });

  try {
    const prompt = String(req.body?.prompt ?? "").trim();
    const explore = req.body?.explore === true;
    const images =
      Array.isArray(req.body?.images) && req.body.images.length
        ? req.body.images.filter((s) => typeof s === "string").slice(0, 5)
        : undefined;
    if (!prompt && !explore && !images) {
      send("error", { message: "A prompt, reference image, or exploration is required." });
      return closeSse(res);
    }
    const project = await Project.findById(req.params.id).lean();
    if (!project) {
      send("error", { message: "Project not found" });
      return closeSse(res);
    }

    const model = await resolveAvailableModel();

    // Optionally explore the live app first (log in, look around) so the tests
    // are grounded in the real pages. Best-effort — never blocks generation.
    let pageContext = "";
    if (explore) {
      const environment =
        (await Environment.findOne({ active: true }).lean()) ??
        (await Environment.findOne({}).lean());
      if (environment?.url) {
        const envId = String(environment._id);
        const catId = req.body?.categoryId || null;
        const sessionKey = catId ? `${envId}__${catId}` : envId;
        const [secrets, hasSession] = await Promise.all([
          getSecretMap(envId).catch(() => ({})),
          sessionExists(sessionKey).catch(() => false),
        ]);
        await ensureSessionDir().catch(() => {});
        send("progress", { message: `Exploring ${environment.name || "the app"}…` });
        const explored = await explorePage({
          environment,
          secrets,
          storageStateLoad: hasSession ? sessionPath(sessionKey) : undefined,
          savedLogin: environment.loginInstructions || "",
          model,
          signal: abort.signal,
          onEvent: (e) => !aborted && send(e.type, e),
        }).catch((err) => ({ pageMap: "", ok: false, error: err.message }));
        pageContext = explored.pageMap || "";
        if (!explored.ok) {
          send("progress", {
            message: `Exploration was limited (${explored.error || "partial"}) — generating from what was seen.`,
          });
        }
      } else {
        send("progress", { message: "No active environment URL — skipping exploration." });
      }
    }
    if (aborted) return closeSse(res);

    send("progress", { message: "Writing the test suite…" });
    const specs = await generateTestSuite({ prompt, model, pageContext, images });
    if (!specs.length) {
      send("error", { message: "The model returned no usable tests. Is Ollama running?" });
      return closeSse(res);
    }

    // Resolve the category: an existing categoryId, or a new one from categoryName.
    let categoryId = req.body?.categoryId || null;
    const categoryName = String(req.body?.categoryName ?? "").trim();
    if (!categoryId && categoryName) {
      const max = await Category.findOne({ projectId: req.params.id }).sort({ order: -1 });
      const category = await Category.create({
        projectId: req.params.id,
        name: categoryName,
        order: (max?.order ?? -1) + 1,
      });
      categoryId = category._id;
    }

    const queued = await systemColumn(req.params.id, "queued");
    const created = [];
    for (const s of specs) {
      const prefix = (s.suite || "GEN").slice(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, "") || "GEN";
      const test = await Test.create({
        projectId: req.params.id,
        columnId: queued?._id,
        categoryId: categoryId || undefined,
        status: "queued",
        code: `${prefix}-${Math.floor(Math.random() * 900 + 100)}`,
        title: s.title,
        suite: s.suite,
        description: "Generated by ZeroBug.",
        steps: s.steps.length ? s.steps : undefined,
        priority: s.priority,
        mode: "ui",
        assertionTypes: ["functional"],
        estMs: 1800 + s.steps.length * 400,
      });
      created.push(test.toJSON());
    }
    recordAudit("suite.generate", `Generated ${created.length} test(s)`, req.params.id);
    send("done", { created: created.length });
  } catch (err) {
    send("error", { message: err.message });
  } finally {
    closeSse(res);
  }
});

// Download a portable JSON snapshot of a project.
projectsRouter.get("/:id/export", async (req, res, next) => {
  try {
    const snapshot = await exportProject(req.params.id);
    const slug =
      (snapshot.project?.name || "project").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
      "project";
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="zerobug-project-${slug}.json"`);
    res.send(JSON.stringify(snapshot, null, 2));
  } catch (err) {
    next(err);
  }
});

// ---- Environment kinds (nested under a project) ----

projectsRouter.get("/:id/kinds", async (req, res, next) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json(kindsOf(project));
  } catch (err) {
    next(err);
  }
});

projectsRouter.post("/:id/kinds", async (req, res, next) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const kind = normalizeKind(req.body?.kind);
    if (!kind) return res.status(400).json({ error: "A kind is required." });

    const kinds = kindsOf(project);
    if (kinds.includes(kind)) return res.json(kinds); // already there — idempotent
    if (kinds.length >= MAX_ENVIRONMENT_KINDS) {
      return res.status(400).json({ error: `At most ${MAX_ENVIRONMENT_KINDS} kinds are allowed.` });
    }

    project.environmentKinds = [...kinds, kind];
    await project.save();
    res.status(201).json(project.environmentKinds);
  } catch (err) {
    next(err);
  }
});

projectsRouter.delete("/:id/kinds/:kind", async (req, res, next) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const kind = normalizeKind(req.params.kind);
    project.environmentKinds = kindsOf(project).filter((k) => k !== kind);
    await project.save();
    res.json(project.environmentKinds);
  } catch (err) {
    next(err);
  }
});

// ---- Columns (nested under a project) ----

projectsRouter.get("/:id/columns", async (req, res, next) => {
  try {
    const columns = await Column.find({ projectId: req.params.id }).sort({ order: 1 });
    res.json(columns.map((c) => c.toJSON()));
  } catch (err) {
    next(err);
  }
});

projectsRouter.post("/:id/columns", async (req, res, next) => {
  try {
    if (!req.body?.title?.trim()) return res.status(400).json({ error: "A title is required." });
    const max = await Column.findOne({ projectId: req.params.id }).sort({ order: -1 });
    const column = await Column.create({
      projectId: req.params.id,
      title: req.body.title.trim(),
      systemKey: null,
      order: (max?.order ?? -1) + 1,
    });
    res.status(201).json(column.toJSON());
  } catch (err) {
    next(err);
  }
});

// ---- Categories (nested under a project) ----

projectsRouter.get("/:id/categories", async (req, res, next) => {
  try {
    const categories = await Category.find({ projectId: req.params.id }).sort({ order: 1, createdAt: 1 });
    res.json(categories.map((c) => c.toJSON()));
  } catch (err) {
    next(err);
  }
});

projectsRouter.post("/:id/categories", async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "A name is required." });
    const max = await Category.findOne({ projectId: req.params.id }).sort({ order: -1 });
    const category = await Category.create({
      projectId: req.params.id,
      name,
      order: (max?.order ?? -1) + 1,
    });
    res.status(201).json(category.toJSON());
  } catch (err) {
    next(err);
  }
});

export const categoriesRouter = Router();

categoriesRouter.patch("/:id", async (req, res, next) => {
  try {
    const update = {};
    if ("name" in (req.body ?? {})) update.name = String(req.body.name ?? "").trim();
    if ("order" in (req.body ?? {})) update.order = Number(req.body.order) || 0;
    if (update.name === "") return res.status(400).json({ error: "A name is required." });
    const category = await Category.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!category) return res.status(404).json({ error: "Category not found" });
    res.json(category.toJSON());
  } catch (err) {
    next(err);
  }
});

// Delete a category; its tests become Uncategorized (categoryId cleared).
categoriesRouter.delete("/:id", async (req, res, next) => {
  try {
    const category = await Category.findById(req.params.id);
    if (!category) return res.status(404).json({ error: "Category not found" });
    await Test.updateMany({ categoryId: category._id }, { $unset: { categoryId: "" } });
    await category.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export const columnsRouter = Router();

columnsRouter.patch("/:id", async (req, res, next) => {
  try {
    const update = {};
    if ("title" in (req.body ?? {})) update.title = req.body.title;
    if ("order" in (req.body ?? {})) update.order = req.body.order;
    const column = await Column.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!column) return res.status(404).json({ error: "Column not found" });
    res.json(column.toJSON());
  } catch (err) {
    next(err);
  }
});

// Delete a custom column; its tests move to the project's queued column.
columnsRouter.delete("/:id", async (req, res, next) => {
  try {
    const column = await Column.findById(req.params.id);
    if (!column) return res.status(404).json({ error: "Column not found" });
    if (column.systemKey)
      return res.status(400).json({ error: "System columns cannot be deleted." });

    const queued = await Column.findOne({ projectId: column.projectId, systemKey: "queued" });
    await Test.updateMany(
      { columnId: column._id },
      { columnId: queued?._id, status: "queued", $unset: { durationMs: "", failureReason: "" } },
    );
    await column.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
