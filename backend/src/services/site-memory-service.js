// Persistence + orchestration for the agent's site-memory. All the trust/mining
// math lives in the pure memory-logic.js; this module is the thin layer that reads
// and writes SiteMemory and (only on failed runs) asks the model to reflect.
import { config } from "../config.js";
import { SiteMemory } from "../models/site-memory.model.js";
import { chatOnce } from "./ollama.js";
import {
  PROBATION_CONFIDENCE,
  MAX_HINTS,
  originOf,
  lessonKey,
  mineLessons,
  updateConfidence,
  corroborate,
  shouldPrune,
  formatHints,
  parseJsonSafe,
} from "./memory-logic.js";

const enabled = () => config.agentMemoryEnabled !== false;

/**
 * Retrieve the lessons to inject for a run and format them for the prompt.
 * @returns {{ ids: string[], text: string }} — ids to reinforce afterwards, text to inject.
 */
export async function getHints({ projectId, url, limit = MAX_HINTS }) {
  const origin = originOf(url);
  if (!enabled() || !projectId || !origin) return { ids: [], text: "" };
  try {
    const docs = await SiteMemory.find({ projectId, origin, status: "active" })
      .sort({ confidence: -1, uses: -1 })
      .limit(limit)
      .lean();
    return { ids: docs.map((d) => String(d._id)), text: formatHints(docs) };
  } catch {
    return { ids: [], text: "" };
  }
}

/**
 * Reinforce the lessons that were injected into a finished run: bump confidence on
 * a pass, decay on a fail, and prune any that fall through the floor.
 */
export async function reinforce({ usedLessonIds = [], passed }) {
  if (!enabled() || !usedLessonIds.length) return;
  for (const id of usedLessonIds) {
    try {
      const doc = await SiteMemory.findById(id);
      if (!doc) continue;
      doc.uses += 1;
      if (passed) doc.wins += 1;
      else doc.losses += 1;
      doc.confidence = updateConfidence(doc.confidence, passed);
      doc.lastUsedAt = new Date();
      // Record the confidence trajectory (capped) for the detail-view sparkline.
      doc.history = [
        ...(doc.history || []),
        { ts: Date.now(), confidence: doc.confidence, passed: Boolean(passed) },
      ].slice(-50);
      if (shouldPrune({ confidence: doc.confidence, uses: doc.uses })) doc.status = "pruned";
      await doc.save();
    } catch {
      /* best-effort; a bad id shouldn't break the run finish */
    }
  }
}

/**
 * Learn from a finished run: deterministically mine lessons, plus (only when the run
 * failed) one short LLM reflection pass. New lessons enter on probation; recurring
 * ones are corroborated (a small confidence bump).
 */
export async function recordLessons({ projectId, run, test, observations, model }) {
  if (!enabled() || !projectId || !run) return;
  const origin = originOf(run.output?.url || test?.startUrl || observations?.url);
  if (!origin) return;

  const candidates = mineLessons({ run, observations, origin });

  // On failure, ask the model for up to two generalizable site lessons.
  if (run.status === "failed") {
    const reflected = await reflectOnFailure({ run, test, origin, model }).catch(() => []);
    for (const lesson of reflected)
      candidates.push({ origin, kind: "note", lesson, detail: {}, source: "reflection" });
  }

  for (const cand of candidates) {
    const key = lessonKey(cand);
    try {
      const existing = await SiteMemory.findOne({ projectId, key });
      if (existing) {
        // Seeing the same lesson again is weak corroboration.
        existing.confidence = corroborate(existing.confidence);
        if (existing.status === "pruned" && existing.confidence >= PROBATION_CONFIDENCE) {
          existing.status = "active";
        }
        await existing.save();
      } else {
        await SiteMemory.create({
          projectId,
          origin: cand.origin,
          kind: cand.kind,
          lesson: cand.lesson,
          detail: cand.detail || {},
          key,
          confidence: PROBATION_CONFIDENCE,
          source: cand.source || "mined",
          sourceRunId: run.id || run._id,
        });
      }
    } catch {
      /* unique-key races / validation — skip this candidate */
    }
  }
}

/** One short model call: what generalizable thing about this SITE caused the failure? */
async function reflectOnFailure({ run, test, origin, model }) {
  const failingSteps = (run.steps || [])
    .map((s) => `${s.status === "fail" ? "❌" : "•"} ${s.label}${s.detail ? ` — ${s.detail}` : ""}`)
    .slice(-12)
    .join("\n");
  const netErrors = (run.forensics?.network || [])
    .slice(-5)
    .map((n) => `${n.method || "GET"} ${n.url} → ${n.failure || n.status}`)
    .join("\n");

  const messages = [
    {
      role: "system",
      content:
        "You analyze a failed browser test run and extract at most TWO concise, GENERALIZABLE lessons " +
        "about the WEBSITE (not this one test) that would help a future run avoid the same problem — " +
        "e.g. a blocking modal, a login quirk, a slow-loading area, a flaky feature. Skip anything " +
        "specific to this test's data. If there is no useful site-level lesson, return an empty list. " +
        'Respond as JSON: {"lessons": ["...", "..."]}. Each lesson under 160 characters, imperative voice.',
    },
    {
      role: "user",
      content: `SITE: ${origin}
TEST GOAL: ${test?.title || ""} — ${test?.description || ""}
FAILURE REASON: ${run.failureReason || "(none)"}

STEPS:
${failingSteps || "(none)"}

NETWORK ERRORS:
${netErrors || "(none)"}`,
    },
  ];

  const res = await chatOnce({ messages, model, format: "json", temperature: 0.2 });
  const parsed = parseJsonSafe(res?.content ?? res);
  const lessons = Array.isArray(parsed?.lessons) ? parsed.lessons : [];
  return lessons
    .map((l) => String(l || "").trim())
    .filter(Boolean)
    .slice(0, 2);
}

/** All lessons for a project (for the read-only UI panel), newest/strongest first. */
export async function listLessons({ projectId }) {
  if (!projectId) return [];
  const docs = await SiteMemory.find({ projectId })
    .sort({ status: 1, confidence: -1, updatedAt: -1 })
    .lean();
  return docs.map((d) => ({ ...d, id: String(d._id), _id: undefined }));
}

/** Forget a single lesson (hard delete) — the "forget" button. */
export async function forgetLesson({ projectId, id }) {
  if (!projectId || !id) return { deleted: 0 };
  const res = await SiteMemory.deleteOne({ _id: id, projectId });
  return { deleted: res.deletedCount || 0 };
}

/** Forget everything a project has learned about a site (or all sites). */
export async function forgetAll({ projectId, origin }) {
  if (!projectId) return { deleted: 0 };
  const filter = origin ? { projectId, origin } : { projectId };
  const res = await SiteMemory.deleteMany(filter);
  return { deleted: res.deletedCount || 0 };
}
