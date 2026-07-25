// Pure logic for the agent's site-memory (reinforced experience learning).
//
// This module has NO database or network access on purpose: every decision about
// *what* to learn from a run and *how much to trust* a lesson lives here, so it can
// be unit-tested in isolation. The service layer (site-memory-service.js) owns
// persistence and the optional LLM reflection; it calls into these functions.
//
// The "learning" is a contextual-bandit loop, not classical RL: each lesson carries
// a confidence in [0,1]; a run that used a lesson and passed nudges it up, a run that
// failed nudges it down, and lessons that fall through the floor get pruned.

export const PROBATION_CONFIDENCE = 0.3; // new, unproven lessons start here
export const WIN_STEP = 0.2; // fraction of the gap-to-1 gained on a passing run
export const LOSS_STEP = 0.4; // fraction of current confidence lost on a failing run
export const CORROBORATE_STEP = 0.1; // small bump when a lesson is re-observed on a later run
export const PRUNE_FLOOR = 0.1; // below this (with enough uses) a lesson stops being injected
export const PRUNE_MIN_USES = 3; // give a lesson a few real tries before pruning it
export const MAX_HINTS = 6; // cap lessons injected into a single decision prompt

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/**
 * Best-effort JSON parse for model output: accepts an object as-is, strips ```json
 * fences, and pulls the first {...} block out of surrounding prose. Returns null on
 * failure (never throws) so callers can treat "no lesson" as the safe default.
 */
