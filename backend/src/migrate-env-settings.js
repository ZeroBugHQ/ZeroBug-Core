import "dotenv/config";
import { connectDb } from "./db.js";
import { updateSettings } from "./services/settings-service.js";

function has(name) {
  return Object.prototype.hasOwnProperty.call(process.env, name);
}

function pick(name, key, out) {
  if (has(name)) out[key] = process.env[name] ?? "";
}

function pickInt(name, key, out) {
  if (has(name)) out[key] = Number.parseInt(process.env[name] ?? "", 10);
}

function pickBool(name, key, out) {
  if (has(name)) out[key] = ["true", "1", "yes"].includes(
    String(process.env[name] ?? "").toLowerCase(),
  );
}

async function main() {
  const settings = {};

  pick("ZEROBUG_AUTH_PASSWORD", "authPassword", settings);
  pick("MODEL_PROVIDER", "modelProvider", settings);
  pick("OLLAMA_BASE_URL", "ollamaBaseUrl", settings);
  pick("OLLAMA_CHAT_MODEL", "ollamaChatModel", settings);
  pick("OLLAMA_CODE_MODEL", "ollamaCodeModel", settings);
  pickInt("OLLAMA_NUM_CTX", "ollamaNumCtx", settings);
  pickBool("OLLAMA_VISION", "ollamaVision", settings);
  pick("ANTHROPIC_API_KEY", "anthropicApiKey", settings);
  pick("ANTHROPIC_BASE_URL", "anthropicBaseUrl", settings);
  pick("ANTHROPIC_CHAT_MODEL", "anthropicChatModel", settings);
  pick("ANTHROPIC_CODE_MODEL", "anthropicCodeModel", settings);
  pick("ANTHROPIC_VERSION", "anthropicVersion", settings);
  pickInt("RUN_CONCURRENCY", "runConcurrency", settings);
  pickBool("PLAYWRIGHT_HEADLESS", "playwrightHeadless", settings);
  pickInt("PLAYWRIGHT_TIMEOUT_MS", "playwrightTimeoutMs", settings);
  pickInt("PLAYWRIGHT_NAV_TIMEOUT_MS", "playwrightNavTimeoutMs", settings);
  pick("ARTIFACTS_DIR", "artifactsDir", settings);
  pick("DATA_DIR", "dataDir", settings);
  pick("ZEROBUG_SECRETS_KEY", "secretsKey", settings);
  pickInt("ENV_HEALTH_TIMEOUT_MS", "environmentHealthTimeoutMs", settings);
  pickInt("VISUAL_DIFF_THRESHOLD", "visualDiffThreshold", settings);
  pick("SMTP_HOST", "smtpHost", settings);
  pickInt("SMTP_PORT", "smtpPort", settings);
  pickBool("SMTP_SECURE", "smtpSecure", settings);
  pick("SMTP_USER", "smtpUser", settings);
  pick("SMTP_PASS", "smtpPass", settings);
  pick("SMTP_FROM", "smtpFrom", settings);
  pick("NOTIFY_EMAILS", "notifyEmails", settings);
  pick("NOTIFY_WEBHOOK_URLS", "notifyWebhookUrls", settings);

  await connectDb();
  await updateSettings(settings);
  console.log(`[settings] migrated ${Object.keys(settings).length} env-backed setting(s).`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[settings] migration failed: ${err.message}`);
  process.exit(1);
});
