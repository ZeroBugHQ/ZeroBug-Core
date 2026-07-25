import { Usage } from "../models/usage.model.js";

// Recording usage must never break a run/chat — all failures are swallowed.

export async function recordTokens(projectId, { promptTokens = 0, responseTokens = 0 } = {}) {
  if (!projectId || (!promptTokens && !responseTokens)) return;
  await Usage.findOneAndUpdate(
    { projectId },
    { $inc: { promptTokens, responseTokens, requests: 1 } },
    { upsert: true },
  ).catch(() => {});
}

export async function recordToolCall(projectId, name) {
  if (!projectId || !name) return;
  // Mongo map keys can't contain "." or "$".
  const key = String(name).replace(/[.$]/g, "_");
  await Usage.findOneAndUpdate(
    { projectId },
    { $inc: { [`toolCalls.${key}`]: 1, toolRequests: 1 } },
    { upsert: true },
  ).catch(() => {});
}
