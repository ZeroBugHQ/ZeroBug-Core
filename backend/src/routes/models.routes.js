import { Router } from "express";
import { config } from "../config.js";
import { listModels, ollamaReachable, resolveAvailableModel } from "../services/ollama.js";
import { updateSettings } from "../services/settings-service.js";

export const modelsRouter = Router();

modelsRouter.get("/", async (req, res, next) => {
  try {
    const selectedModel =
      config.modelProvider === "anthropic" ? config.anthropicCodeModel : config.ollamaCodeModel;
    const fallbackModel = selectedModel;
    const models = await listModels();
    const modelNames = models.map((model) => model.name);
    const resolvedModel = await resolveAvailableModel(selectedModel, fallbackModel);
    const reachable = await ollamaReachable();

    res.json({
      reachable,
      provider: config.modelProvider,
      selectedModel,
      resolvedModel,
      fallbackModel,
      selectedAvailable: modelNames.includes(selectedModel),
      models,
    });
  } catch (err) {
    next(err);
  }
});

modelsRouter.patch("/", async (req, res, next) => {
  try {
    const { agentModel } = req.body ?? {};
    const value = String(agentModel ?? "").trim();
    // Persist through settings so the choice survives a restart (config is
    // re-hydrated from AppSetting on boot) and stays consistent with the
    // Settings page — a bare `config.x = …` would silently revert.
    await updateSettings(
      config.modelProvider === "anthropic"
        ? { anthropicCodeModel: value }
        : { ollamaCodeModel: value },
    );

    res.json({
      provider: config.modelProvider,
      agentModel: value,
    });
  } catch (err) {
    next(err);
  }
});
