// In-memory broker for questions the agent asks mid-run and must wait on.
//
// The run's SSE connection is one-way (server -> client), so when the agent
// needs an answer it parks here: `askQuestion` emits a `question` event (with a
// unique id) and returns a Promise that stays pending until the client posts an
// answer to `POST /api/runs/answer` (-> `answerQuestion`), the run is aborted
// (-> `cancelQuestion`), or a timeout fires. Timeout/abort resolve to `null`,
// which the runner treats as "no instructions — proceed best-effort".
import { randomUUID } from "node:crypto";

// Wait a long time for a human reply — the whole point is to pause until the
// user answers. The timeout only exists so an abandoned run can't leak a
// headless browser forever.
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
// While parked we stream no run events; without traffic, proxies/browsers can
// treat the idle SSE connection as dead and close it — which would abort the
// wait and let the run resume with no answer. A periodic ping keeps it alive.
const HEARTBEAT_MS = 15_000;

// questionId -> { resolve, timer, heartbeat, onAbort }
const pending = new Map();

/**
 * Ask the user a question and wait for their reply.
 * @param {{question: string, testCode?: string}} payload
 * @param {(event: object) => void} emit  streams the question event to the client
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<string|null>} the answer text, or null on timeout/abort
 */
export function askQuestion({ question, testCode }, emit, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const questionId = randomUUID();

  return new Promise((resolve) => {
    const settle = (answer) => {
      const entry = pending.get(questionId);
      if (!entry) return; // already settled
      clearTimeout(entry.timer);
      clearInterval(entry.heartbeat);
      signal?.removeEventListener("abort", entry.onAbort);
      pending.delete(questionId);
      resolve(answer);
    };

    const timer = setTimeout(() => settle(null), timeoutMs);
    // Don't keep the process alive just for a parked question.
    timer.unref?.();

    const heartbeat = setInterval(() => {
      try {
        emit({ type: "ping" });
      } catch {
        /* connection gone — the abort listener will settle this */
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    const onAbort = () => settle(null);

    pending.set(questionId, { resolve: settle, timer, heartbeat, onAbort });

    if (signal) {
      if (signal.aborted) return settle(null);
      signal.addEventListener("abort", onAbort, { once: true });
    }

    emit({ type: "question", questionId, question, testCode });
  });
}

/**
 * Resolve a parked question with the user's reply.
 * @returns {boolean} true if a pending question matched
 */
export function answerQuestion(questionId, text) {
  const entry = pending.get(questionId);
  if (!entry) return false;
  entry.resolve(typeof text === "string" ? text : "");
  return true;
}

/** Cancel a parked question (resolves it to null). */
export function cancelQuestion(questionId) {
  const entry = pending.get(questionId);
  if (!entry) return false;
  entry.resolve(null);
  return true;
}

export function hasPendingQuestion(questionId) {
  return pending.has(questionId);
}
