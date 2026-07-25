import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

function sanitize(part) {
  return String(part ?? "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

export async function ensureArtifactDir(...parts) {
  const relativePath = parts.map(sanitize).join("/");
  const dir = path.join(config.artifactsDir, relativePath);
  await fs.mkdir(dir, { recursive: true });
  return {
    dir,
    relativePath,
    publicUrlBase: `/artifacts/${relativePath}`,
  };
}

export async function writeArtifact(relativeDir, fileName, contents) {
  const safeFile = sanitize(fileName);
  const dir = path.join(config.artifactsDir, relativeDir);
  await fs.mkdir(dir, { recursive: true });
  const fullPath = path.join(dir, safeFile);
  await fs.writeFile(fullPath, contents);
  return {
    path: fullPath,
    url: `/artifacts/${relativeDir}/${safeFile}`.replace(/\\/g, "/"),
  };
}

export function baselinePathForTest(testId) {
  const relativeDir = `baselines/${sanitize(testId)}`;
  return {
    relativeDir,
    absolutePath: path.join(config.artifactsDir, relativeDir, "baseline.png"),
    publicUrl: `/artifacts/${relativeDir}/baseline.png`,
  };
}

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
