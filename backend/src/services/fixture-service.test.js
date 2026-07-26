// Unit tests for fixture resolution. Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { config } from "../config.js";
import { resolveFixture, fixtureNames } from "./fixture-service.js";

test("resolves bundled fixtures by logical name", async () => {
  for (const name of ["pdf", "png", "csv", "txt"]) {
    const p = await resolveFixture(name);
    assert.ok(p.endsWith(`sample.${name === "png" ? "png" : name}`) || p.includes("sample."));
    await fs.access(p); // exists on disk
  }
});

test("aliases image->png and text->txt resolve to the same files", async () => {
  assert.equal(await resolveFixture("image"), await resolveFixture("png"));
  assert.equal(await resolveFixture("text"), await resolveFixture("txt"));
});

test("resolves bundled fixture by exact filename too", async () => {
  const p = await resolveFixture("sample.csv");
  assert.ok(p.endsWith("sample.csv"));
});

test("is case-insensitive on logical names", async () => {
  assert.equal(await resolveFixture("PDF"), await resolveFixture("pdf"));
});

test("unknown fixture name throws a clear, actionable error", async () => {
  await assert.rejects(() => resolveFixture("spreadsheet"), /Unknown fixture "spreadsheet".*Use one of/s);
});

test("missing/empty fixture name throws asking for one", async () => {
  await assert.rejects(() => resolveFixture(""), /needs a "fixture" name/);
  await assert.rejects(() => resolveFixture(undefined), /needs a "fixture" name/);
});

test("a test-attached fixture takes priority over the bundled library", async () => {
  // Point dataDir at a temp dir and drop an attached file named "sample.csv"
  // with distinctive content, for a fake testId.
  const origDataDir = config.dataDir;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "zb-fix-"));
  try {
    config.dataDir = tmp;
    const testId = "test123";
    const dir = path.join(tmp, "fixtures", testId);
    await fs.mkdir(dir, { recursive: true });
    const attached = path.join(dir, "sample.csv");
    await fs.writeFile(attached, "ATTACHED-OVERRIDE\n");

    const resolved = await resolveFixture("sample.csv", { testId });
    assert.equal(resolved, attached, "attached file resolved, not the bundled one");
    assert.equal(await fs.readFile(resolved, "utf8"), "ATTACHED-OVERRIDE\n");

    // Without the testId, the same name falls back to the bundled library.
    const bundled = await resolveFixture("sample.csv");
    assert.notEqual(bundled, attached);
  } finally {
    config.dataDir = origDataDir;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("fixtureNames lists the distinct logical names for prompts/errors", () => {
  const names = fixtureNames();
  for (const n of ["pdf", "png", "csv", "txt"]) assert.ok(names.includes(n));
});
