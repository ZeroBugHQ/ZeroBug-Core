import { Project } from "../models/project.model.js";
import { Test } from "../models/test.model.js";
import { notifyThresholdBreach } from "./notification-service.js";

/**
 * After a batch run, evaluate the project's alert thresholds and notify if
 * breached. Cheap and best-effort (never throws into the run path).
 */
export async function evaluateProjectAlerts(projectId, ranTestIds = []) {
  try {
    const project = await Project.findById(projectId).lean();
    if (!project) return;
    const threshold = Number(project.alertPassRateThreshold || 0);
    const wantsCritical = !!project.alertOnCriticalFail;
    if (!threshold && !wantsCritical) return;

    const tests = await Test.find({ projectId }).select("status priority code").lean();
    const passed = tests.filter((t) => t.status === "passed").length;
    const failed = tests.filter((t) => t.status === "failed").length;
    const finished = passed + failed;
    const passRate = finished ? Math.round((passed / finished) * 100) : 100;

    let criticalFailures = [];
    if (wantsCritical) {
      const ran = new Set(ranTestIds.map(String));
      criticalFailures = tests
        .filter(
          (t) =>
            t.priority === "critical" &&
            t.status === "failed" &&
            (ran.size === 0 || ran.has(String(t._id))),
        )
        .map((t) => t.code);
    }

    const breached =
      (threshold > 0 && finished > 0 && passRate < threshold) || criticalFailures.length > 0;
    if (!breached) return;

    await notifyThresholdBreach({
      projectName: project.name,
      passRate,
      threshold,
      criticalFailures,
    });
  } catch {
    // alerting must never break a run
  }
}
