import fs from "node:fs/promises";
import path from "node:path";
import { chromium, devices } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { config } from "../config.js";
import {
  baselinePathForTest,
  ensureArtifactDir,
  fileExists,
  writeArtifact,
} from "./artifact-service.js";
import { decideAction } from "./ollama.js";
import { resolveFixture } from "./fixture-service.js";

const MAX_STEPS = 32;

// A stable fingerprint of the page's meaningful state (URL + the interactive
// element list + the visible text). Comparing consecutive fingerprints tells us
// whether an action actually changed anything — the real "stuck" signal, far
// better than only catching literally-identical repeated actions.
function pageFingerprint(obs) {
  const els = (obs.elements || []).map((e) => e.descriptor).join("~");
  return `${obs.url}::${els}::${(obs.text || "").slice(0, 400)}`;
}

// Emulate a device form-factor while staying on Chromium. We borrow Playwright's
// device descriptors (viewport, userAgent, deviceScaleFactor, isMobile, touch) —
// isMobile/touch are Chromium-only, which is exactly the browser we use.
export function viewportContextOptions(viewport) {
  if (viewport === "mobile") {
    const d = devices["Pixel 7"] || devices["Pixel 5"];
    return d ? { ...d } : { viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true };
  }
  if (viewport === "tablet") {
    const d = devices["iPad (gen 7)"] || devices["iPad Mini"];
    return d
      ? { ...d }
      : { viewport: { width: 810, height: 1080 }, isMobile: true, hasTouch: true };
  }
  return { viewport: { width: 1280, height: 720 } };
}

// Video size must match the emulated viewport, else Playwright letterboxes it.
export function videoSizeFor(opts) {
  return opts.viewport || { width: 1280, height: 720 };
}

// Replace {{KEY}} placeholders with decrypted environment secrets. Unknown keys
// are left as-is.
function substituteSecrets(text, secrets) {
  if (!text || !secrets) return text;
  return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(secrets, key) ? secrets[key] : match,
  );
}

