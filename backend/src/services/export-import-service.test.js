// Unit tests for the pure export builder. Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProjectExport, EXPORT_VERSION } from "./export-import-service.js";

const FIXTURE = {
  project: {
    name: "DVBolt",
    description: "desc",
    environmentKinds: ["dev", "prod"],
    agentModel: "llama3.1",
    alertPassRateThreshold: 80,
    alertOnCriticalFail: true,
    secretField: "should-not-appear",
  },
  columns: [
    { id: "c1", title: "Queued", systemKey: "queued", order: 0 },
    { id: "c2", title: "Backlog", systemKey: null, order: 5 },
  ],
  tests: [
    {
      code: "QB-1",
      title: "Dashboard",
      suite: "QB",
      tags: ["smoke"],
      dependsOn: ["QB-0"],
      priority: "high",
      mode: "ui",
      columnId: "c2",
      status: "passed", // run state — must be excluded
      durationMs: 1234, // must be excluded
    },
  ],
  schedules: [{ name: "Nightly", cron: "0 1 * * *", enabled: true, projectId: "x" }],
  environments: [{ name: "Local", url: "http://localhost:3000", kind: "dev", active: true }],
  exportedAt: "2026-06-20T00:00:00.000Z",
};

test("export carries version, project meta (no stray fields)", () => {
  const out = buildProjectExport(FIXTURE);
  assert.equal(out.version, EXPORT_VERSION);
  assert.equal(out.project.name, "DVBolt");
  assert.equal(out.project.alertPassRateThreshold, 80);
  assert.equal(out.project.secretField, undefined);
});

test("only custom columns are exported", () => {
  const out = buildProjectExport(FIXTURE);
  assert.deepEqual(
    out.columns.map((c) => c.title),
    ["Backlog"],
  );
});

test("tests keep portable fields + columnTitle, drop run state", () => {
  const out = buildProjectExport(FIXTURE);
  const t = out.tests[0];
  assert.equal(t.code, "QB-1");
  assert.equal(t.columnTitle, "Backlog");
  assert.deepEqual(t.dependsOn, ["QB-0"]);
  assert.equal(t.status, undefined); // excluded
  assert.equal(t.durationMs, undefined); // excluded
});

test("schedules and environments are trimmed to portable fields", () => {
  const out = buildProjectExport(FIXTURE);
  assert.equal(out.schedules[0].name, "Nightly");
  assert.equal(out.schedules[0].projectId, undefined);
  assert.equal(out.environments[0].name, "Local");
});
