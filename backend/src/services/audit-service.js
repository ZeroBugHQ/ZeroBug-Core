import { AuditLog } from "../models/audit-log.model.js";

/** Fire-and-forget audit record — never throws into a request handler. */
export function recordAudit(action, detail = "", projectId) {
  AuditLog.create({ action, detail, projectId: projectId || undefined }).catch(() => {});
}

export async function listAudit(projectId, limit = 50) {
  const query = projectId ? { projectId } : {};
  const rows = await AuditLog.find(query)
    .sort({ createdAt: -1 })
    .limit(Math.max(1, Math.min(200, Number(limit) || 50)))
    .lean();
  return rows.map((r) => ({
    id: String(r._id),
    action: r.action,
    detail: r.detail,
    projectId: r.projectId ? String(r.projectId) : null,
    at: r.createdAt,
  }));
}
