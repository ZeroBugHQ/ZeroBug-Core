import { Router } from "express";
import { listAudit } from "../services/audit-service.js";

export const auditRouter = Router();

auditRouter.get("/", async (req, res, next) => {
  try {
    res.json(await listAudit(req.query.projectId, req.query.limit));
  } catch (err) {
    next(err);
  }
});
