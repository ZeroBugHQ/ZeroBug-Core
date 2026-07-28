import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { viewportContextOptions, videoSizeFor } from "./playwright-runner.js";
import { launchBrowser } from "./browser-engines.js";

// A pool of LIVE, long-lived Playwright browser contexts — one per category
// (keyed by env + category + viewport). During a "Run all"/queue run, every
// test in a category reuses the SAME authenticated context (own page per test),
// so the app is logged into once and stays logged in — no re-login, no wasted
// tokens, and the agent isn't dropped onto a fresh cold page each time.
//
// Tests sharing a context are serialised by a per-key mutex (so their pages
// never collide and per-test trace chunks don't overlap). Contexts are closed
// when the queue finishes (closeGroup) or after an idle timeout as a safety net.

const IDLE_MS = 3 * 60 * 1000;
const entries = new Map(); // poolKey -> entry

function sanitize(s) {
  return String(s ?? "").replace(/[^a-zA-Z0-9._-]+/g, "-") || "ctx";
}

// A minimal promise-chain mutex.
function createMutex() {
  let tail = Promise.resolve();
  return function lock() {
    let unlock;
    const gate = new Promise((res) => (unlock = res));
    const prev = tail;
    tail = tail.then(() => gate);
    return prev.then(() => unlock);
  };
}

/**
 * Acquire the shared context for a pool key, holding a lock until release() so
 * same-category tests run one-at-a-time on it. Creates the browser/context on
 * first use. Returns { context, reused, release }.
 */
export async function acquirePooledContext({
  poolKey,
  groupId,
  viewport,
  engine = "chromium",
  storageStateLoad,
  storageStatePath,
}) {
  let entry = entries.get(poolKey);
  if (!entry) {
    entry = { browser: null, context: null, groupId, lock: createMutex(), idleTimer: null };
    entries.set(poolKey, entry);
  }
  entry.groupId = groupId;
  entry.storageStatePath = storageStatePath;
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  const unlock = await entry.lock();
  try {
    let reused = true;
    if (!entry.context) {
      reused = false;
      const browser = await launchBrowser(engine);
      const deviceOpts = viewportContextOptions(viewport, engine);
      entry.videoDir = path.join(config.dataDir, "pool-media", sanitize(poolKey));
      await fs.mkdir(entry.videoDir, { recursive: true }).catch(() => {});
      const context = await browser.newContext({
        ...deviceOpts,
        recordVideo: { dir: entry.videoDir, size: videoSizeFor(deviceOpts) },
        ...(storageStateLoad ? { storageState: storageStateLoad } : {}),
      });
      await context.tracing.start({ screenshots: true, snapshots: true }).catch(() => {});
      entry.browser = browser;
      entry.context = context;
    }
    return {
      context: entry.context,
      reused,
      release: () => {
        // Free the lock and arm an idle-close safety net.
        entry.idleTimer = setTimeout(() => closePool(poolKey).catch(() => {}), IDLE_MS);
        unlock();
      },
    };
  } catch (err) {
    unlock();
    // Creation failed — drop the entry so the next test starts clean.
    entries.delete(poolKey);
    await entry.browser?.close().catch(() => {});
    throw err;
  }
}

async function closePool(poolKey) {
  const entry = entries.get(poolKey);
  if (!entry) return;
  entries.delete(poolKey);
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  // Persist the session for later (single) runs before tearing down.
  if (entry.context && entry.storageStatePath) {
    await entry.context.storageState({ path: entry.storageStatePath }).catch(() => {});
  }
  await entry.context?.tracing.stop().catch(() => {});
  await entry.context?.close().catch(() => {});
  await entry.browser?.close().catch(() => {});
  if (entry.videoDir) await fs.rm(entry.videoDir, { recursive: true, force: true }).catch(() => {});
}

/** Close every pooled context belonging to a group (e.g. a project's queue). */
export async function closeGroup(groupId) {
  const keys = [...entries.entries()]
    .filter(([, e]) => e.groupId === String(groupId))
    .map(([k]) => k);
  await Promise.allSettled(keys.map((k) => closePool(k)));
}