export function parseJsonSafe(input) {
  if (input && typeof input === "object") return input;
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const cleaned = raw
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Normalize a URL to its origin (`scheme://host[:port]`). Returns "" if unparseable. */
export function originOf(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    // Bare host or malformed — best-effort strip of path/query.
    const m = raw.match(/^(https?:\/\/[^/?#]+)/i);
    return m ? m[1] : "";
  }
}

/** Path portion of a URL (for concise lesson text). Returns "/" if unparseable. */
export function pathOf(url) {
  try {
    return new URL(String(url)).pathname || "/";
  } catch {
    return "/";
  }
}

/** Collapse a lesson to a stable dedupe key: origin + kind + normalized text. */
export function lessonKey({ origin, kind, lesson }) {
  const text = String(lesson || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/["'`]/g, "")
    .trim();
  return `${origin || ""}|${kind || "note"}|${text}`;
}

/**
 * Bounded confidence update. A passing run moves the lesson a fraction of the way
 * toward 1; a failing run removes a fraction of its current confidence. Both stay
 * within [0,1] and neither can overshoot.
 */
export function updateConfidence(confidence, passed) {
  const c = clamp01(confidence);
  const next = passed ? c + (1 - c) * WIN_STEP : c - c * LOSS_STEP;
  return clamp01(next);
}

/** A gentle bump applied when an already-known lesson recurs on a later run. */
export function corroborate(confidence) {
  const c = clamp01(confidence);
  return clamp01(c + (1 - c) * CORROBORATE_STEP);
}

/** Whether a lesson has proven unreliable enough to stop injecting it. */
export function shouldPrune({ confidence, uses } = {}) {
  return (Number(uses) || 0) >= PRUNE_MIN_USES && clamp01(confidence) < PRUNE_FLOOR;
}

/** Rank lessons for injection: highest confidence first, then most-used. Caps at `limit`. */
export function rankHints(lessons = [], limit = MAX_HINTS) {
  return [...lessons]
    .filter((l) => l && l.status !== "pruned")
    .sort((a, b) => clamp01(b.confidence) - clamp01(a.confidence) || (b.uses || 0) - (a.uses || 0))
    .slice(0, Math.max(0, limit));
}

/**
 * Format ranked lessons into the hint block injected into the agent's prompt.
 * Deliberately framed as fallible so the model never blindly overrides the live page.
 * Returns "" when there are no lessons.
 */
export function formatHints(lessons = []) {
  const ranked = rankHints(lessons);
  if (!ranked.length) return "";
  const lines = ranked.map((l) => {
    const tag = l.confidence < PROBATION_CONFIDENCE + 0.001 ? " (unproven)" : "";
    return `- [${l.kind || "note"}]${tag} ${String(l.lesson || "").trim()}`;
  });
  return [
    "LESSONS FROM PAST RUNS ON THIS SITE (learned automatically; may be imperfect —",
    "always verify against what the page actually shows, and ignore any that don't apply):",
    ...lines,
  ].join("\n");
}

/** Categorize a failure reason into a generalizable site-lesson, or null to skip. */
export function categorizeFailure(reason) {
  const r = String(reason || "");
  if (!r) return null;
  // Internal model hiccups aren't a property of the site — don't learn them.
  if (/could not get a valid decision|stopped by user|interrupted/i.test(r)) return null;
  if (/agent got stuck|repeated actions with no progress/i.test(r)) {
    return "Runs have gotten stuck in an action loop on this site before. Prefer decisive, distinct actions and avoid repeating the same click; wait for the page to settle between actions.";
  }
  if (/timeout|navigation|net::|load/i.test(r)) {
    return "Pages on this site can be slow to load or navigate. Wait for content to appear before acting, and allow extra time after navigation.";
  }
  return null;
}

/**
 * Deterministically derive candidate lessons from a finished run. Pure — takes the
 * persisted run shape plus a few observations the runner collected, returns a list of
 * `{ origin, kind, lesson, detail }`. Deduped within the batch by lessonKey.
 *
 * @param {object}   args
 * @param {object}   args.run           finished run (status, failureReason, forensics)
 * @param {object}   [args.observations] { dialogHeadings: string[], sawLoginForm: bool }
 * @param {string}   args.origin        the site origin these lessons belong to
 */
export function mineLessons({ run = {}, observations = {}, origin = "" } = {}) {
  const out = [];
  const push = (kind, lesson, detail) => {
    if (!lesson) return;
    out.push({ origin, kind, lesson: String(lesson).trim(), detail: detail || {} });
  };

  // Popups / cookie banners / modals the agent had to deal with.
  const headings = Array.isArray(observations.dialogHeadings) ? observations.dialogHeadings : [];
  for (const heading of headings) {
    const h = String(heading || "").trim();
    if (!h) continue;
    push(
      "popup",
      `This site shows a popup/dialog ("${h}"). Handle or dismiss it before continuing with the task.`,
      { heading: h },
    );
  }

  // A login form was part of reaching the task — only trust this when the run passed,
  // so we don't enshrine a login flow that actually failed.
  if (observations.sawLoginForm && run.status === "passed") {
    push(
      "login",
      "This site puts an on-page login/sign-in form in front of the main task. Log in once (fill the fields, submit, wait) before attempting the task.",
      {},
    );
  }

  // Generalizable failure lessons.
  if (run.status === "failed") {
    const lesson = categorizeFailure(run.failureReason);
    if (lesson) push("failure", lesson, { reason: String(run.failureReason || "").slice(0, 200) });
  }

  // Backend problems seen in forensics: failed or 5xx requests to this same origin.
  const network = Array.isArray(run.forensics?.network) ? run.forensics.network : [];
  const seenEndpoints = new Set();
  for (const req of network) {
    const bad = req && (req.failure || (Number(req.status) >= 500 && Number(req.status) <= 599));
    if (!bad) continue;
    if (origin && originOf(req.url) && originOf(req.url) !== origin) continue; // same-site only
    const ep = pathOf(req.url);
    if (seenEndpoints.has(ep)) continue;
    seenEndpoints.add(ep);
    if (seenEndpoints.size > 2) break; // keep it to the couple most relevant
    const what = req.failure ? `failed (${req.failure})` : `returned ${req.status}`;
    push(
      "note",
      `A request to ${ep} ${what} during a run — this feature may be flaky or need setup.`,
      {
        endpoint: ep,
        status: req.status,
      },
    );
  }

  // Dedupe within this batch.
  const seen = new Set();
  return out.filter((l) => {
    const k = lessonKey(l);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
