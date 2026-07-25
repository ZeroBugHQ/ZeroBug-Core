import { Test } from "../models/test.model.js";
import { Run } from "../models/run.model.js";

const FLAKY_WINDOW = 8; // consider the last N runs
const SLOWER_RATIO = 1.25; // 25% slower counts as a regression

// ---- Pure helpers (unit-tested) --------------------------------------------

/** A test is flaky if its recent runs contain BOTH a pass and a fail. */
export function detectFlaky(recentRuns) {
  let passes = 0;
  let fails = 0;
  for (const r of recentRuns) {
    if (r.status === "passed") passes += 1;
    else if (r.status === "failed") fails += 1;
  }
  return { flaky: passes > 0 && fails > 0, passes, fails };
}

/** Classify the change between the previous and latest run of a test. */
export function classifyDiff(prev, last) {
  if (!last || !prev) return null;
  if (prev.status === "passed" && last.status === "failed") return "newlyFailed";
  if (prev.status === "failed" && last.status === "passed") return "newlyPassed";
  if (
    prev.status === "passed" &&
    last.status === "passed" &&
    prev.durationMs > 0 &&
    last.durationMs > prev.durationMs * SLOWER_RATIO
  ) {
    return "slower";
  }
  return "same";
}

// ---- DB-backed collection ---------------------------------------------------

export async function collectInsights(projectId) {
  const tests = await Test.find({ projectId }).select("_id code title").lean();
  const byId = new Map(tests.map((t) => [String(t._id), t]));
  const ids = tests.map((t) => t._id);

  const grouped = await Run.aggregate([
    { $match: { testId: { $in: ids } } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$testId",
        runs: { $push: { status: "$status", durationMs: "$durationMs" } },
      },
    },
  ]);

  const flaky = [];
  const diff = { newlyFailed: [], newlyPassed: [], slower: [] };

  for (const g of grouped) {
    const test = byId.get(String(g._id));
    if (!test) continue;
    const runs = g.runs.slice(0, FLAKY_WINDOW);

    const f = detectFlaky(runs);
    if (f.flaky) flaky.push({ code: test.code, title: test.title, passes: f.passes, fails: f.fails });

    const kind = classifyDiff(runs[1], runs[0]);
    if (kind === "newlyFailed")
      diff.newlyFailed.push({ code: test.code, title: test.title });
    else if (kind === "newlyPassed")
      diff.newlyPassed.push({ code: test.code, title: test.title });
    else if (kind === "slower")
      diff.slower.push({
        code: test.code,
        title: test.title,
        prevMs: runs[1].durationMs,
        lastMs: runs[0].durationMs,
      });
  }

  return { flaky, diff };
}

/**
 * Recompute and persist a single test's flaky flag from its recent run history.
 * Called after each run; cheap and isolated.
 */
export async function refreshFlakyFlag(testId) {
  const recent = await Run.find({ testId }).sort({ createdAt: -1 }).limit(FLAKY_WINDOW).select("status").lean();
  const { flaky } = detectFlaky(recent);
  await Test.findByIdAndUpdate(testId, { flaky }).catch(() => {});
  return flaky;
}
