import { Router } from "express";
import { getSettings, updateSettings } from "../services/settings-service.js";

export const settingsRouter = Router();

settingsRouter.get("/", async (_req, res, next) => {
  try {
    res.json(await getSettings());
  } catch (err) {
    next(err);
  }
});

settingsRouter.patch("/", async (req, res, next) => {
  try {
    res.json(await updateSettings(req.body ?? {}));
  } catch (err) {
    next(err);
  }
});
