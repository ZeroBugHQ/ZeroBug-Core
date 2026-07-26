// Single source of truth for a project's in-progress batch run. Both entry
// points -- the interactive "Run all" (background-runner) and the automation /
// webhook / schedule path (queue-service) -- share this state so that status
// polling, pause/resume, and stop all see the same run regardless of who
// started it. (Before unification each engine kept its own private map, so
// e.g. getQueueStatus couldn't see an interactive run.)
const stateByProject = new Map();

export function queueState(projectId) {
  const key = String(projectId);
  let state = stateByProject.get(key);
  if (!state) {
    state = {
      projectId: key,
      running: false,
      // "single" | "all" -- what kind of batch is in flight.
      kind: null,
      stopRequested: false,
      controller: null,
      activeTestId: null,
      // Automation/queue bookkeeping (unused by the interactive path but kept on
      // the shared shape so status polling is uniform).
      pendingTestIds: [],
      lastSource: null,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastSummary: null,
    };
    stateByProject.set(key, state);
  }
  return state;
}