const truncate = (s, n = 120) => {
  const t = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

// A bare domain ("example.com") gets an https:// scheme so it isn't treated as a path.
function normalizeUrl(raw) {
  const url = String(raw ?? "").trim();
  if (url && !/^https?:\/\//i.test(url) && /\.[a-z]/i.test(url)) {
    return "https://" + url.replace(/^\/+/, "");
  }
  return url;
}

// Resolve the model's navigate target into an absolute URL:
// - empty            -> the URL stated in the task
// - absolute http(s) -> as-is
// - bare domain      -> add https://
// - relative path    -> resolve against the CURRENT page (or task URL)
function resolveNav(raw, current, taskUrl) {
  const r = String(raw ?? "").trim();
  if (!r) return taskUrl || "";
  if (/^https?:\/\//i.test(r)) return r;
  if (/^[^/\s]+\.[a-z]{2,}/i.test(r)) return "https://" + r.replace(/^\/+/, "");
  const base = current && current !== "about:blank" ? current : taskUrl;
  try {
    return new URL(r, base).href;
  } catch {
    return taskUrl || r;
  }
}

// IANA reserved placeholder domains never host a real app — if the model
// hallucinates one (a common failure, e.g. "glide.example.com"), rewrite it to
// the real base origin, keeping the path/query so the intent is preserved.
const PLACEHOLDER_HOST = /(^|\.)example\.(com|org|net)$/i;
function redirectPlaceholder(url, base) {
  if (!base) return url;
  try {
    const u = new URL(url);
    if (!PLACEHOLDER_HOST.test(u.hostname)) return url;
    const b = new URL(normalizeUrl(base));
    return new URL(u.pathname + u.search + u.hash, b.origin).href;
  } catch {
    return url;
  }
}

// Observe the live page. Tags visible, *innermost* interactive elements — including
// SPA-clickable divs/spans (cursor:pointer, click handlers, role, tabindex), not just
// real <a>/<button> — then grabs Playwright ElementHandles for them. We act on the
// handles directly so React re-renders can't break our refs.
const MAX_ELEMENTS = 60;

// Tag visible, innermost interactive elements in one frame's document with
// data-zerobug-ref numbers starting at `startRef`, and return their descriptors.
// Runs inside the browser (via frame.evaluate). Walks the light DOM and all OPEN
// shadow roots (recursively); closed shadow roots are unreachable by design and
// are passed over. Must stay self-contained — it is serialized to run in-page.
export function tagFrameElements({ startRef, max }) {
  document.querySelectorAll("[data-zerobug-ref]").forEach((e) => e.removeAttribute("data-zerobug-ref"));

  const visible = (el) => {
    if (!el.getClientRects().length) return false;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  const ROLE = /^(button|link|tab|menuitem|option|checkbox|radio|switch)$/i;
  const FORM = new Set(["a", "button", "input", "textarea", "select"]);
  const interactive = (el) => {
    const tag = el.tagName.toLowerCase();
    if (FORM.has(tag)) return true;
    const role = el.getAttribute("role");
    if (role && ROLE.test(role)) return true;
    if (el.hasAttribute("onclick")) return true;
    if (el.getAttribute("tabindex") !== null) return true;
    if (el.isContentEditable) return true;
    if (getComputedStyle(el).cursor === "pointer") return true;
    return false;
  };

  // Walk the light DOM AND every OPEN shadow root (recursively, incl. nested /
  // composed shadow trees), so elements inside web components are reachable.
  // Closed shadow roots (el.shadowRoot === null by design) are unreachable by
  // any legitimate means and are silently passed over — a real, unavoidable
  // limitation, not a bug. Depth- and budget-capped to bound work on
  // pathologically deep component trees.
  const SHADOW_MAX_DEPTH = 10;
  const collectDeep = (root, depth, acc) => {
    if (depth > SHADOW_MAX_DEPTH || acc.length >= max * 8) return acc;
    const all = root.querySelectorAll("*");
    for (const el of all) {
      acc.push(el);
      // Descend into an OPEN shadow root if this element hosts one.
      if (el.shadowRoot) collectDeep(el.shadowRoot, depth + 1, acc);
    }
    return acc;
  };
  const all = collectDeep(document.body || document.documentElement, 0, []);
  const cand = all.filter((el) => visible(el) && interactive(el));

  // Composed "contains": true if `host` contains `node` across shadow boundaries
  // (node's shadow-including ancestor chain reaches host). Node.contains() alone
  // stops at a shadow boundary, so without this a shadow host and its inner
  // interactive content would BOTH be tagged — two refs for one control. We drop
  // the bare host in favor of the real inner element(s).
  const composedContains = (host, node) => {
    if (host === node) return false;
    if (host.contains(node)) return true;
    let n = node;
    while (n) {
      if (n === host) return true;
      const rootNode = n.getRootNode && n.getRootNode();
      // Step out of a shadow root to its host, then keep climbing.
      n = n.parentNode || (rootNode && rootNode.host) || null;
    }
    return false;
  };
  const pick = cand.filter((el) => !cand.some((o) => o !== el && composedContains(el, o)));

  const CONTROL = new Set(["input", "textarea", "select"]);
  const out = [];
  let ref = startRef;
  for (const el of pick) {
    if (out.length >= max) break;
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute("type") || "";
    let label =
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      "";
    if (!label && el.id) {
      // Labels are scoped to the element's own (possibly shadow) root, so search
      // there rather than the top document — a `label[for]` inside a shadow root
      // isn't found by document.querySelector.
      const scope = (el.getRootNode && el.getRootNode()) || document;
      const lbl = scope.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) label = lbl.innerText;
    }
    const text = (el.innerText || el.value || el.getAttribute("value") || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    const shown = (label || text).slice(0, 80);
    if (!shown && !CONTROL.has(tag)) continue;

    ref += 1;
    el.setAttribute("data-zerobug-ref", String(ref));
    let d = tag;
    if (type) d += ` type=${type}`;
    if (shown) d += ` "${shown}"`;
    out.push({ ref, descriptor: d });
  }
  return out;
}

// Observe the live page across the main document AND same-origin iframes, so
// embedded forms/widgets are reachable. Element refs are numbered globally and
// their handles come from whichever frame they live in.
export async function observe(page) {
  const elements = [];
  const byRef = {};
  let refCount = 0;

  for (const frame of page.frames()) {
    if (refCount >= MAX_ELEMENTS) break;
    // Skip frames that are already gone (a cheap pre-check for the common case)
    // or are error placeholders. Cross-origin frames are NOT skipped: Playwright
    // evaluates in each frame's own context, so a cross-origin child (embedded
    // payment/auth widgets like Stripe Elements) is tagged and actioned normally.
    if (frame.isDetached() || frame.url().startsWith("chrome-error://")) continue;
    const frameEls = await frame
      .evaluate(tagFrameElements, { startRef: refCount, max: MAX_ELEMENTS - refCount })
      // Retained catch for the genuine race the old "cross-origin not accessible"
      // comment mislabeled: a frame can navigate away or be removed BETWEEN the
      // page.frames() enumeration and this call resolving, which rejects with
      // "Frame was detached". That's common in the wild (ad/analytics iframes,
      // SPA content swaps, OAuth redirects). Never let it crash the run — skip the
      // frame. Cross-origin frames do NOT throw here; they flow through normally.
      .catch(() => []);
    if (!frameEls.length) continue;

    // The same detachment race applies to $$ (also throws "Frame was detached").
    const tagged = await frame.$$("[data-zerobug-ref]").catch(() => []);
    for (const h of tagged) {
      const r = await h.getAttribute("data-zerobug-ref").catch(() => null);
      const n = r ? Number(r) : null;
      if (n && !byRef[n]) byRef[n] = h;
      else await h.dispose().catch(() => {});
    }
    elements.push(...frameEls);
    refCount += frameEls.length;
  }

  const text = await page
    .evaluate(() =>
      (document.body?.innerText || "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, 3000),
    )
    .catch(() => "");
  const title = await page.title().catch(() => "");

  const hasLoginSection = await detectAuthForm(page);
  const dialog = await detectDialog(page);

  return { url: page.url(), title, elements, text, byRef, hasLoginSection, dialog };
}

// Detect that the page is actually presenting a login/account-creation FORM the
// agent would have to fill — not merely that the word "login" appears somewhere
// (a header "Log in" link matches on almost every site). We require a real,
// visible credential control:
//   - a visible password field (covers login + most signup), OR
//   - a visible email/username field next to a submit whose label reads like
//     sign-up/register/sign-in (covers passwordless / multi-step auth).
async function detectAuthForm(page) {
  return page
    .evaluate(() => {
      const visible = (el) => {
        if (!el || !el.getClientRects().length) return false;
        const s = getComputedStyle(el);
        if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0)
          return false;
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };

      // Strongest, lowest-false-positive signal: a visible password input.
      const passwords = Array.from(document.querySelectorAll('input[type="password"]'));
      if (passwords.some(visible)) return true;

      // Passwordless / first-step auth: a visible email or username field paired
      // with a clearly auth-labelled submit control.
      const AUTH_LABEL = /\b(sign\s*in|log\s*in|sign\s*up|register|create\s+(an\s+)?account)\b/i;
      const idField = Array.from(
        document.querySelectorAll(
          'input[type="email"], input[name*="email" i], input[name*="user" i], input[autocomplete="username"]',
        ),
      ).find(visible);
      if (!idField) return false;

      const submits = Array.from(
        document.querySelectorAll('button, input[type="submit"], [role="button"]'),
      );
      return submits.some(
        (el) =>
          visible(el) &&
          AUTH_LABEL.test((el.innerText || el.value || el.getAttribute("aria-label") || "").trim()),
      );
    })
    .catch(() => false);
}

// Detect an OPEN popup/modal/dialog (a decent-sized, visible overlay panel).
// Used to tell the agent "a dialog is open" — the success condition for tests
// whose goal is to launch/verify a popup.
async function detectDialog(page) {
  return page
    .evaluate(() => {
      const visible = (el) => {
        if (!el || !el.getClientRects().length) return false;
        const s = getComputedStyle(el);
        if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0)
          return false;
        return true;
      };
      const nodes = Array.from(
        document.querySelectorAll(
          '[role="dialog"],[role="alertdialog"],[aria-modal="true"],' +
            '[class*="modal" i],[class*="popup" i],[class*="dialog" i],[class*="drawer" i],[class*="overlay" i]',
        ),
      ).filter(visible);
      let best = null;
      let bestArea = 0;
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        // A real dialog is a sizeable panel, not the whole page or a tiny badge.
        if (
          area > 40000 &&
          area < window.innerWidth * window.innerHeight * 0.98 &&
          area > bestArea
        ) {
          best = el;
          bestArea = area;
        }
      }
      if (!best) return { open: false, heading: "" };
      let heading = best.getAttribute("aria-label") || "";
      if (!heading) {
        const h = best.querySelector('h1,h2,h3,h4,[role="heading"]');
        if (h) heading = h.innerText || "";
      }
      if (!heading) heading = (best.innerText || "").trim().split("\n")[0] || "";
      return { open: true, heading: heading.replace(/\s+/g, " ").trim().slice(0, 80) };
    })
    .catch(() => ({ open: false, heading: "" }));
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error("Stopped by user.");
}

async function screenshotDataUrl(page, quality = 50) {
  try {
    const buf = await page.screenshot({ type: "jpeg", quality });
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
}

async function captureOutput(page, artifactScope) {
  const [url, title, text] = await Promise.all([
    Promise.resolve(page.url()),
    page.title().catch(() => ""),
    page
      .locator("body")
      .innerText({ timeout: 2000 })
      .catch(() => ""),
  ]);

  let screenshot;
  if (artifactScope) {
    try {
      await page.screenshot({
        path: path.join(artifactScope.dir, "final-screenshot.png"),
        fullPage: true,
      });
      screenshot = `${artifactScope.publicUrlBase}/final-screenshot.png`;
    } catch {
      screenshot = undefined;
    }
  } else {
    screenshot = await screenshotDataUrl(page, 55);
  }

  return {
    url,
    title,
    text: String(text)
      .replace(/\n{3,}/g, "\n\n")
      .slice(0, 4000),
    screenshot,
  };
}

async function runPostAssertions({ page, test, artifactScope, steps, onEvent, startIndex }) {
  const artifacts = [];
  let failureReason;
  let index = startIndex;

  const finish = (label, status, detail) => {
    const step = { index, label, status, detail };
    steps.push(step);
    onEvent({ type: "step", ...step });
    index += 1;
  };

  if (test.mode !== "ui") {
    return { artifacts, failureReason, nextIndex: index };
  }

  if (test.assertionTypes?.includes("visual")) {
    const baseline = baselinePathForTest(test.id);
    const actualPath = path.join(artifactScope.dir, "visual-actual.png");
    const diffPath = path.join(artifactScope.dir, "visual-diff.png");
    try {
      const actualBuffer = await page.screenshot({ path: actualPath, fullPage: true });
      artifacts.push({
        kind: "image",
        label: "Visual actual",
        url: `${artifactScope.publicUrlBase}/visual-actual.png`,
      });
      if (!(await fileExists(baseline.absolutePath))) {
        await fs.mkdir(path.dirname(baseline.absolutePath), { recursive: true });
        await fs.writeFile(baseline.absolutePath, actualBuffer);
        artifacts.push({ kind: "image", label: "Visual baseline", url: baseline.publicUrl });
        finish("Visual diff", "pass", "Created baseline screenshot.");
      } else {
        const [baselineBuffer, actual] = await Promise.all([
          fs.readFile(baseline.absolutePath),
          fs.readFile(actualPath),
        ]);
        const baselinePng = PNG.sync.read(baselineBuffer);
        const actualPng = PNG.sync.read(actual);
        if (baselinePng.width !== actualPng.width || baselinePng.height !== actualPng.height) {
          finish(
            "Visual diff",
            "fail",
            `Screenshot size changed from ${baselinePng.width}x${baselinePng.height} to ${actualPng.width}x${actualPng.height}.`,
          );
          failureReason ||= "Visual baseline dimensions changed.";
        } else {
          const diff = new PNG({ width: baselinePng.width, height: baselinePng.height });
          const mismatchedPixels = pixelmatch(
            baselinePng.data,
            actualPng.data,
            diff.data,
            baselinePng.width,
            baselinePng.height,
            { threshold: 0.1 },
          );
          await fs.writeFile(diffPath, PNG.sync.write(diff));
          artifacts.push({ kind: "image", label: "Visual baseline", url: baseline.publicUrl });
          artifacts.push({
            kind: "image",
            label: "Visual diff",
            url: `${artifactScope.publicUrlBase}/visual-diff.png`,
          });
          const ok = mismatchedPixels <= config.visualDiffThreshold;
          finish(
            "Visual diff",
            ok ? "pass" : "fail",
            ok
              ? `Matched baseline (${mismatchedPixels} differing pixels).`
              : `${mismatchedPixels} pixels differed from baseline.`,
          );
          if (!ok) failureReason ||= `Visual diff failed (${mismatchedPixels} differing pixels).`;
        }
      }
    } catch (err) {
      finish("Visual diff", "fail", err.message);
      failureReason ||= `Visual diff failed: ${err.message}`;
    }
  }

  if (test.assertionTypes?.includes("a11y")) {
    try {
      const results = await new AxeBuilder({ page }).analyze();
      const artifact = await writeArtifact(
        artifactScope.relativePath,
        "axe-results.json",
        JSON.stringify(results, null, 2),
      );
      artifacts.push({ kind: "json", label: "axe results", url: artifact.url });
      const violationCount = results.violations.length;
      const ok = violationCount === 0;
      finish(
        "Accessibility audit",
        ok ? "pass" : "fail",
        ok
          ? "No accessibility violations found."
          : `${violationCount} accessibility violation(s) found.`,
      );
      if (!ok) failureReason ||= `${violationCount} accessibility violation(s) found.`;
    } catch (err) {
      finish("Accessibility audit", "fail", err.message);
      failureReason ||= `Accessibility audit failed: ${err.message}`;
    }
  }

  return { artifacts, failureReason, nextIndex: index };
}

// How long the DOM must show no mutations before we call it "quiescent".
const SETTLE_QUIET_MS = 400;
// Bounded, non-fatal sub-waits (network + loaders). These never block the
// observe step on their own — a polling/websocket app that never goes idle
// still proceeds as soon as the DOM is quiescent.
const SETTLE_NETWORKIDLE_MS = 1500;
const SETTLE_LOADERS_MS = 1500;
const SETTLE_TAIL_MS = 150;

// Wait for the DOM to stop mutating for `quietMs`, or resolve at `ceilingMs`.
// Returns "quiescent" | "ceiling" | "error". Installs a MutationObserver and
// resets a debounce timer on every mutation batch — the real "page has
// stabilized" signal, unlike a blind networkidle that never fires on
// polling/websocket apps.
async function domQuiescence(page, quietMs, ceilingMs) {
  return page
    .evaluate(
      ({ quietMs, ceilingMs }) =>
        new Promise((resolve) => {
          let quietTimer;
          const done = (reason) => {
            try {
              obs.disconnect();
            } catch {}
            clearTimeout(quietTimer);
            clearTimeout(hardTimer);
            resolve(reason);
          };
          const bump = () => {
            clearTimeout(quietTimer);
            quietTimer = setTimeout(() => done("quiescent"), quietMs);
          };
          const obs = new MutationObserver(bump);
          const hardTimer = setTimeout(() => done("ceiling"), ceilingMs);
          obs.observe(document, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
          });
          bump(); // start the quiet clock immediately for an already-still page
        }),
      { quietMs, ceilingMs },
    )
    .catch(() => "error");
}

// Pure orchestrator (browser-free, unit-testable). `signals` are injected async
// fns each receiving the remaining budget (ms); `now`/`sleep` are injectable for
// deterministic tests. Guarantees: it never runs longer than opts.maxMs (bar the
// separate, deliberately-small tailMs); the primary quiescence signal always
// runs; and the secondary (network/loaders) waits are best-effort — their
// rejection or timeout never prevents proceeding once the DOM is stable.
export async function settleLoop(signals, opts) {
  const { maxMs, tailMs = 0, now = () => Date.now(), sleep } = opts;
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const start = now();
  const remaining = () => Math.max(0, maxMs - (now() - start));

  // A caller-supplied pre-wait (e.g. domcontentloaded) that consumes the SAME
  // budget, so it can't push total time past maxMs.
  if (signals.prewait) {
    const budget = remaining();
    if (budget > 0) await Promise.resolve(signals.prewait(budget)).catch(() => {});
  }

  // Primary: DOM quiescence, bounded by whatever budget is left.
  if (signals.quiescence) {
    const budget = remaining();
    if (budget > 0) await Promise.resolve(signals.quiescence(budget)).catch(() => {});
  }

  // Secondary (best-effort, non-fatal): only if budget remains. Each signal is
  // handed the remaining budget and is itself responsible for not exceeding it
  // (the real Playwright waiters cap their own timeout at Math.min(budget, …)),
  // so running them concurrently can't push past the ceiling. Failures/timeouts
  // are swallowed — they never block proceeding once the DOM is stable.
  const budget = remaining();
  if (budget > 0 && (signals.networkIdle || signals.loadersGone)) {
    const best = [];
    if (signals.networkIdle)
      best.push(Promise.resolve(signals.networkIdle(budget)).catch(() => {}));
    if (signals.loadersGone)
      best.push(Promise.resolve(signals.loadersGone(budget)).catch(() => {}));
    await Promise.all(best);
  }

  if (tailMs > 0) await wait(tailMs);
  return { elapsedMs: now() - start };
}

// Let a SPA settle after a navigation/click before the agent observes: wait for
// the DOM to go quiescent (primary), with bounded best-effort network/loader
// checks, all sharing one hard ceiling (config.settleMaxMs) so a page that never
// stabilizes can't hang the run. domcontentloaded consumes part of the same
// budget, so total wait never exceeds settleMaxMs (bar the small tail delay).
async function settle(page) {
  await settleLoop(
    {
      prewait: (budget) =>
        page.waitForLoadState("domcontentloaded", { timeout: Math.min(budget, 4000) }),
      quiescence: (budget) => domQuiescence(page, SETTLE_QUIET_MS, budget),
      networkIdle: (budget) =>
        page.waitForLoadState("networkidle", { timeout: Math.min(budget, SETTLE_NETWORKIDLE_MS) }),
      loadersGone: (budget) =>
        page.waitForFunction(
          () => {
            const loaders = document.querySelectorAll(
              '[aria-busy="true"], [role="progressbar"], .spinner, .loading, .loader, [class*="skeleton"], [class*="Skeleton"]',
            );
            return Array.from(loaders).every((el) => !el.getClientRects().length);
          },
          { timeout: Math.min(budget, SETTLE_LOADERS_MS) },
        ),
    },
    { maxMs: config.settleMaxMs, tailMs: SETTLE_TAIL_MS },
  );
}

// Click the first visible element matching a piece of text/label — a robust
// fallback for when the numbered [ref] list is stale or the target isn't listed.
async function clickByText(page, text) {
  const name = String(text ?? "").trim();
  if (!name) throw new Error("clickText needs a non-empty text");
  const candidates = [
    page.getByRole("button", { name, exact: false }),
    page.getByRole("link", { name, exact: false }),
    page.getByRole("tab", { name, exact: false }),
    page.getByRole("menuitem", { name, exact: false }),
    page.getByText(name, { exact: false }),
  ];
  for (const loc of candidates) {
    const el = loc.first();
    if ((await el.count().catch(() => 0)) > 0 && (await el.isVisible().catch(() => false))) {
      await el.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
      try {
        await el.click({ timeout: 8000 });
      } catch {
        await el.click({ force: true, timeout: 5000 });
      }
      return true;
    }
  }
  return false;
}

// Perform one (non-terminal) action. `handle` is the ElementHandle for d.ref (if any).
// Returns a human "what happened".
async function applyAction(page, d, handle) {
  switch (d.action) {
    case "navigate": {
      await page.goto(normalizeUrl(d.url), {
        waitUntil: "domcontentloaded",
        timeout: config.playwrightNavTimeoutMs,
      });
      await settle(page);
      return `Loaded ${page.url()}`;
    }
    case "type": {
      if (!handle) throw new Error(`No element [${d.ref}] in the current page`);
      const text = String(d.text ?? "");
      await handle.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
      try {
        await handle.fill(text, { timeout: 8000 });
      } catch {
        try {
          await handle.focus({ timeout: 4000 });
          await page.keyboard.type(text, { delay: 15 });
        } catch {
          await handle.click({ force: true, timeout: 4000 });
          await page.keyboard.type(text, { delay: 15 });
        }
      }
      return `Typed "${truncate(text, 60)}"`;
    }
    case "click": {
      if (!handle) throw new Error(`No element [${d.ref}] in the current page`);
      await handle.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
      try {
        await handle.click({ timeout: 10000 });
      } catch {
        await handle.click({ force: true, timeout: 5000 });
      }
      await settle(page);
      return "Clicked";
    }
    case "clickText": {
      const found = await clickByText(page, d.text);
      if (!found) throw new Error(`No visible element found with text "${truncate(d.text, 40)}"`);
      await settle(page);
      return `Clicked "${truncate(d.text, 40)}" (by text)`;
    }
    case "press": {
      if (handle) await handle.press(d.key || "Enter", { timeout: 8000 });
      else await page.keyboard.press(d.key || "Enter");
      await settle(page);
      return `Pressed ${d.key || "Enter"}`;
    }
    case "select": {
      if (!handle) throw new Error(`No element [${d.ref}] in the current page`);
      await handle.selectOption(String(d.value ?? ""), { timeout: 8000 });
      return `Selected "${truncate(d.value, 40)}"`;
    }
    case "hover": {
      if (!handle) throw new Error(`No element [${d.ref}] in the current page`);
      await handle.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
      await handle.hover({ timeout: 8000 });
      await page.waitForTimeout(500);
      return "Hovered (revealing any fly-out menu)";
    }
    case "scroll": {
      await page.evaluate((dir) => window.scrollBy(0, dir === "up" ? -700 : 700), d.direction);
      await page.waitForTimeout(400);
      return `Scrolled ${d.direction || "down"}`;
    }
    default:
      throw new Error(`Unknown action "${d.action}"`);
  }
}

// Tiny filename matcher for expectDownload's optional expectFilename: supports
// "*" globs ("*.pdf", "report-*.csv") and falls back to substring match.
export function matchFilename(name, pattern) {
  if (!pattern) return true;
  const n = String(name);
  if (!pattern.includes("*")) return n.toLowerCase().includes(pattern.toLowerCase());
  const escaped = pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp("^" + escaped.join(".*") + "$", "i").test(n);
}

// URL matcher for mockRequest/expectRequest patterns. Uses Playwright-native
// glob semantics (same language page.route() understands, so mock and assert
// patterns behave identically): `**` = any chars incl. path separators, `*` =
// any chars within a segment-ish span, `?` = one char. A pattern with NO glob
// metacharacter falls back to a plain case-insensitive substring test (so
// "/api/orders" matches without the caller needing wildcards). A malformed glob
// simply fails to match — a safe, legible failure, unlike a bad regex.
export function matchUrlGlob(url, pattern) {
  if (!pattern) return true;
  const u = String(url);
  const p = String(pattern);
  if (!/[*?]/.test(p)) return u.toLowerCase().includes(p.toLowerCase());
  // Escape regex specials, then translate glob tokens. `**` -> .*, `*` -> [^]* is
  // overkill; Playwright treats both `*` and `**` as "any chars", so we map both
  // to `.*` and `?` to a single char. Order matters: handle `**` before `*`.
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") i++; // collapse ** and * to the same "any chars"
      re += ".*";
    } else if (c === "?") {
      re += ".";
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  try {
    return new RegExp("^" + re + "$", "i").test(u);
  } catch {
    return false;
  }
}

// mockRequest: stub or force a response for requests matching a URL glob. Uses
// page.route (page-scoped, so it's torn down automatically when the per-test page
// closes — never leaks across pooled context reuse). Records the pattern in
// mockedPatterns so a deliberately-mocked error isn't flagged in forensics.
// The route only intercepts matching requests; everything else passes through.
export async function doMockRequest(page, d, mockedPatterns) {
  const pattern = String(d.urlPattern || "").trim();
  if (!pattern) throw new Error(`mockRequest needs a "urlPattern" (e.g. "**/api/orders").`);
  const status = Number.isFinite(d.status) ? d.status : Number(d.status) || 200;
  const wantMethod = d.method ? String(d.method).toUpperCase() : null;
  const delayMs = Math.min(Math.max(Number(d.delayMs) || 0, 0), 15000);
  const body = d.body != null ? String(d.body) : "";
  // Content-type: JSON if the body parses as JSON, else plain text.
  let contentType = "text/plain; charset=utf-8";
  if (body) {
    try {
      JSON.parse(body);
      contentType = "application/json";
    } catch {
      /* keep text/plain */
    }
  }

  await page.route(pattern, async (route, request) => {
    // If a method filter is set and this request doesn't match, let it through
    // untouched so we only mock what was asked for.
    if (wantMethod && request.method().toUpperCase() !== wantMethod) {
      return route.fallback();
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    await route.fulfill({ status, contentType, body });
  });

  mockedPatterns.push(pattern);
  const suffix = wantMethod ? ` (${wantMethod})` : "";
  const delayNote = delayMs > 0 ? `, +${delayMs}ms` : "";
  return `Mocking ${pattern}${suffix} → ${status}${delayNote}`;
}

// expectRequest: assert that a request matching urlPattern (a glob) fired during
// the run. Optional filters: method, bodyContains (substring of the request's
// post body), and sinceStep (only requests logged at/after that agent step, so
// an assertion isn't satisfied by unrelated earlier page-load traffic). Pure
// over the captured requestLog — no browser needed, so it's directly unit-tested.
// Returns { ok, detail, evidence }.
export function doExpectRequest(requestLog, d) {
  const pattern = String(d.urlPattern || "").trim();
  if (!pattern) throw new Error(`expectRequest needs a "urlPattern" (e.g. "**/api/orders").`);
  const wantMethod = d.method ? String(d.method).toUpperCase() : null;
  const bodyNeedle = d.bodyContains != null ? String(d.bodyContains) : null;
  const sinceStep = Number.isFinite(d.sinceStep) ? d.sinceStep : Number(d.sinceStep);
  const since = Number.isFinite(sinceStep) ? sinceStep : null;

  // The window we searched, for a legible failure message.
  const inWindow = requestLog.filter((r) => (since == null ? true : r.step >= since));

  const match = inWindow.find((r) => {
    if (!matchUrlGlob(r.url, pattern)) return false;
    if (wantMethod && r.method.toUpperCase() !== wantMethod) return false;
    if (bodyNeedle && !String(r.postData || "").includes(bodyNeedle)) return false;
    return true;
  });

  const want =
    `${wantMethod ? wantMethod + " " : ""}${pattern}` +
    (bodyNeedle ? ` with body containing "${truncate(bodyNeedle, 60)}"` : "") +
    (since != null ? ` (since step ${since})` : "");

  if (match) {
    return {
      ok: true,
      detail: `Saw ${match.method} ${truncate(match.url, 100)}`,
      evidence: { matched: { method: match.method, url: match.url, step: match.step } },
    };
  }

  // No match: list what WAS seen in the window (deduped, capped) so a failing
  // test is debuggable — "expected X, but the only requests were Y, Z".
  const seen = [...new Set(inWindow.map((r) => `${r.method} ${truncate(r.url, 100)}`))].slice(0, 8);
  const seenNote = seen.length
    ? `Requests observed${since != null ? ` since step ${since}` : ""}: ${seen.join("; ")}`
    : `No requests were observed${since != null ? ` since step ${since}` : ""}.`;
  return {
    ok: false,
    detail: `Expected a request matching ${want}, but none fired. ${seenNote}`,
    evidence: { expected: want, observed: seen },
  };
}

// uploadFile: attach a fixture to a file input. Uses setInputFiles directly on
// an <input type=file> (bypasses the OS picker entirely — no hang, no dialog
// interaction). If the ref is a trigger button/label instead, fall back to the
// filechooser event it opens.
export async function doUpload(page, d, handle, test) {
  if (!handle) throw new Error(`No element [${d.ref}] in the current page`);
  const filePath = await resolveFixture(d.fixture, { testId: test?.id ?? test?._id });
  const tag = await handle
    .evaluate((el) => `${el.tagName?.toLowerCase()}|${(el.getAttribute("type") || "").toLowerCase()}`)
    .catch(() => "");
  if (tag === "input|file") {
    await handle.setInputFiles(filePath, { timeout: config.playwrightTimeoutMs });
  } else {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: config.playwrightTimeoutMs }),
      handle.click({ timeout: config.playwrightTimeoutMs }),
    ]);
    await chooser.setFiles(filePath);
  }
  await settle(page);
  return `Uploaded ${path.basename(filePath)}`;
}

