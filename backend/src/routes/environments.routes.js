import { Router } from "express";
import { Environment } from "../models/environment.model.js";
import { probeEnvironmentHealth } from "../services/environment-health.js";
import {
  listSecretKeys,
  setSecret,
  deleteSecret,
  deleteSecretsForEnvironment,
} from "../services/secret-service.js";
import { clearSession } from "../services/session-store.js";
import { Secret } from "../models/secret.model.js";

export const environmentsRouter = Router();

// Keep the cosmetic `secrets` count on the environment in sync with reality.
async function syncSecretCount(environmentId) {
  const count = await Secret.countDocuments({ environmentId });
  await Environment.findByIdAndUpdate(environmentId, { secrets: count });
}

async function withHealth(environment) {
  const base = environment.toJSON ? environment.toJSON() : environment;
  const health = await probeEnvironmentHealth(base.url);
  return { ...base, ...health };
}

environmentsRouter.get("/", async (req, res, next) => {
  try {
    const envs = await Environment.find({}).sort({ createdAt: 1 });
    res.json(await Promise.all(envs.map((env) => withHealth(env))));
  } catch (err) {
    next(err);
  }
});

environmentsRouter.post("/", async (req, res, next) => {
  try {
    const env = await Environment.create(req.body);
    res.status(201).json(await withHealth(env));
  } catch (err) {
    next(err);
  }
});

environmentsRouter.patch("/:id", async (req, res, next) => {
  try {
    const env = await Environment.findByIdAndUpdate(req.params.id, req.body ?? {}, { new: true });
    if (!env) return res.status(404).json({ error: "Environment not found" });
    res.json(await withHealth(env));
  } catch (err) {
    next(err);
  }
});

environmentsRouter.delete("/:id", async (req, res, next) => {
  try {
    const env = await Environment.findByIdAndDelete(req.params.id);
    if (!env) return res.status(404).json({ error: "Environment not found" });
    await deleteSecretsForEnvironment(req.params.id).catch(() => {});
    await clearSession(req.params.id).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- Secrets (encrypted; values are never returned) ----

environmentsRouter.get("/:id/secrets", async (req, res, next) => {
  try {
    res.json(await listSecretKeys(req.params.id));
  } catch (err) {
    next(err);
  }
});

environmentsRouter.put("/:id/secrets", async (req, res, next) => {
  try {
    const { key, value } = req.body ?? {};
    if (!key) return res.status(400).json({ error: "key is required" });
    await setSecret(req.params.id, key, value ?? "");
    await syncSecretCount(req.params.id);
    res.status(201).json(await listSecretKeys(req.params.id));
  } catch (err) {
    if (/Secret key must/.test(err.message)) return res.status(400).json({ error: err.message });
    next(err);
  }
});

environmentsRouter.delete("/:id/secrets/:key", async (req, res, next) => {
  try {
    await deleteSecret(req.params.id, req.params.key);
    await syncSecretCount(req.params.id);
    res.json(await listSecretKeys(req.params.id));
  } catch (err) {
    next(err);
  }
});

// ---- Saved browser session (storageState reuse) ----

environmentsRouter.delete("/:id/session", async (req, res, next) => {
  try {
    await clearSession(req.params.id);
    await Environment.findByIdAndUpdate(req.params.id, { $unset: { storageStateSavedAt: "" } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
