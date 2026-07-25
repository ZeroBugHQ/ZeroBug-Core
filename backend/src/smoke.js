// Lightweight smoke test: boots the app on an ephemeral port and exercises the
// project lifecycle + scoped read routes + health. Requires MongoDB; Ollama and
// Playwright are only needed for run/generate/chat, which this script skips.
import { createApp } from "./server.js";
import { connectDb } from "./db.js";
import { deleteProject } from "./services/project-service.js";
import mongoose from "mongoose";

const PORT = 4555;

async function main() {
  try {
    await connectDb();
  } catch (err) {
    console.error("✗ Mongo connection failed:", err.message);
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(PORT);
  const base = `http://localhost:${PORT}`;
  let failures = 0;
  let projectId;

  const json = (path, init) =>
    fetch(base + path, init).then(async (r) => ({
      ok: r.ok,
      status: r.status,
      body: await r.json(),
    }));
  const check = (name, ok, info) => {
    console.log(`${ok ? "✓" : "✗"} ${name}`, info ?? "");
    if (!ok) failures++;
  };

  const health = await json("/api/health");
  check("health", health.ok, health.body);

  const created = await json("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Smoke Project" }),
  });
  projectId = created.body.id;
  check("create project", created.ok && !!projectId, projectId);

  const cols = await json(`/api/projects/${projectId}/columns`);
  check("system columns created", cols.ok && cols.body.length === 4, `${cols.body.length} columns`);

  const tests = await json(`/api/tests?projectId=${projectId}`);
  check("list tests (scoped)", tests.ok, `${tests.body.length} items`);

  const envs = await json("/api/environments");
  check("list environments (global)", envs.ok, `${envs.body.length} items`);

  const reports = await json(`/api/reports?projectId=${projectId}`);
  check("list reports (scoped)", reports.ok, `${reports.body.length} items`);

  // Clean up the smoke project so we don't leave junk behind.
  if (projectId) await deleteProject(projectId);
  check("cleanup project", true);

  server.close();
  await mongoose.disconnect();
  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

main();
