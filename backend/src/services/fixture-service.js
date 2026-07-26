import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

// Bundled, read-only upload fixtures shipped with the runner. Small, valid
// sample files the uploadFile action can attach without any test authoring.
const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures");

// Logical names the model may use in an uploadFile action, mapped to bundled
// files. Aliases ("image"/"text") point at the same file as their canonical name.
const LIBRARY = {
  pdf: "sample.pdf",
  png: "sample.png",
  image: "sample.png",
  csv: "sample.csv",
  txt: "sample.txt",
  text: "sample.txt",
};

const LIBRARY_FILES = new Set(Object.values(LIBRARY));

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a fixture reference to an absolute file path for uploadFile.
 * Priority:
 *   1. A test-attached fixture (dataDir/fixtures/<testId>/<name>), matched by
 *      exact filename — lets a test supply content-specific files (e.g. a CSV
 *      whose parsing is under test).
 *   2. The bundled library, by logical name ("pdf"/"csv"/…) OR exact filename.
 * Throws a clear, actionable error if neither matches, so the step fails legibly
 * instead of uploading nothing.
 */
export async function resolveFixture(name, { testId } = {}) {
  if (!name || typeof name !== "string") {
    throw new Error(
      `uploadFile needs a "fixture" name — one of: ${fixtureNames().join(", ")}, or a file attached to this test.`,
    );
  }
  const trimmed = name.trim();

  // 1. Test-attached (exact filename) wins.
  if (testId) {
    const attached = path.join(config.dataDir, "fixtures", String(testId), trimmed);
    if (await exists(attached)) return attached;
  }

  // 2. Bundled library: logical name first, then exact filename.
  const libFile = LIBRARY[trimmed.toLowerCase()] ?? (LIBRARY_FILES.has(trimmed) ? trimmed : null);
  if (libFile) {
    const p = path.join(FIXTURES_DIR, libFile);
    if (await exists(p)) return p;
  }

  throw new Error(
    `Unknown fixture "${trimmed}". Use one of: ${fixtureNames().join(", ")}, or a file attached to this test.`,
  );
}

// Distinct logical names offered by the bundled library (for prompts + errors).
export function fixtureNames() {
  return [...new Set(Object.keys(LIBRARY))];
}