// expectDownload: atomically arm the download listener AND click the trigger, so
// there's no window where a listener is armed but the click never comes. Saves
// the file into the run's artifacts dir and returns an artifact record so it
// surfaces in run history and reports. Success = event fired within the timeout,
// non-zero bytes, and (optionally) the suggested filename matches expectFilename.
export async function doExpectDownload(page, d, handle, artifactScope) {
  if (!handle) throw new Error(`No element [${d.ref}] in the current page`);
  let download;
  try {
    [download] = await Promise.all([
      page.waitForEvent("download", { timeout: config.downloadTimeoutMs }),
      handle.click({ timeout: config.playwrightTimeoutMs }),
    ]);
  } catch {
    throw new Error(
      `Expected a file download, but none started within ${config.downloadTimeoutMs}ms.`,
    );
  }
  const suggested = download.suggestedFilename() || "download.bin";
  const savePath = path.join(artifactScope.dir, "downloads", suggested);
  await fs.mkdir(path.dirname(savePath), { recursive: true });
  await download.saveAs(savePath);
  const { size } = await fs.stat(savePath);
  if (size === 0) throw new Error(`Download "${suggested}" saved but is empty (0 bytes).`);
  if (!matchFilename(suggested, d.expectFilename)) {
    throw new Error(
      `Downloaded "${suggested}" but expected the filename to match "${d.expectFilename}".`,
    );
  }
  return {
    detail: `Downloaded ${suggested} (${size} bytes)`,
    artifact: {
      kind: "file",
      label: `Download: ${suggested}`,
      url: `${artifactScope.publicUrlBase}/downloads/${encodeURIComponent(suggested)}`,
    },
  };
}

