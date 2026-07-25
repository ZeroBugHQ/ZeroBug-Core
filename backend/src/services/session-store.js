import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

// Persisted Playwright storageState (cookies + localStorage) per environment, so
// a logged-in session can be reused across runs. Stored in the PRIVATE data dir
// (never the publicly-served artifacts dir) since it contains auth cookies.
function sanitize(id) {
  return String(id ?? "").replace(/[^a-zA-Z0-9._-]+/g, "-") || "env";
}

function sessionsDir() {
  return path.join(config.dataDir, "sessions");
}

export function sessionPath(environmentId) {
  return path.join(sessionsDir(), `${sanitize(environmentId)}.json`);
}

export async function ensureSessionDir() {
  await fs.mkdir(sessionsDir(), { recursive: true });
}

export async function sessionExists(environmentId) {
  if (!environmentId) return false;
  try {
    await fs.access(sessionPath(environmentId));
    return true;
  } catch {
    return false;
  }
}

export async function clearSession(environmentId) {
  try {
    await fs.unlink(sessionPath(environmentId));
    return true;
  } catch {
    return false;
  }
}
