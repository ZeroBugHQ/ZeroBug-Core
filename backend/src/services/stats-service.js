import { Test } from "../models/test.model.js";
import { Run } from "../models/run.model.js";
import { Usage } from "../models/usage.model.js";
import { config } from "../config.js";
import { listModels, resolveAvailableModel } from "./ollama.js";

export function computeOutcomes(tests) {
  const counts = { queued: 0, running: 0, passed: 0, failed: 0 };
  let durSum = 0;
  let durCount = 0;
  for (const t of tests) {
    if (t.status in counts) counts[t.status] += 1;
    if (Number.isFinite(t.durationMs) && t.durationMs > 0) {
      durSum += t.durationMs;
      durCount += 1;
    }
  }
  const finished = counts.passed + counts.failed;
  return {
    ...counts,
    total: tests.length,
    passRate: finished ? Math.round((counts.passed / finished) * 100) : 0,
    avgDurationMs: durCount ? Math.round(durSum / durCount) : 0,
  };
}

export function topSlowest(tests, n = 5) {
  return tests
    .filter((t) => Number.isFinite(t.durationMs) && t.durationMs > 0)
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, n)
    .map((t) => ({ code: t.code, title: t.title, durationMs: t.durationMs }));
}

export function topFailing(failCounts, testsById, n = 5) {
  return failCounts
    .map((f) => {
      const t = testsById.get(String(f.testId));
      return t ? { code: t.code, title: t.title, fails: f.fails } : null;
    })
    .filter(Boolean)
    .slice(0, n);
}

export async function collectPassRateHistory(projectId, days = 30) {
  // Build one bucket per calendar day for the last `days` days.
  const now = new Date();
  const since = new Date(now);
  since.setDate(since.getDate() - days + 1);
  since.setHours(0, 0, 0, 0);

  // Fetch all finished runs in the window for this project's tests.
  const tests = await Test.find({ projectId }, { _id: 1 }).lean();
  const testIds = tests.map((t) => t._id);

  const runs = await Run.find({
    testId: { $in: testIds },
    status: { $in: ["passed", "failed"] },
    finishedAt: { $gte: since },
  })
    .select("status finishedAt")
    .lean();

  // Build a map keyed by "YYYY-MM-DD" → { passed, failed }.
  const buckets = {};
  for (let d = 0; d < days; d++) {
    const day = new Date(since);
    day.setDate(day.getDate() + d);
    const key = day.toISOString().slice(0, 10);
    buckets[key] = { date: key, passed: 0, failed: 0, total: 0, passRate: 0 };
  }

  for (const run of runs) {
    const key = new Date(run.finishedAt).toISOString().slice(0, 10);
    if (!buckets[key]) continue;
    buckets[key].total += 1;
    if (run.status === "passed") buckets[key].passed += 1;
    else buckets[key].failed += 1;
  }

  // Compute pass-rate per day.
  for (const bucket of Object.values(buckets)) {
    bucket.passRate = bucket.total > 0 ? Math.round((bucket.passed / bucket.total) * 100) : null;
  }

  return Object.values(buckets);
}

export async function collectStats(projectId) {
  const [tests, usageDoc, models] = await Promise.all([
    Test.find({ projectId }).lean(),
    Usage.findOne({ projectId }).lean(),
    listModels(),
  ]);

  const selectedModel =
    config.modelProvider === "anthropic" ? config.anthropicCodeModel : config.ollamaCodeModel;
  const resolvedModel = await resolveAvailableModel(selectedModel, selectedModel);
  const testsById = new Map(tests.map((t) => [String(t._id), t]));
  const failAgg = await Run.aggregate([
    { $match: { testId: { $in: tests.map((t) => t._id) }, status: "failed" } },
    { $group: { _id: "$testId", fails: { $sum: 1 } } },
    { $sort: { fails: -1 } },
    { $limit: 5 },
  ]);
  const failCounts = failAgg.map((f) => ({ testId: f._id, fails: f.fails }));
  const modelNames = new Set(models.map((model) => model.name));

  return {
    usage: {
      promptTokens: usageDoc?.promptTokens ?? 0,
      responseTokens: usageDoc?.responseTokens ?? 0,
      totalTokens: (usageDoc?.promptTokens ?? 0) + (usageDoc?.responseTokens ?? 0),
      requests: usageDoc?.requests ?? 0,
      toolRequests: usageDoc?.toolRequests ?? 0,
      toolCalls: usageDoc?.toolCalls ?? {},
    },
    outcomes: computeOutcomes(tests),
    slowest: topSlowest(tests),
    failing: topFailing(failCounts, testsById),
    model: {
      name: selectedModel,
      resolved: resolvedModel,
      provider: config.modelProvider,
      reachable: models.length > 0,
      selectedAvailable: modelNames.has(selectedModel),
      availableCount: models.length,
    },
  };
}
