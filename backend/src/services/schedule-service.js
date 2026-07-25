import { Schedule } from "../models/schedule.model.js";
import { runQueue } from "./queue-service.js";

let timer = null;
let runningTick = false;

function parseField(field, value, min, max) {
  const parts = String(field ?? "*").split(",");
  return parts.some((part) => {
    const token = part.trim();
    if (!token) return false;
    if (token === "*") return true;
    if (token.includes("/")) {
      const [base, stepRaw] = token.split("/");
      const step = Number(stepRaw);
      if (!Number.isFinite(step) || step <= 0) return false;
      if (base === "*") return (value - min) % step === 0;
      const [startRaw, endRaw] = base.split("-");
      const start = Number(startRaw);
      const end = Number(endRaw ?? max);
      return value >= start && value <= end && (value - start) % step === 0;
    }
    if (token.includes("-")) {
      const [startRaw, endRaw] = token.split("-");
      const start = Number(startRaw);
      const end = Number(endRaw);
      return Number.isFinite(start) && Number.isFinite(end) && value >= start && value <= end;
    }
    const n = Number(token);
    return Number.isFinite(n) && value === n;
  });
}

export function cronMatches(expr, date) {
  const parts = String(expr ?? "")
    .trim()
    .split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, day, month, weekday] = parts;
  return (
    parseField(minute, date.getMinutes(), 0, 59) &&
    parseField(hour, date.getHours(), 0, 23) &&
    parseField(day, date.getDate(), 1, 31) &&
    parseField(month, date.getMonth() + 1, 1, 12) &&
    parseField(weekday, date.getDay(), 0, 6)
  );
}

async function triggerSchedule(schedule) {
  schedule.lastTriggeredAt = new Date();
  schedule.lastStatus = "running";
  schedule.lastError = undefined;
  await schedule.save();

  try {
    const summary = await runQueue({
      projectId: schedule.projectId,
      environmentId: schedule.environmentId,
      suite: schedule.suite || undefined,
      source: "schedule",
      maxRetries: schedule.maxRetries,
      callbackUrl: schedule.callbackUrl,
    });
    schedule.lastCompletedAt = new Date();
    schedule.lastStatus =
      summary.error || summary.finished.some((t) => t.status === "failed") ? "failed" : "passed";
    schedule.lastError = summary.error || undefined;
    await schedule.save();
  } catch (err) {
    schedule.lastCompletedAt = new Date();
    schedule.lastStatus = err.code === "QUEUE_RUNNING" ? "skipped" : "failed";
    schedule.lastError = err.message;
    await schedule.save();
  }
}

export async function tickSchedules(now = new Date()) {
  if (runningTick) return;
  runningTick = true;
  try {
    const schedules = await Schedule.find({ enabled: true });
    for (const schedule of schedules) {
      const alreadyTriggeredThisMinute =
        schedule.lastTriggeredAt &&
        schedule.lastTriggeredAt.getFullYear() === now.getFullYear() &&
        schedule.lastTriggeredAt.getMonth() === now.getMonth() &&
        schedule.lastTriggeredAt.getDate() === now.getDate() &&
        schedule.lastTriggeredAt.getHours() === now.getHours() &&
        schedule.lastTriggeredAt.getMinutes() === now.getMinutes();
      if (alreadyTriggeredThisMinute) continue;
      if (!cronMatches(schedule.cron, now)) continue;
      await triggerSchedule(schedule);
    }
  } finally {
    runningTick = false;
  }
}

export function startScheduleTicker() {
  if (timer) return timer;
  timer = setInterval(() => {
    tickSchedules().catch((err) => console.error("[schedules] tick failed:", err.message));
  }, 30_000);
  return timer;
}
