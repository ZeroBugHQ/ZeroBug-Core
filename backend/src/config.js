import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1" || value === "yes";
}

function int(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function csv(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  port: int(process.env.PORT, 4000),
  // undefined => cors reflects the request origin (convenient for local dev)
  corsOrigin: process.env.CORS_ORIGIN || undefined,

  mongoUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017",
  mongoDb: process.env.MONGODB_DB || "zerobug",

  // Optional shared-password gate. Empty = auth disabled (open access).
  authPassword: process.env.ZEROBUG_AUTH_PASSWORD || "",

  ollamaBaseUrl: (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, ""),
  ollamaChatModel: process.env.OLLAMA_CHAT_MODEL || "llama3.1",
  ollamaCodeModel: process.env.OLLAMA_CODE_MODEL || "llama3.1",
  // Context window (tokens) requested from Ollama; also drives the context meter
  // and the auto-compaction threshold.
  ollamaNumCtx: int(process.env.OLLAMA_NUM_CTX, 8192),
  // Send the page screenshot to the decision model. Only enable with a vision model
  // that reliably maps a screenshot to element refs (plain screenshots often don't).
  ollamaVision: (process.env.OLLAMA_VISION || "false") === "true",
  modelProvider: process.env.MODEL_PROVIDER || "ollama",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicBaseUrl: (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(
    /\/$/,
    "",
  ),
  anthropicChatModel: process.env.ANTHROPIC_CHAT_MODEL || "claude-3-5-haiku-latest",
  anthropicCodeModel: process.env.ANTHROPIC_CODE_MODEL || "claude-3-5-sonnet-latest",
  anthropicVersion: process.env.ANTHROPIC_VERSION || "2023-06-01",

  // Max tests run concurrently in a "Run all" batch (1 = sequential).
  // Agent site-memory: learn lessons from past runs and inject them as hints.
  agentMemoryEnabled: bool(process.env.AGENT_MEMORY_ENABLED, true),

  runConcurrency: Math.max(1, int(process.env.RUN_CONCURRENCY, 3)),
  playwrightHeadless: bool(process.env.PLAYWRIGHT_HEADLESS, true),
  playwrightTimeoutMs: int(process.env.PLAYWRIGHT_TIMEOUT_MS, 30000),
  // Navigation (page.goto) can be much slower than element actions on heavy/slow sites.
  playwrightNavTimeoutMs: int(process.env.PLAYWRIGHT_NAV_TIMEOUT_MS, 60000),
  // Hard ceiling (ms) for the post-action "settle" wait before the agent observes
  // the page. Adaptive: resolves as soon as the DOM goes quiescent; this only
  // bounds a page that never stabilizes (infinite spinner, endless polling). The
  // whole settle (domcontentloaded + quiescence + network/loader checks) shares
  // this single budget, so total wait never exceeds it (bar a small tail delay).
  settleMaxMs: int(process.env.SETTLE_MAX_MS, 8000),

  artifactsDir: process.env.ARTIFACTS_DIR || path.join(ROOT_DIR, "artifacts"),
  // Private (NOT publicly served) dir for secrets-adjacent files like saved
  // browser sessions. Never expose this over HTTP.
  dataDir: process.env.DATA_DIR || path.join(ROOT_DIR, ".data"),
  // Passphrase used to encrypt stored secrets at rest (AES-256-GCM). REQUIRED:
  // the server refuses to start if this is empty (see server.js) — there is no
  // insecure default fallback. Generate with: openssl rand -base64 32
  secretsKey: process.env.ZEROBUG_SECRETS_KEY || "",
  environmentHealthTimeoutMs: int(process.env.ENV_HEALTH_TIMEOUT_MS, 5000),
  visualDiffThreshold: int(process.env.VISUAL_DIFF_THRESHOLD, 1),
  host: process.env.HOST || "localhost",

  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: int(process.env.SMTP_PORT, 587),
  smtpSecure: bool(process.env.SMTP_SECURE, false),
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  smtpFrom: process.env.SMTP_FROM || "",
  notifyEmails: csv(process.env.NOTIFY_EMAILS),
  notifyWebhookUrls: csv(process.env.NOTIFY_WEBHOOK_URLS),
};

export function describeConfig() {
  return {
    port: config.port,
    corsOrigin: config.corsOrigin ?? "(reflect request origin)",
    mongoUri: config.mongoUri,
    mongoDb: config.mongoDb,
    ollamaBaseUrl: config.ollamaBaseUrl,
    ollamaChatModel: config.ollamaChatModel,
    ollamaCodeModel: config.ollamaCodeModel,
    ollamaVision: config.ollamaVision,
    modelProvider: config.modelProvider,
    anthropicBaseUrl: config.anthropicBaseUrl,
    anthropicChatModel: config.anthropicChatModel,
    anthropicCodeModel: config.anthropicCodeModel,
    anthropicApiKeyConfigured: Boolean(config.anthropicApiKey),
    playwrightHeadless: config.playwrightHeadless,
    playwrightTimeoutMs: config.playwrightTimeoutMs,
    playwrightNavTimeoutMs: config.playwrightNavTimeoutMs,
    artifactsDir: config.artifactsDir,
    smtpConfigured: Boolean(config.smtpHost && config.smtpFrom),
    notifyEmails: config.notifyEmails.length,
    notifyWebhookUrls: config.notifyWebhookUrls.length,
  };
}