// Recover a ref the model mentioned in prose ("input #4", "element 7", "field 3")
// but forgot to put in the structured `ref` field.
function extractRef(textParts) {
  const m = String(textParts).match(
    /(?:\bref\b|\belement\b|\bfield\b|\binput\b|\bbutton\b|#)\s*#?\s*(\d{1,3})/i,
  );
  return m ? Number(m[1]) : null;
}

function actionLabel(d) {
  switch (d.action) {
    case "navigate":
      return `Go to ${d.url}`;
    case "type":
      return `Type "${truncate(d.text, 40)}"`;
    case "click":
      return `Click element [${d.ref}]`;
    case "clickText":
      return `Click "${truncate(d.text, 40)}"`;
    case "press":
      return `Press ${d.key || "Enter"}`;
    case "select":
      return `Select "${truncate(d.value, 40)}"`;
    case "hover":
      return `Hover element [${d.ref}]`;
    case "uploadFile":
      return `Upload ${d.fixture || "file"} to [${d.ref}]`;
    case "expectDownload":
      return `Download via [${d.ref}]${d.expectFilename ? ` (expect ${d.expectFilename})` : ""}`;
    case "mockRequest":
      return `Mock ${d.method ? d.method + " " : ""}${truncate(d.urlPattern || "request", 40)}${d.status ? ` → ${d.status}` : ""}`;
    case "expectRequest":
      return `Expect ${d.method ? d.method + " " : ""}${truncate(d.urlPattern || "request", 40)}`;
    case "wait":
      return `Wait ${d.ms || 1000}ms`;
    case "scroll":
      return `Scroll ${d.direction || "down"}`;
    case "ask":
      return `Ask: ${truncate(d.question, 60)}`;
    case "finish":
      return "Finish";
    default:
      return d.action || "Step";
  }
}

// A step is a verifiable assertion if it reads like one ("assert/expect/verify…"
// or "…is visible/displayed/shown"). Action steps (type/click/open) are ignored.
export function isAssertionStep(step) {
  return /\b(assert|expect|verif(?:y|ies)|ensure|confirm|should\s+(?:see|show|display|contain|be|have|redirect|land)|is\s+(?:visible|displayed|shown|present)|are\s+(?:visible|displayed|shown))\b/i.test(
    step,
  );
}

// Pull quoted substrings out of a step, e.g. Assert toast 'Saved' -> ["Saved"].
function extractQuoted(step) {
  const out = [];
  const re = /['"“”]([^'"“”]{2,})['"“”]/g;
  let m;
  while ((m = re.exec(step))) out.push(m[1].trim());
  return out;
}

/**
 * Concretely verify a test's stated assertion steps against EVERYTHING observed
 * during the run (transient toasts included, via the accumulated text) plus the
 * URLs visited. Returns pass/fail results; steps with no concretely-checkable
 * target are skipped so we never falsely fail. This turns the agent's
 * self-judged "success" into an evidence-backed pass.
 */
export function verifyAssertions({ steps, seenText, seenUrls, finalUrl }) {
  const results = [];
  const hay = (seenText || "").toLowerCase();
  // Punctuation/spacing-insensitive haystack, so an assertion for "Presales"
  // matches a page that renders "Pre-Sales" / "pre sales" (same words, cosmetic
  // separators). Avoids false failures on trivial formatting differences.
  const loose = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const normHay = loose(hay);
  const urls = [...(seenUrls || []), finalUrl || ""].map((u) => String(u || "").toLowerCase());

  for (const raw of steps || []) {
    const step = String(raw || "").trim();
    if (!step || !isAssertionStep(step)) continue;

    // URL / redirect assertions: "…url contains /dashboard", "redirects to /home".
    const urlMatch = step.match(
      /\b(?:url|redirect(?:ed|s)?(?:\s+to)?|navigates?\s+to|lands?\s+on)\b[^\n]*?(https?:\/\/[^\s'"]+|\/[\w\-./?=&%#]+)/i,
    );
    if (urlMatch) {
      const target = urlMatch[1].toLowerCase();
      const ok = urls.some((u) => u.includes(target));
      results.push({
        ok,
        label: truncate(step, 80),
        detail: ok
          ? `URL matched "${target}"`
          : `Expected the URL to contain "${target}", but it never did`,
      });
      continue;
    }

    // Quoted-text assertions: check the text was seen at any point in the run,
    // first exactly then punctuation/spacing-insensitively.
    for (const q of extractQuoted(step)) {
      const ok = hay.includes(q.toLowerCase()) || (loose(q) !== "" && normHay.includes(loose(q)));
      results.push({
        ok,
        label: truncate(step, 80),
        detail: ok ? `Found "${q}" on the page` : `Expected to see "${q}", but it never appeared`,
      });
    }
  }
  return results;
}

// Check if test has any login/authentication instructions
function hasLoginInstructions(test) {
  const allText = [test.title, test.description, ...(test.steps || [])].join(" ").toLowerCase();

  return /login|sign\s*in|authenticate|password|username|email/i.test(allText);
}

/**
 * Run a test as a DOM-aware agent: observe the page, decide one action, execute,
 * re-observe — until the model finishes (or the step budget is exhausted).
 * @returns { status, durationMs, failureReason?, actions, steps, output, artifacts }
 */
export async function runTest({
  test,
  environment,
  onEvent = () => {},
  ask = async () => null,
  savedLogin = "",
  onLearnLogin = async () => {},
  onUsage = () => {},
  secrets = {},
  storageStateLoad = undefined,
  storageStatePath = undefined,
  onSaveStorageState = async () => {},
  signal,
  runId = "run",
  attempt = 1,
  model,
  // When provided, reuse this LIVE context (shared across a category) instead of
  // launching a fresh browser — the page is authenticated already. The context
  // is NOT closed here; the pool owns its lifecycle.
  sharedContext = undefined,
  // True when we expect to already be logged in (disk session restored, or a
  // reused live context that logged in on an earlier test).
  sessionReused = false,
  // Site-memory: lessons from past runs on this site, pre-formatted for the prompt.
  hints = "",
}) {
  const startedAt = Date.now();
  const steps = [];
  const history = [];
  const artifacts = [];
  // Observations mined into site-memory after the run (see memory-logic.js).
  const dialogHeadings = new Set();
  let sawLoginForm = false;
  const artifactScope = await ensureArtifactDir("runs", runId, `attempt-${attempt}`);

  // We expect to already be authenticated ONLY when a session was actually
  // restored (disk session) or a live context was reused. A fresh pooled context
  // on the first test is NOT logged in — so we must NOT tell the model it's
  // logged in there (that + the app's "session_expired" URL made it loop).
  const expectLoggedIn = !!storageStateLoad || !!sessionReused;

  let task = [
    `${test.code} — ${test.title}`,
    test.description && test.description !== "No description provided." ? test.description : "",
    test.steps && test.steps.length ? `Stated steps: ${test.steps.join("; ")}` : "",
    environment?.url ? `Base URL for relative paths: ${environment.url}` : "",
    expectLoggedIn
      ? `SESSION: You are ALREADY LOGGED IN — a saved session was restored. Do NOT log in again; ` +
        `skip any login/sign-in step and go straight to the task. Only log in if you actually SEE a ` +
        `login/sign-in form on the page (that means the session expired).`
      : "",
    savedLogin
      ? `Login instructions${expectLoggedIn ? " (use ONLY if the session expired and a login form appears)" : " (saved for this environment)"}: ${savedLogin}`
      : "",
    test.attachments && test.attachments.length
      ? `Reference screenshots attached: ${test.attachments.length} image(s) provided for visual context.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Inject environment secrets: any {{KEY}} in the task is replaced with the
  // decrypted value before it reaches the model.
  task = substituteSecrets(task, secrets);

  const taskUrl = (task.match(/https?:\/\/[^\s"'<>]+/) || [])[0];
  // Is the whole point of this test to open/see a popup/modal/dialog? If so,
  // once one is open the goal is met — used to stop open/close dithering.
  const isPopupTask = /\b(pop-?\s?up|modal|dialog|overlay|fly-?out|lightbox|drawer)\b/i.test(task);

  const finish = (i, label, status, detail) => {
    steps.push({ index: i, label, status, detail });
    onEvent({ type: "step", index: i, label, status, detail });
  };

  let browser;
  let context;
  let page;
  let video;
  // Whether we're running on the shared/pooled context. May flip to false if the
  // pooled context turns out to be unusable (we then launch a standalone one).
  let pooled = !!sharedContext;

  // Failure forensics, collected live via page event listeners (see below).
  const consoleErrors = [];
  const networkFailures = [];
  const CAP = 50;

  // Everything observed during the run — used to verify assertions at the end
  // (so a transient toast that appeared mid-run still counts).
  const seenTextParts = [];
  const seenUrls = new Set();

  // ── Network assertion/mocking layer (Q5/Q10) ───────────────────────────────
  // Full-fidelity request log for expectRequest assertions (distinct from the
  // lossy, errors-only forensics list above): every request the page fires, with
  // its method, post body, and the agent step it happened on (for `sinceStep`).
  const requestLog = [];
  const REQ_CAP = 300;
  // Active mock URL globs, so response/requestfailed forensics can skip a
  // deliberately-mocked response instead of flagging it as a real failure.
  const mockedPatterns = [];
  // The current agent step, stamped onto each logged request. Updated by the
  // main loop; starts at 0 for page-load traffic before the first action.
  let currentStep = 0;
  const setCurrentStep = (n) => {
    currentStep = n;
  };

  // Attach forensics + safety listeners to a page. Called for the main page and
  // any popup/new tab we switch into, so nothing is missed.
  function attachPageHandlers(p) {
    p.on("console", (msg) => {
      const type = msg.type();
      if ((type === "error" || type === "warning") && consoleErrors.length < CAP) {
        consoleErrors.push({ type, text: truncate(msg.text(), 300) });
      }
    });
    p.on("pageerror", (err) => {
      if (consoleErrors.length < CAP) {
        consoleErrors.push({ type: "pageerror", text: truncate(err?.message || String(err), 300) });
      }
    });
    // Full-fidelity assertion log: every request, with method + post body +
    // the agent step it fired on. Separate from the forensics list below.
    p.on("request", (req) => {
      if (requestLog.length < REQ_CAP) {
        requestLog.push({
          url: req.url(),
          method: req.method(),
          postData: (() => {
            try {
              return req.postData() || "";
            } catch {
              return "";
            }
          })(),
          step: currentStep,
        });
      }
    });
    p.on("requestfailed", (req) => {
      // A deliberately-mocked request isn't a real failure — don't flag it.
      if (mockedPatterns.some((pat) => matchUrlGlob(req.url(), pat))) return;
      if (networkFailures.length < CAP) {
        networkFailures.push({
          url: truncate(req.url(), 200),
          method: req.method(),
          failure: req.failure()?.errorText || "request failed",
        });
      }
    });
    p.on("response", (resp) => {
      const status = resp.status();
      // Skip forensics for a deliberately-mocked response (e.g. a forced 500):
      // it's expected, not a real network failure.
      if (mockedPatterns.some((pat) => matchUrlGlob(resp.url(), pat))) return;
      if (status >= 400 && networkFailures.length < CAP) {
        networkFailures.push({
          url: truncate(resp.url(), 200),
          method: resp.request().method(),
          status,
        });
      }
    });
    // Auto-handle JS dialogs (alert/confirm/prompt/beforeunload). Left unhandled,
    // these BLOCK the page until timeout and freeze the whole run. Accept by
    // default so flows that pop a "are you sure?" confirm proceed.
    p.on("dialog", async (dialog) => {
      history.push(`Auto-accepted a ${dialog.type()} dialog: "${truncate(dialog.message(), 80)}"`);
      try {
        await dialog.accept();
      } catch {
        await dialog.dismiss().catch(() => {});
      }
    });
  }

  async function finalize(status, failureReason, explicitOutput) {
    let output = explicitOutput;
    if (!output && page) output = await captureOutput(page, artifactScope).catch(() => undefined);

    // Save a DOM-at-end snapshot for inline triage (before we close the page).
    let domSnapshotUrl;
    if (page) {
      try {
        const html = await page.content();
        await fs.writeFile(path.join(artifactScope.dir, "dom-snapshot.html"), html);
        domSnapshotUrl = `${artifactScope.publicUrlBase}/dom-snapshot.html`;
        artifacts.push({ kind: "html", label: "DOM snapshot", url: domSnapshotUrl });
      } catch {
        /* best-effort */
      }
    }

    // Evidence-backed assertion check: verify the test's stated "assert/expect"
    // steps actually happened (against everything seen during the run), so the
    // agent can't declare a false pass.
    if (status === "passed" && page) {
      // Let any last async content settle, then re-read the page so late-rendered
      // text (toasts, lazy content) is counted before verifying assertions.
      await settle(page).catch(() => {});
      const finalText = await page
        .locator("body")
        .innerText({ timeout: 2000 })
        .catch(() => "");
      if (output?.text) seenTextParts.push(output.text);
      if (finalText) seenTextParts.push(finalText);
      const seenText = seenTextParts.join("\n").slice(-60000);
      const results = verifyAssertions({
        steps: test.steps,
        seenText,
        seenUrls: [...seenUrls],
        finalUrl: page.url(),
      });
      for (const r of results) {
        const step = {
          index: steps.length,
          label: `Verify: ${r.label}`,
          status: r.ok ? "pass" : "fail",
          detail: r.detail,
        };
        steps.push(step);
        onEvent({ type: "step", ...step });
      }
      const failedCheck = results.find((r) => !r.ok);
      if (failedCheck) {
        status = "failed";
        failureReason = `Assertion not met — ${failedCheck.detail}`;
      }
    }

    if (status === "passed" && page) {
      const assertionResult = await runPostAssertions({
        page,
        test,
        artifactScope,
        steps,
        onEvent,
        startIndex: steps.length,
      });
      artifacts.push(...assertionResult.artifacts);
      if (assertionResult.failureReason) {
        status = "failed";
        failureReason = assertionResult.failureReason;
      }
    }

    if (page && output?.screenshot) {
      artifacts.push({ kind: "image", label: "Final screenshot", url: output.screenshot });
    }

    // Persist the logged-in session for reuse on the next run (only on success,
    // so we never cache a broken/half-authenticated state).
    if (status === "passed" && context && storageStatePath) {
      try {
        await context.storageState({ path: storageStatePath });
        await onSaveStorageState();
      } catch {
        /* non-fatal: session reuse is best-effort */
      }
    }

    if (context) {
      const tracePath = path.join(artifactScope.dir, "trace.zip");
      // Shared context → per-test trace chunk; standalone → stop the whole trace.
      if (pooled) await context.tracing.stopChunk({ path: tracePath }).catch(() => {});
      else await context.tracing.stop({ path: tracePath }).catch(() => {});
      if (await fileExists(tracePath)) {
        artifacts.push({
          kind: "trace",
          label: "Playwright trace",
          url: `${artifactScope.publicUrlBase}/trace.zip`,
        });
      }
    }

    // Detach the popup listener from a shared context (else listeners pile up),
    // then close only OUR page — the pool owns the shared context's lifecycle.
    if (pooled && context) context.off("page", onPopup);
    // Defensive: drop any mockRequest route handlers before closing the page.
    // page.close() already disposes page-scoped routes (so nothing leaks across a
    // pooled context reuse), but unrouting explicitly keeps teardown obvious and
    // covers the instant between close scheduling and completion.
    if (mockedPatterns.length) await page?.unrouteAll?.().catch(() => {});
    await page?.close().catch(() => {});

    if (video) {
      // Video is finalized once its page closes. For a shared context it lands
      // in the pool's media dir, so copy it into this run's artifact folder.
      const videoPath = await video.path().catch(() => null);
      if (videoPath) {
        let name = path.basename(videoPath);
        try {
          if (path.dirname(videoPath) !== artifactScope.dir) {
            name = `video-${name}`;
            await fs.copyFile(videoPath, path.join(artifactScope.dir, name)).catch(() => {});
          }
        } catch {
          /* best-effort */
        }
        artifacts.push({
          kind: "video",
          label: "Playwright video",
          url: `${artifactScope.publicUrlBase}/${name}`,
        });
      }
    }

    if (!pooled) {
      await context?.close().catch(() => {});
      // The HAR is flushed on context.close(); attach it if present.
      const harPath = path.join(artifactScope.dir, "network.har");
      if (await fileExists(harPath)) {
        artifacts.push({
          kind: "har",
          label: "Network (HAR)",
          url: `${artifactScope.publicUrlBase}/network.har`,
        });
      }
      await browser?.close().catch(() => {});
    }

    return {
      status,
      durationMs: Date.now() - startedAt,
      failureReason,
      actions: [],
      steps,
      output,
      artifacts: artifacts.filter(
        (artifact, index, list) =>
          artifact?.url && list.findIndex((item) => item.url === artifact.url) === index,
      ),
      forensics: {
        console: consoleErrors.slice(-CAP),
        network: networkFailures.slice(-CAP),
        domSnapshotUrl,
      },
      observations: {
        dialogHeadings: [...dialogHeadings],
        sawLoginForm,
      },
    };
  }

  // Follow popups / new tabs: a click that opens a new tab would otherwise
  // leave the agent driving the old, stale page. Switch to the newest tab.
  // Named so it can be detached from a shared (pooled) context afterwards.
  const onPopup = async (p) => {
    if (p === page) return;
    await p.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    attachPageHandlers(p);
    page = p;
    history.push(`A new tab opened (${truncate(p.url(), 80)}) — switched the agent to it.`);
  };

  try {
    throwIfAborted(signal);
    if (pooled) {
      // Reuse the live, already-authenticated context from the pool. A fresh
      // page per test keeps runs isolated; the context (cookies) is shared.
      try {
        context = sharedContext;
        page = await context.newPage();
        video = page.video();
        attachPageHandlers(page);
        context.on("page", onPopup);
        await context.tracing.startChunk({ title: test.code || "run" }).catch(() => {});
        if (test.viewport && test.viewport !== "desktop") {
          history.push(`Emulating a ${test.viewport} viewport.`);
        }
      } catch {
        // Pooled context unusable — fall back to a standalone browser below.
        pooled = false;
        context = null;
        page = null;
        video = undefined;
      }
    }
    if (!pooled) {
      browser = await chromium.launch({ headless: config.playwrightHeadless });
      const deviceOpts = viewportContextOptions(test.viewport);
      context = await browser.newContext({
        ...deviceOpts,
        recordVideo: { dir: artifactScope.dir, size: videoSizeFor(deviceOpts) },
        // Capture all network traffic to a HAR file (written on context close).
        recordHar: { path: path.join(artifactScope.dir, "network.har") },
        // Reuse a previously saved logged-in session for this environment, if any.
        ...(storageStateLoad ? { storageState: storageStateLoad } : {}),
      });
      if (storageStateLoad) {
        history.push("Reusing a saved login session for this environment.");
      }
      if (test.viewport && test.viewport !== "desktop") {
        history.push(`Emulating a ${test.viewport} viewport.`);
      }
      await context.tracing.start({ screenshots: true, snapshots: true });
      page = await context.newPage();
      video = page.video();
      attachPageHandlers(page);
      context.on("page", onPopup);
    }

    let lastSig = "";
    let repeat = 0;
    let decisionFails = 0;
    let askedAboutLogin = hasLoginInstructions(test) || !!savedLogin;
    let asksUsed = 0;
    const MAX_ASKS = 5;
    // Stuck detection + recovery: a fingerprint of the last page state, how many
    // consecutive actions produced no visible change, and how many recovery
    // attempts we've spent before giving up.
    let lastFp = "";
    let noProgress = 0;
    let nudges = 0;
    const MAX_NUDGES = 3;
    let announcedSession = false; // confirm login state from the real page, once
    let popupOpenSteps = 0; // how many observations have shown a popup open (popup tasks)

    // Seed the browser at the environment's base URL up front, so the agent
    // starts on the real app instead of guessing a URL for its first move
    // (which frequently hallucinates a placeholder like example.com). Skipped
    // when reusing a saved session (that already navigates) or with no URL.
    let preNavCount = 0;
    const startUrl = normalizeUrl(environment?.url || taskUrl || "");
    if (startUrl && !storageStateLoad) {
      onEvent({ type: "step", index: 0, label: `Open ${startUrl}`, status: "running" });
      try {
        await page.goto(startUrl, {
          waitUntil: "domcontentloaded",
          timeout: config.playwrightNavTimeoutMs,
        });
        await settle(page);
        finish(0, `Open ${startUrl}`, "pass", `Loaded ${page.url()}`);
        history.push(`#0 navigate -> Loaded ${page.url()} (starting page — already here)`);
      } catch (err) {
        const detail = (err.message || String(err)).split("\n")[0];
        finish(0, `Open ${startUrl}`, "fail", detail);
        history.push(`#0 navigate to ${startUrl} FAILED: ${truncate(detail, 80)}`);
      }
      preNavCount = 1;
    }

    for (let step = 1; step <= MAX_STEPS; step++) {
      throwIfAborted(signal);
      const i = step - 1 + preNavCount;
      const obs = await observe(page).catch(() => ({
        url: page.url(),
        title: "",
        elements: [],
        text: "",
        byRef: {},
        hasLoginSection: false,
        dialog: { open: false, heading: "" },
      }));

      // Record what we saw for end-of-run assertion verification.
      if (obs.text) seenTextParts.push(obs.text);
      if (obs.url) seenUrls.add(obs.url);

      // Record observations for site-memory: popups the agent met, login forms seen.
      if (obs.dialog?.open && obs.dialog.heading) dialogHeadings.add(obs.dialog.heading);
      if (obs.hasLoginSection) sawLoginForm = true;

      // Confirm login state from the ACTUAL page — but ONLY when we expected to
      // already be logged in. On a first login we stay silent and let the normal
      // login flow run (announcing "session expired" there just made it loop).
      if (expectLoggedIn && !announcedSession) {
        announcedSession = true;
        if (obs.hasLoginSection) {
          history.push(
            "A login form is showing — log in ONCE now (type the fields, then CLICK the submit button and wait), then continue with the task.",
          );
          askedAboutLogin = false; // allow the login flow to proceed
        } else {
          history.push(
            "You are already logged in (no login form) — do NOT log in; go straight to the task.",
          );
        }
      }

      // Popup/modal task: once the popup is open the goal is met. Nudge the model
      // to finish; if it keeps dithering (open→close→reopen) while a popup has
      // been open a few times, finalize as passed ourselves so it can't loop.
      if (isPopupTask && obs.dialog?.open) {
        popupOpenSteps += 1;
        const name = obs.dialog.heading || "popup";
        if (popupOpenSteps === 1) {
          history.push(
            `The "${name}" popup is OPEN — this satisfies the task. Call finish success=true NOW; do NOT close or reopen it.`,
          );
        } else if (popupOpenSteps >= 3) {
          finish(i, "Popup opened — goal met", "pass", `The "${name}" popup is open.`);
          const output = (await captureOutput(page, artifactScope).catch(() => undefined)) ?? {};
          output.result = `The "${name}" popup opened successfully.`;
          return finalize("passed", undefined, output);
        }
      }

      // Did the previous action actually change the page? Track consecutive
      // no-change steps and tell the model, so it stops retrying dead actions.
      const fp = pageFingerprint(obs);
      if (lastFp && fp === lastFp) {
        noProgress += 1;
        history.push(
          `#${step} NOTE: the previous action produced NO visible change — try a DIFFERENT approach.`,
        );
      } else {
        noProgress = 0;
      }
      lastFp = fp;

      if (obs.hasLoginSection && !askedAboutLogin) {
        askedAboutLogin = true;
        let host = "the page";
        try {
          host = new URL(page.url()).hostname || host;
        } catch {
          /* keep fallback */
        }
        const answer = await ask({
          question:
            `I found a login / account-creation form on ${host}, but this test has no login instructions. ` +
            `Reply with the credentials or steps to use (e.g. "log in with admin@example.com / hunter2") and I'll continue, ` +
            `or reply "skip" to test the public areas without signing in.`,
          testCode: test.code,
        });

        const reply = (answer ?? "").trim();
        if (reply && !/^(skip|no|ignore)\b/i.test(reply)) {
          task += `\nLogin instructions (provided by the user): ${reply}`;
          history.push(`User provided login instructions: ${truncate(reply, 100)}`);
          await onLearnLogin(reply).catch(() => {});
        } else {
          history.push(
            reply
              ? "User chose to skip login — testing public areas only."
              : "No login instructions provided (timed out) — testing public areas only.",
          );
        }
      }

      try {
        const shot = await screenshotDataUrl(page, 45);
        if (shot) onEvent({ type: "screenshot", index: i, dataUrl: shot });

        let d;
        try {
          d = await decideAction({
            task,
            hints,
            url: obs.url,
            elements: obs.elements,
            text: obs.text,
            dialog: obs.dialog,
            history,
            stepNo: step,
            maxSteps: MAX_STEPS,
            // Full data URLs; the provider layer strips the prefix for Ollama and
            // converts them to image blocks for Claude.
            imageBase64: config.ollamaVision && shot ? shot : undefined,
            contextImages:
              config.ollamaVision && step === 1 && test.attachments?.length
                ? test.attachments.filter(Boolean)
                : undefined,
            onUsage,
            model,
            signal, // lets Stop cancel the in-flight model call immediately
          });
          decisionFails = 0;
        } catch (err) {
          // A Stop aborts the model fetch — end the run promptly, don't retry.
          if (signal?.aborted || err.message === "Stopped by user.") {
            return finalize("failed", "Stopped by user.");
          }
          decisionFails += 1;
          finish(i, "Decide next action", "fail", `Model response error: ${err.message}`);
          history.push(`#${step} decide FAILED: ${truncate(err.message, 80)}`);
          if (decisionFails >= 4) {
            return finalize(
              "failed",
              `Agent could not get a valid decision after ${decisionFails} tries: ${err.message}`,
            );
          }
          continue;
        }

        // Stop may have been requested while the model was thinking.
        throwIfAborted(signal);

        const label = d.thought?.trim() ? truncate(d.thought, 90) : actionLabel(d);
        const sig = `${d.action}|${d.ref ?? ""}|${d.url ?? ""}|${d.text ?? ""}|${d.question ?? ""}`;
        repeat = sig === lastSig ? repeat + 1 : 0;
        lastSig = sig;

        // Stuck = the exact same action 3× in a row, OR 3 consecutive actions
        // with no visible page change. Rather than fail instantly, escalate:
        // nudge the model AND auto-recover (scroll to reveal hidden content, wait
        // for late loads) for a few rounds. Only give up if recovery keeps
        // failing — but never on a benign wait, which is a valid stall tactic.
        // expectDownload legitimately produces no visible page change, so don't
        // let the no-progress detector punish it (same treatment as wait/ask).
        const stuck =
          (repeat >= 2 || noProgress >= 3) &&
          !["wait", "ask", "expectDownload", "mockRequest", "expectRequest"].includes(d.action);
        if (stuck) {
          if (nudges >= MAX_NUDGES) {
            finish(
              i,
              label,
              "fail",
              "Agent is stuck — the page isn't changing after repeated attempts.",
            );
            return finalize(
              "failed",
              "Agent got stuck: repeated actions with no progress after several recovery attempts.",
            );
          }
          nudges += 1;
          history.push(
            `⚠ STUCK: your recent actions aren't changing the page` +
              (repeat >= 2 ? ` and you repeated "${d.action}"` : "") +
              `. STOP repeating it. Try something DIFFERENT: pick another element by [ref], ` +
              `SCROLL to reveal more, WAIT for content to load, dismiss any overlay/modal, navigate ` +
              `to a likely path, or if truly blocked use "ask", or "finish" with success:false.`,
          );
          // Auto-recovery: alternate scrolling down/up to surface off-screen
          // controls, then wait — a common cause is a target that's not in view.
          const dy = nudges % 2 === 1 ? 700 : -700;
          await page.evaluate((y) => window.scrollBy(0, y), dy).catch(() => {});
          await page.waitForTimeout(600);
          history.push(
            `#${step} recovery ${nudges}/${MAX_NUDGES}: scrolled ${dy > 0 ? "down" : "up"} + waited.`,
          );
          onEvent({
            type: "step",
            index: i,
            label: "Recovering from a stuck state",
            status: "pass",
            detail: `Nudged the agent and scrolled to reveal more (attempt ${nudges}/${MAX_NUDGES}).`,
          });
          // Give the recovery a fair re-evaluation on the next observe.
          lastFp = "";
          noProgress = 0;
          repeat = 0;
          lastSig = "";
          continue;
        }

        if (d.action === "finish") {
          const wantsValue =
            /\b(get|read|fetch|find|retrieve|extract|how many|what is|value of)\b/i.test(task);
          const hasResult = !!(d.result && d.result.trim());
          const ok = d.success !== false && (!wantsValue || hasResult);
          const detail = ok
            ? d.result || "Task complete."
            : d.result ||
              (wantsValue && !hasResult
                ? "Finished without returning the requested value."
                : "Task could not be completed.");
          finish(i, ok ? "Finished" : "Gave up", ok ? "pass" : "fail", detail);
          const output = (await captureOutput(page, artifactScope).catch(() => undefined)) ?? {};
          if (output) output.result = d.result;
          return finalize(ok ? "passed" : "failed", ok ? undefined : detail, output);
        }

        if (d.action === "ask") {
          const question =
            (d.question ?? "").trim() || "I'm unsure how to proceed — what should I do?";
          if (asksUsed >= MAX_ASKS) {
            history.push(
              `#${step} ask SKIPPED (already asked ${MAX_ASKS} times) — proceeding on your best judgement.`,
            );
            continue;
          }
          asksUsed += 1;
          onEvent({ type: "step", index: i, label, status: "running" });
          throwIfAborted(signal);
          const answer = (await ask({ question, testCode: test.code })) ?? "";
          const reply = answer.trim();
          history.push(
            reply
              ? `#${step} asked: "${truncate(question, 80)}" -> user said: "${truncate(reply, 120)}"`
              : `#${step} asked: "${truncate(question, 80)}" -> no reply; use your best judgement.`,
          );
          steps.push({ index: i, label, status: "pass", detail: reply || "No reply." });
          onEvent({ type: "step", index: i, label, status: "pass", detail: reply || "No reply." });
          continue;
        }

        if (d.action === "navigate") {
          d.url = resolveNav(d.url, page.url(), taskUrl);
          d.url = redirectPlaceholder(d.url, environment?.url || taskUrl);
        }

        const needsRef = [
          "type",
          "click",
          "select",
          "hover",
          "uploadFile",
          "expectDownload",
        ].includes(d.action);
        if (needsRef) {
          if (typeof d.ref === "string" && /^\d+$/.test(d.ref.trim())) d.ref = Number(d.ref.trim());
          if (!obs.byRef[d.ref]) {
            const guess = extractRef(`${d.thought ?? ""} ${d.text ?? ""}`);
            if (guess != null && obs.byRef[guess]) d.ref = guess;
          }
          if (!obs.byRef[d.ref]) {
            const detail = `Action "${d.action}" referenced element [${d.ref ?? "?"}] which isn't in the list — pick a valid [ref] number.`;
            finish(i, label, "fail", detail);
            history.push(`#${step} ${d.action} INVALID ref ${d.ref ?? "?"}`);
            continue;
          }
        }

        onEvent({ type: "step", index: i, label, status: "running" });
        // Stamp subsequent network requests with this step, so expectRequest's
        // `sinceStep` can scope assertions to traffic from a given action onward.
        setCurrentStep(step);
        try {
          throwIfAborted(signal);
          let detail;
          if (d.action === "wait") {
            const ms = Math.min(Math.max(Number(d.ms) || 1000, 100), 8000);
            await page.waitForTimeout(ms);
            detail = `Waited ${ms}ms`;
          } else if (d.action === "uploadFile") {
            detail = await doUpload(page, d, obs.byRef[d.ref], test);
          } else if (d.action === "expectDownload") {
            const dl = await doExpectDownload(page, d, obs.byRef[d.ref], artifactScope);
            if (dl.artifact) artifacts.push(dl.artifact);
            detail = dl.detail;
          } else if (d.action === "mockRequest") {
            detail = await doMockRequest(page, d, mockedPatterns);
          } else if (d.action === "expectRequest") {
            const res = doExpectRequest(requestLog, d);
            if (!res.ok) {
              // An explicit network assertion that didn't hold is a definitive
              // failure — end the run now so a later finish can't paper over it.
              finish(i, label, "fail", res.detail);
              history.push(`#${step} expectRequest FAILED: ${truncate(res.detail, 90)}`);
              return finalize("failed", res.detail);
            }
            detail = res.detail;
          } else {
            detail = await applyAction(page, d, obs.byRef[d.ref]);
          }
          throwIfAborted(signal);
          steps.push({ index: i, label, status: "pass", detail });
          onEvent({ type: "step", index: i, label, status: "pass", detail });
          history.push(
            `#${step} ${d.action}${d.ref != null ? ` [${d.ref}]` : ""} -> ${truncate(detail, 80)}`,
          );
        } catch (err) {
          const detail = (err.message || String(err)).split("\n")[0];
          if (detail === "Stopped by user.") return finalize("failed", detail);

          // Auto-recover from transient element failures (element re-rendered /
          // detached, click intercepted by an overlay, not-yet-visible, timeout):
          // re-observe and retry the SAME intent once — matching the element by
          // its descriptor so a changed [ref] doesn't matter. No model round-trip,
          // which fixes most flaky one-off failures without ending the test.
          const transient =
            /not attached|detached|intercept|not visible|stale|timeout|Element is not|no node found/i.test(
              detail,
            );
          const isRefAction = ["type", "click", "select", "hover"].includes(d.action);
          let recovered = false;
          if (transient && isRefAction) {
            const desc = obs.elements.find((e) => e.ref === d.ref)?.descriptor;
            await settle(page).catch(() => {});
            const obs2 = await observe(page).catch(() => null);
            if (obs2) {
              let retriedDetail = null;
              try {
                throwIfAborted(signal);
                const match = desc ? obs2.elements.find((e) => e.descriptor === desc) : null;
                const handle = match ? obs2.byRef[match.ref] : null;
                if (handle)
                  retriedDetail = await applyAction(page, { ...d, ref: match.ref }, handle);
              } catch {
                /* retry failed — fall through to record the failure */
              } finally {
                for (const h of Object.values(obs2.byRef ?? {})) await h.dispose().catch(() => {});
              }
              if (retriedDetail != null) {
                recovered = true;
                steps.push({
                  index: i,
                  label,
                  status: "pass",
                  detail: `${retriedDetail} (recovered)`,
                });
                onEvent({
                  type: "step",
                  index: i,
                  label,
                  status: "pass",
                  detail: `${retriedDetail} (recovered after a transient error)`,
                });
                history.push(`#${step} ${d.action} recovered -> ${truncate(retriedDetail, 70)}`);
              }
            }
          }

          if (!recovered) {
            steps.push({ index: i, label, status: "fail", detail });
            onEvent({ type: "step", index: i, label, status: "fail", detail });
            history.push(`#${step} ${d.action} FAILED: ${truncate(detail, 80)}`);
          }
        }
      } finally {
        for (const h of Object.values(obs.byRef ?? {})) await h.dispose().catch(() => {});
      }
    }

    return finalize("failed", `Did not complete within ${MAX_STEPS} steps.`);
  } catch (err) {
    return finalize(
      "failed",
      err.message === "Stopped by user." ? err.message : `Browser error: ${err.message}`,
    );
  }
}

/**
 * Open the app like the agent would (navigate, log in if needed, look around),
 * and return a text "page map" — landing content, interactive controls, and the
 * app's sections — so the suite generator writes tests grounded in the REAL
 * page instead of guessing. Best-effort and fully guarded: returns whatever it
 * gathered (or an empty map) rather than throwing.
 */
// Pull the structured skeleton of the current page — headings, form fields
// (with their labels/placeholders/types), and buttons — so the suite generator
// can write page-specific tests that reference REAL fields and controls.
async function extractStructure(page) {
  return page
    .evaluate(() => {
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
      const uniq = (arr, n) => {
        const seen = new Set();
        const out = [];
        for (const v of arr) {
          if (!v || seen.has(v.toLowerCase())) continue;
          seen.add(v.toLowerCase());
          out.push(v);
          if (out.length >= n) break;
        }
        return out;
      };
      const headings = uniq(
        [...document.querySelectorAll("h1,h2,h3")].map((h) => clean(h.innerText)),
        15,
      );
      const fields = uniq(
        [...document.querySelectorAll("input,select,textarea")]
          .filter((el) => el.type !== "hidden")
          .map((el) => {
            const label = clean(
              el.labels?.[0]?.innerText ||
                el.getAttribute("aria-label") ||
                el.getAttribute("placeholder") ||
                el.getAttribute("name") ||
                "",
            );
            const type = (el.getAttribute("type") || el.tagName).toLowerCase();
            return label ? `${label} (${type})` : "";
          }),
        25,
      );
      const buttons = uniq(
        [
          ...document.querySelectorAll(
            'button,[role="button"],input[type="submit"],input[type="button"]',
          ),
        ].map((b) => clean(b.innerText || b.value || b.getAttribute("aria-label"))),
        25,
      );
      const tables = document.querySelectorAll("table, [role='table'], [role='grid']").length;
      return { headings, fields, buttons, tables };
    })
    .catch(() => ({ headings: [], fields: [], buttons: [], tables: 0 }));
}

function structureLines(s) {
  const parts = [];
  if (s.headings?.length) parts.push(`  headings: ${s.headings.join(" | ")}`);
  if (s.fields?.length) parts.push(`  form fields: ${s.fields.join(", ")}`);
  if (s.buttons?.length) parts.push(`  buttons: ${s.buttons.join(", ")}`);
  if (s.tables) parts.push(`  data tables/grids: ${s.tables}`);
  return parts.join("\n");
}

export async function explorePage({
  environment,
  secrets = {},
  storageStateLoad,
  savedLogin = "",
  model,
  signal,
  maxLoginSteps = 12,
  maxSections = 12,
  onEvent = () => {},
}) {
  const startUrl = normalizeUrl(environment?.url || "");
  if (!startUrl) return { pageMap: "", ok: false, error: "No environment URL to explore." };

  const progress = (message) => onEvent({ type: "progress", message });
  const shot = async () => {
    const s = await screenshotDataUrl(page, 45).catch(() => null);
    if (s) onEvent({ type: "screenshot", dataUrl: s });
  };

  let browser;
  let context;
  let page;
  const notes = [];
  try {
    browser = await chromium.launch({ headless: config.playwrightHeadless });
    context = await browser.newContext({
      ...viewportContextOptions("desktop"),
      ...(storageStateLoad ? { storageState: storageStateLoad } : {}),
    });
    page = await context.newPage();
    page.on("dialog", (d) => d.accept().catch(() => {}));

    progress(`Opening ${startUrl} …`);
    await page.goto(startUrl, {
      waitUntil: "domcontentloaded",
      timeout: config.playwrightNavTimeoutMs,
    });
    await settle(page);
    await shot();

    // Log in if a login form is present and we have instructions/session.
    let obs = await observe(page);
    if (obs.hasLoginSection && savedLogin) {
      progress("Login form found — logging in…");
      const loginTask = substituteSecrets(
        `Log into the app, then finish. Base URL: ${startUrl}. Login instructions: ${savedLogin}`,
        secrets,
      );
      const history = [];
      for (let step = 1; step <= maxLoginSteps; step += 1) {
        if (signal?.aborted) break;
        obs = await observe(page);
        if (!obs.hasLoginSection) break; // logged in
        let d;
        try {
          d = await decideAction({
            task: loginTask,
            url: obs.url,
            elements: obs.elements,
            text: obs.text,
            dialog: obs.dialog,
            history,
            stepNo: step,
            maxSteps: maxLoginSteps,
            model,
            signal,
          });
        } catch {
          break;
        }
        if (d.action === "finish") break;
        try {
          if (d.action === "wait") {
            await page.waitForTimeout(Math.min(Math.max(Number(d.ms) || 800, 100), 4000));
          } else if (d.action === "navigate") {
            d.url = resolveNav(d.url, page.url(), startUrl);
            await applyAction(page, d, null);
          } else if (d.action === "clickText") {
            await applyAction(page, d, null);
          } else {
            const needsRef = ["type", "click", "select", "hover"].includes(d.action);
            if (needsRef && !obs.byRef[d.ref]) {
              history.push(`#${step} invalid ref`);
            } else {
              const detail = await applyAction(page, d, obs.byRef[d.ref]);
              history.push(`#${step} ${d.action} -> ${truncate(detail, 60)}`);
            }
          }
        } catch (err) {
          history.push(`#${step} ${d.action} failed: ${truncate(err.message, 60)}`);
        } finally {
          for (const h of Object.values(obs.byRef ?? {})) await h.dispose().catch(() => {});
        }
        onEvent({ type: "log", message: `Login step ${step}: ${d.thought?.trim() || d.action}` });
        await shot();
      }
      notes.push(obs.hasLoginSection ? "Login could not be confirmed." : "Logged in successfully.");
      progress(notes[notes.length - 1]);
    }

    progress("Mapping the pages…");
    obs = await observe(page);
    await shot();
    const landingText = (obs.text || "").slice(0, 1500);
    const landingStruct = await extractStructure(page);
    const controls = obs.elements
      .slice(0, 40)
      .map((e) => e.descriptor)
      .join("; ");

    // Enumerate the app's navigable sections (nav/sidebar/link labels).
    const links = await page
      .evaluate(() => {
        const out = [];
        const seen = new Set();
        for (const a of Array.from(
          document.querySelectorAll('nav a, aside a, a[href], [role="link"], [role="menuitem"]'),
        )) {
          const label = (a.innerText || a.getAttribute("aria-label") || "")
            .replace(/\s+/g, " ")
            .trim();
          const href = a.getAttribute("href") || "";
          if (!label || label.length > 40) continue;
          const key = label.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ label, href });
          if (out.length >= 30) break;
        }
        return out;
      })
      .catch(() => []);

    if (links.length)
      progress(
        `Found ${links.length} section(s): ${links
          .map((l) => l.label)
          .slice(0, 10)
          .join(", ")}`,
      );

    // Peek into a few sections to capture their headings/content.
    const sections = [];
    for (const link of links.slice(0, maxSections)) {
      if (signal?.aborted) break;
      try {
        progress(`Looking at "${link.label}"…`);
        const clicked = await clickByText(page, link.label).catch(() => false);
        if (!clicked && link.href && !link.href.startsWith("#")) {
          const url = resolveNav(link.href, page.url(), startUrl);
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        }
        await settle(page);
        await shot();
        const so = await observe(page);
        const struct = await extractStructure(page);
        sections.push({
          name: link.label,
          url: page.url(),
          text: (so.text || "").replace(/\s+/g, " ").slice(0, 400),
          struct,
        });
      } catch {
        /* best-effort per section */
      }
    }

    const landingStructText = structureLines(landingStruct);
    const pageMap = [
      `Explored: ${page.url()}`,
      obs.title ? `Title: ${obs.title}` : "",
      notes.join(" "),
      `Landing content (excerpt): ${landingText}`,
      landingStructText ? `Landing structure:\n${landingStructText}` : "",
      `Interactive controls seen: ${controls}`,
      links.length ? `Sections / navigation: ${links.map((l) => l.label).join(", ")}` : "",
      sections.length
        ? "Section details:\n" +
          sections
            .map((s) => {
              const st = structureLines(s.struct || {});
              return `- ${s.name} (${s.url}): ${s.text}${st ? `\n${st}` : ""}`;
            })
            .join("\n")
        : "",
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 9000);

    return { pageMap, ok: true };
  } catch (err) {
    return { pageMap: "", ok: false, error: err.message };
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
