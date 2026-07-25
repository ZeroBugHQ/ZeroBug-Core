import { config } from "../config.js";
import { Environment } from "../models/environment.model.js";

const HISTORY_CAP = 48;
let samplerTimer = null;

function normalizeUrl(raw) {
  const url = String(raw ?? "").trim();
  if (url && !/^https?:\/\//i.test(url) && /\.[a-z]/i.test(url)) {
    return `https://${url.replace(/^\/+/, "")}`;
  }
  return url;
}

export async function probeEnvironmentHealth(rawUrl) {
  const checkedAt = new Date().toISOString();
  const url = normalizeUrl(rawUrl);
  if (!url) {
    return {
      health: "degraded",
      lastHealthCheckedAt: checkedAt,
      lastHealthError: "No URL configured.",
    };
  }

  try {
    let response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(config.environmentHealthTimeoutMs),
    });
    if (response.status === 405 || response.status === 501) {
      response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(config.environmentHealthTimeoutMs),
      });
    }
    return {
      health: response.ok ? "healthy" : "degraded",
      lastHealthCheckedAt: checkedAt,
      lastHealthError: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      health: "degraded",
      lastHealthCheckedAt: checkedAt,
      lastHealthError: err.message,
    };
  }
}

/** Probe every environment once and append a capped health-history sample. */
export async function sampleAllEnvironments() {
  const envs = await Environment.find({});
  for (const env of envs) {
    const probe = await probeEnvironmentHealth(env.url);
    const healthy = probe.health === "healthy";
    env.healthHistory = [...(env.healthHistory || []), { at: new Date(), healthy }].slice(
      -HISTORY_CAP,
    );
    env.health = probe.health;
    await env.save().catch(() => {});
  }
}

/** Begin periodic health sampling (every 5 minutes) for uptime history. */
export function startHealthSampler() {
  if (samplerTimer) return samplerTimer;
  sampleAllEnvironments().catch(() => {});
  samplerTimer = setInterval(
    () => sampleAllEnvironments().catch((err) => console.error("[env-health] sample failed:", err.message)),
    5 * 60 * 1000,
  );
  return samplerTimer;
}
