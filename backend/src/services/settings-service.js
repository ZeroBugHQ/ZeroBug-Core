import { config } from "../config.js";
import { AppSetting } from "../models/app-setting.model.js";

const SETTINGS_KEY = "global";

const EDITABLE_KEYS = [
  "authPassword",
  "modelProvider",
  "ollamaBaseUrl",
  "ollamaChatModel",
  "ollamaCodeModel",
  "ollamaNumCtx",
  "ollamaVision",
  "anthropicApiKey",
  "anthropicBaseUrl",
  "anthropicChatModel",
  "anthropicCodeModel",
  "anthropicVersion",
  "agentMemoryEnabled",
  "runConcurrency",
  "playwrightHeadless",
  "playwrightTimeoutMs",
  "playwrightNavTimeoutMs",
  "artifactsDir",
  "dataDir",
  "secretsKey",
  "environmentHealthTimeoutMs",
  "visualDiffThreshold",
  "smtpHost",
  "smtpPort",
  "smtpSecure",
  "smtpUser",
  "smtpPass",
  "smtpFrom",
  "notifyEmails",
  "notifyWebhookUrls",
];

function toBool(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === "" || value == null) return fallback;
  return ["true", "1", "yes", "on"].includes(String(value).toLowerCase());
}

function toInt(value, fallback, min = 0) {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

function toList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function trimUrl(value, fallback) {
  const str = String(value ?? fallback ?? "").trim();
  return str.replace(/\/$/, "");
}

function cleanProvider(value) {
  return value === "anthropic" ? "anthropic" : "ollama";
}

function sanitizePatch(body = {}) {
  const next = {};
  for (const key of EDITABLE_KEYS) {
    if (!(key in body)) continue;
    next[key] = body[key];
  }

  if ("authPassword" in next) next.authPassword = String(next.authPassword ?? "");
  if ("modelProvider" in next) next.modelProvider = cleanProvider(next.modelProvider);
  if ("ollamaBaseUrl" in next)
    next.ollamaBaseUrl = trimUrl(next.ollamaBaseUrl, config.ollamaBaseUrl);
  if ("ollamaChatModel" in next) next.ollamaChatModel = String(next.ollamaChatModel ?? "").trim();
  if ("ollamaCodeModel" in next) next.ollamaCodeModel = String(next.ollamaCodeModel ?? "").trim();
  if ("ollamaNumCtx" in next)
    next.ollamaNumCtx = toInt(next.ollamaNumCtx, config.ollamaNumCtx, 1024);
  if ("ollamaVision" in next) next.ollamaVision = toBool(next.ollamaVision, config.ollamaVision);
  if ("anthropicApiKey" in next) next.anthropicApiKey = String(next.anthropicApiKey ?? "").trim();
  if ("anthropicBaseUrl" in next)
    next.anthropicBaseUrl = trimUrl(next.anthropicBaseUrl, config.anthropicBaseUrl);
  if ("anthropicChatModel" in next)
    next.anthropicChatModel = String(next.anthropicChatModel ?? "").trim();
  if ("anthropicCodeModel" in next)
    next.anthropicCodeModel = String(next.anthropicCodeModel ?? "").trim();
  if ("anthropicVersion" in next)
    next.anthropicVersion = String(next.anthropicVersion ?? "").trim();
  if ("agentMemoryEnabled" in next)
    next.agentMemoryEnabled = toBool(next.agentMemoryEnabled, config.agentMemoryEnabled);
  if ("runConcurrency" in next)
    next.runConcurrency = toInt(next.runConcurrency, config.runConcurrency, 1);
  if ("playwrightHeadless" in next)
    next.playwrightHeadless = toBool(next.playwrightHeadless, config.playwrightHeadless);
  if ("playwrightTimeoutMs" in next)
    next.playwrightTimeoutMs = toInt(next.playwrightTimeoutMs, config.playwrightTimeoutMs, 1000);
  if ("playwrightNavTimeoutMs" in next)
    next.playwrightNavTimeoutMs = toInt(
      next.playwrightNavTimeoutMs,
      config.playwrightNavTimeoutMs,
      1000,
    );
  if ("artifactsDir" in next) next.artifactsDir = String(next.artifactsDir ?? "").trim();
  if ("dataDir" in next) next.dataDir = String(next.dataDir ?? "").trim();
  if ("secretsKey" in next) next.secretsKey = String(next.secretsKey ?? "");
  if ("environmentHealthTimeoutMs" in next)
    next.environmentHealthTimeoutMs = toInt(
      next.environmentHealthTimeoutMs,
      config.environmentHealthTimeoutMs,
      500,
    );
  if ("visualDiffThreshold" in next)
    next.visualDiffThreshold = toInt(next.visualDiffThreshold, config.visualDiffThreshold, 0);
  if ("smtpHost" in next) next.smtpHost = String(next.smtpHost ?? "").trim();
  if ("smtpPort" in next) next.smtpPort = toInt(next.smtpPort, config.smtpPort, 1);
  if ("smtpSecure" in next) next.smtpSecure = toBool(next.smtpSecure, config.smtpSecure);
  if ("smtpUser" in next) next.smtpUser = String(next.smtpUser ?? "").trim();
  if ("smtpPass" in next) next.smtpPass = String(next.smtpPass ?? "");
  if ("smtpFrom" in next) next.smtpFrom = String(next.smtpFrom ?? "").trim();
  if ("notifyEmails" in next) next.notifyEmails = toList(next.notifyEmails);
  if ("notifyWebhookUrls" in next) next.notifyWebhookUrls = toList(next.notifyWebhookUrls);

  return next;
}

function applyValues(values = {}) {
  for (const key of EDITABLE_KEYS) {
    if (!(key in values)) continue;
    const value = values[key];
    if (value === "" && ["artifactsDir", "dataDir"].includes(key)) continue;
    config[key] = value;
  }
  config.modelProvider = cleanProvider(config.modelProvider);
  config.runConcurrency = Math.max(1, Number(config.runConcurrency) || 1);
}

function publicSettings(values = {}) {
  const merged = { ...config, ...values };
  return {
    authEnabled: Boolean(merged.authPassword),
    authPassword: merged.authPassword ?? "",
    modelProvider: cleanProvider(merged.modelProvider),
    ollamaBaseUrl: merged.ollamaBaseUrl,
    ollamaChatModel: merged.ollamaChatModel,
    ollamaCodeModel: merged.ollamaCodeModel,
    ollamaNumCtx: merged.ollamaNumCtx,
    ollamaVision: merged.ollamaVision,
    anthropicApiKeySet: Boolean(merged.anthropicApiKey),
    anthropicApiKey: merged.anthropicApiKey ?? "",
    anthropicBaseUrl: merged.anthropicBaseUrl,
    anthropicChatModel: merged.anthropicChatModel,
    anthropicCodeModel: merged.anthropicCodeModel,
    anthropicVersion: merged.anthropicVersion,
    agentMemoryEnabled: merged.agentMemoryEnabled !== false,
    runConcurrency: merged.runConcurrency,
    playwrightHeadless: merged.playwrightHeadless,
    playwrightTimeoutMs: merged.playwrightTimeoutMs,
    playwrightNavTimeoutMs: merged.playwrightNavTimeoutMs,
    artifactsDir: merged.artifactsDir,
    dataDir: merged.dataDir,
    secretsKeySet: Boolean(merged.secretsKey),
    secretsKey: merged.secretsKey ?? "",
    environmentHealthTimeoutMs: merged.environmentHealthTimeoutMs,
    visualDiffThreshold: merged.visualDiffThreshold,
    smtpHost: merged.smtpHost,
    smtpPort: merged.smtpPort,
    smtpSecure: merged.smtpSecure,
    smtpUser: merged.smtpUser,
    smtpPassSet: Boolean(merged.smtpPass),
    smtpPass: merged.smtpPass ?? "",
    smtpFrom: merged.smtpFrom,
    notifyEmails: merged.notifyEmails ?? [],
    notifyWebhookUrls: merged.notifyWebhookUrls ?? [],
  };
}

export async function loadSavedSettings() {
  const doc = await AppSetting.findOne({ key: SETTINGS_KEY }).lean();
  if (doc?.values) applyValues(doc.values);
  return publicSettings(doc?.values);
}

export async function getSettings() {
  const doc = await AppSetting.findOne({ key: SETTINGS_KEY }).lean();
  return publicSettings(doc?.values);
}

export async function updateSettings(body) {
  const patch = sanitizePatch(body);
  const doc = await AppSetting.findOneAndUpdate(
    { key: SETTINGS_KEY },
    { $set: { values: { ...(await rawValues()), ...patch } } },
    { new: true, upsert: true },
  );
  applyValues(doc.values);
  return publicSettings(doc.values);
}

async function rawValues() {
  const doc = await AppSetting.findOne({ key: SETTINGS_KEY }).lean();
  return doc?.values ?? {};
}
