import express from "express";
import cors from "cors";
import { pathToFileURL } from "node:url";
import fs from "node:fs/promises";
import { config, describeConfig } from "./config.js";
import { connectDb, isDbConnected } from "./db.js";
import { ollamaReachable } from "./services/ollama.js";
import { testsRouter } from "./routes/tests.routes.js";
import { environmentsRouter } from "./routes/environments.routes.js";
import { reportsRouter } from "./routes/reports.routes.js";
import { chatRouter } from "./routes/chat.routes.js";
import { runsRouter } from "./routes/runs.routes.js";
import { statsRouter } from "./routes/stats.routes.js";
import { projectsRouter, columnsRouter, categoriesRouter } from "./routes/projects.routes.js";
import { modelsRouter } from "./routes/models.routes.js";
import { settingsRouter } from "./routes/settings.routes.js";
import {
  automationProjectsRouter,
  schedulesRouter,
  webhooksRouter,
} from "./routes/automation.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import { auditRouter } from "./routes/audit.routes.js";
import { memoryRouter } from "./routes/memory.routes.js";
import { requireAuth } from "./services/auth-service.js";
import { reclaimOrphanRuns } from "./services/run-service.js";
import { ensureDefaultEnvironment, ensureSampleProject } from "./services/project-service.js";
import { startScheduleTicker } from "./services/schedule-service.js";
import { startHealthSampler } from "./services/environment-health.js";
import { loadSavedSettings } from "./services/settings-service.js";
import { Project } from "./models/project.model.js";
import { Test } from "./models/test.model.js";

export function createApp() {
  const app = express();
  app.use(cors({ origin: config.corsOrigin ?? true }));
  app.use(express.json({ limit: "1mb" }));
  app.use("/artifacts", express.static(config.artifactsDir));

  app.get("/api/health", async (_req, res) => {
    const ollama = await ollamaReachable();
    res.json({
      ok: true,
      mongo: isDbConnected(),
      ollama: { reachable: ollama, baseUrl: config.ollamaBaseUrl },
      notifications: {
        emailConfigured: Boolean(config.smtpHost && config.smtpFrom && config.notifyEmails.length),
        webhookConfigured: config.notifyWebhookUrls.length > 0,
      },
    });
  });

  // Auth gate is public so the client can ask whether login is needed / log in.
  app.use("/api/auth", authRouter);
  // Everything below requires auth when a shared password is configured.
  app.use("/api", requireAuth);

  app.use("/api/projects", projectsRouter);
  app.use("/api/columns", columnsRouter);
  app.use("/api/categories", categoriesRouter);
  app.use("/api/audit", auditRouter);
  app.use("/api/tests", testsRouter);
  app.use("/api/environments", environmentsRouter);
  app.use("/api/reports", reportsRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/runs", runsRouter);
  app.use("/api/stats", statsRouter);
  app.use("/api/models", modelsRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/memory", memoryRouter);
  app.use("/api/automation/projects", automationProjectsRouter);
  app.use("/api/automation/schedules", schedulesRouter);
  app.use("/api/automation/webhooks", webhooksRouter);

  app.use((err, _req, res, _next) => {
    console.error("[error]", err);
    res.status(500).json({ error: err.message ?? "Internal error" });
  });

  return app;
}

async function main() {
  // Fail loud: the secrets-encryption key MUST be provided via env. No default —
  // a predictable key in public source is equivalent to storing credentials in
  // plaintext. Refuse to start rather than silently run insecure.
  if (!process.env.ZEROBUG_SECRETS_KEY || !process.env.ZEROBUG_SECRETS_KEY.trim()) {
    console.error(
      "\n[FATAL] ZEROBUG_SECRETS_KEY is not set.\n" +
        "ZeroBug encrypts stored credentials (BYOK API keys, environment secrets) at\n" +
        "rest with this key. Running without it would use an insecure, predictable\n" +
        "key, so the server will not start.\n\n" +
        "Fix: set ZEROBUG_SECRETS_KEY to a strong random value in your environment\n" +
        "(or .env). Generate one with:\n\n" +
        "    openssl rand -base64 32\n",
    );
    process.exit(1);
  }

  let dbReady = false;

  try {
    await connectDb();
    await loadSavedSettings();
    dbReady = true;
  } catch (err) {
    console.error(
      `[db] could not connect/load settings from MongoDB (${config.mongoUri}). ` +
        "The server will start with environment/default settings, but data routes will fail until Mongo is reachable:",
      err.message,
    );
  }

  console.log("[config]", describeConfig());
  await fs.mkdir(config.artifactsDir, { recursive: true }).catch(() => {});

  const app = createApp();
  app.listen(config.port, config.host, () => {
    console.log(`[server] ZeroBug backend listening on http://${config.host}:${config.port}`);
  });

  if (!dbReady) return;

  const [projects, tests] = await Promise.all([
    Project.estimatedDocumentCount(),
    Test.estimatedDocumentCount(),
  ]);
  console.log(
    `[db] data present: ${projects} project(s), ${tests} test(s) - preserved across restarts`,
  );

  const reclaimed = await reclaimOrphanRuns().catch((err) => {
    console.error("[db] could not reclaim orphaned runs:", err.message);
    return 0;
  });
  if (reclaimed) console.log(`[db] reclaimed ${reclaimed} interrupted run(s) - marked failed`);

  const seededEnv = await ensureDefaultEnvironment().catch(() => 0);
  if (seededEnv) console.log("[db] created a default environment (Local)");

  const sample = await ensureSampleProject().catch(() => null);
  if (sample) console.log("[db] seeded a sample project");

  startScheduleTicker();
  console.log("[schedules] ticker started (evaluates every 30s)");
  startHealthSampler();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
