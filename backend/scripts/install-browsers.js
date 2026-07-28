// Install only the Playwright browser engines a deployment actually needs, so a
// self-host image isn't forced to ship all three (~250MB+ for Firefox+WebKit on
// top of Chromium). Chromium is always included; add others via the
// PLAYWRIGHT_ENGINES env var (comma/space-separated) or CLI args.
//
//   npm run install:browsers                       -> chromium (default)
//   PLAYWRIGHT_ENGINES=chromium,firefox npm run install:browsers
//   npm run install:browsers -- firefox webkit     -> chromium + firefox + webkit
//
// Uses --with-deps so the OS libraries each engine needs are installed too.
import { spawnSync } from "node:child_process";

const VALID = new Set(["chromium", "firefox", "webkit"]);

const fromEnv = (process.env.PLAYWRIGHT_ENGINES || "")
  .split(/[,\s]+/)
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const fromArgs = process.argv.slice(2).map((s) => s.trim().toLowerCase()).filter(Boolean);

// Chromium is always installed; union in whatever was requested.
const requested = new Set(["chromium", ...fromEnv, ...fromArgs]);
const engines = [...requested].filter((e) => {
  if (!VALID.has(e)) {
    console.warn(`[install-browsers] ignoring unknown engine "${e}" (valid: chromium, firefox, webkit)`);
    return false;
  }
  return true;
});

console.log(`[install-browsers] installing: ${engines.join(", ")}`);
// Invoke the local Playwright CLI via npx so the browser builds match the
// installed playwright version exactly.
const result = spawnSync("npx", ["playwright", "install", "--with-deps", ...engines], {
  stdio: "inherit",
  shell: process.platform === "win32", // npx needs a shell on Windows
});
process.exit(result.status ?? 1);
