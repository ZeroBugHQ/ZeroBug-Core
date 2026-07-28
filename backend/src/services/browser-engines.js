import { chromium, firefox, webkit } from "playwright";
import { config } from "../config.js";

// The Playwright browser types, keyed by the engine name stored on tests/runs.
// Chromium is the default and the only engine the base image ships with; Firefox
// and WebKit are opt-in (see the install:browsers script / Docker build arg).
const ENGINES = { chromium, firefox, webkit };

export const SUPPORTED_ENGINES = Object.keys(ENGINES);
export const DEFAULT_ENGINE = "chromium";

// Normalize an arbitrary engine value to a supported one (defaulting to
// chromium), so a bad/absent value can never crash a launch.
export function resolveEngine(engine) {
  const e = String(engine || "").toLowerCase();
  return SUPPORTED_ENGINES.includes(e) ? e : DEFAULT_ENGINE;
}

// Launch a browser for the given engine. Single choke point for every launch
// site (pooled + standalone + login), so engine selection lives in one place.
// Throws a clear, actionable error if the engine's binary isn't installed
// (Firefox/WebKit aren't in the base image) instead of Playwright's raw message.
export async function launchBrowser(engine) {
  const name = resolveEngine(engine);
  const type = ENGINES[name];
  try {
    return await type.launch({ headless: config.playwrightHeadless });
  } catch (err) {
    if (/Executable doesn't exist|please run the following command/i.test(err?.message || "")) {
      throw new Error(
        `The ${name} browser isn't installed. Install it with ` +
          `\`npx playwright install ${name}\` (or set the engine to a browser that is installed).`,
      );
    }
    throw err;
  }
}
