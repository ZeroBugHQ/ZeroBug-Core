# ZeroBug

ZeroBug is a full-stack, AI-assisted Playwright test runner. It lets you create projects, manage end-to-end test cases on a kanban-style board, run them against real environments, stream live browser progress, inspect screenshots and artifacts, export reports, and automate queues through cron schedules or CI webhooks.

The frontend is a Vite + React + TanStack Router app. The backend is a standalone Node.js/Express API backed by MongoDB, Ollama, and Playwright Chromium.

## Table of Contents

- [What ZeroBug Does](#what-zerobug-does)
- [Tech Stack](#tech-stack)
- [Repository Layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Running the App](#running-the-app)
- [Core Concepts](#core-concepts)
- [Frontend Routes](#frontend-routes)
- [Backend API](#backend-api)
- [How Test Runs Work](#how-test-runs-work)
- [Reports and Artifacts](#reports-and-artifacts)
- [Automation](#automation)
- [Authentication and Secrets](#authentication-and-secrets)
- [Development Commands](#development-commands)
- [Troubleshooting](#troubleshooting)
- [Notes for Contributors](#notes-for-contributors)

## What ZeroBug Does

ZeroBug helps teams define, run, and triage browser and API tests without manually writing Playwright scripts for every flow.

Key capabilities:

**Authoring & organization**

- Project-based test organization with a Kanban board (queued, running, passed, failed, and custom columns).
- Categories to group tests, plus drag-and-drop ordering and dependencies between tests.
- Manual test authoring (title, description, steps, priority, tags, assertion modes) with a simplified create/edit modal.
- AI-generated test suites from a plain-English prompt, reference screenshots, or live exploration of the real app.
- Live "explore the app" pass that logs in, maps the app's pages/sections and captures real headings, form fields and buttons to ground generated tests.
- Data-driven tests: run the same UI flow once per CSV data row with `{{column}}` substitution.
- CSV import/export of tests and per-project import/export.

**Agentic runner**

- Agentic Playwright runner that observes the live DOM, tags interactive elements, chooses the next action with an LLM, and re-observes after each step.
- Same-origin iframe scanning, dialog/popup detection, and login-form detection.
- Shadow DOM piercing: the observer walks open shadow roots (including nested/composed ones), so elements inside web components are targetable. Closed shadow roots (`mode: "closed"`) are inaccessible to any script by design and cannot be reached — a real, unavoidable limitation.
- Multi-browser engines: a test runs on Chromium (default), Firefox, or WebKit. Set the engine per test, or override it for a whole run/queue to cross-check a suite on another browser. Chromium ships in the base image; Firefox and WebKit are opt-in (`npx playwright install firefox webkit`). Note: Firefox can't emulate touch, so a `mobile`/`tablet` viewport on Firefox uses the mobile viewport *size* only, not touch input — the run history records this per run.
- Anti-stuck recovery: page fingerprinting, no-progress detection, escalating nudges, and auto-retry of transient element errors.
- Evidence-backed assertion verification so the agent can't declare a false pass.
- Abortable runs — Stop cancels the in-flight model call and ends the run promptly.
- Per-category persistent browser context pool: a category logs in once and every test in it reuses the live session.
- Agent site-memory: the runner learns per-site lessons from past runs (popups, login quirks, slow/flaky areas), reuses them as hints, and reinforces or prunes them by outcome — growing more reliable over time.
- Auto-retry with a configurable per-test retry budget.
- File upload and download in a flow: attach a bundled or test-supplied fixture to a file input (`uploadFile`), and capture a triggered download as a run artifact (`expectDownload`).
- Network interception and assertion: stub, error, or slow a matching request with `mockRequest` (to force a backend condition or isolate a flaky third-party dependency), and assert the app actually sent a request with `expectRequest` (to verify a UI action triggered the right backend call — a POST after a submit, say). Both match requests by a URL glob.

**Model providers**

- Pluggable model provider: local Ollama or Anthropic Claude, switchable in Settings; all chat, generation, action-planning, and failure-explanation calls route through the same abstraction.
- Provider-aware context window and auto-compaction so long chats stay within limits.
- Optional vision: send page screenshots to a vision model for the decision loop.

**Assertions & modes**

- UI, API, visual-regression, and accessibility assertion modes.
- Visual baselines and pixel diffs (pixelmatch), and axe-core accessibility audits.
- Network assertions inside a UI run: assert a specific request fired with the expected method and payload (`expectRequest`), so a UI step can be chained into a backend-call check without a separate API test.

**Chat**

- Embedded Bug agent chat that can create, queue, and run tests via tools.
- Persistent, threaded conversations that survive navigation and reloads, with a thread switcher, and auto-clear 10 days after last activity.
- Manual and automatic conversation compaction to preserve memory while bounding tokens.

**Environments & secrets**

- Global target environments shared across projects, with health checks, login instructions, saved browser sessions, variables, and AES-256-GCM encrypted secrets.
- `{{SECRET}}` substitution into tasks at run time (never exposed to the client).

**Runs, reporting & insights**

- Live run streaming through Server-Sent Events, with a step timeline and live screenshots.
- Artifacts: screenshots, videos, Playwright traces, HAR files, DOM snapshots, visual baselines, and visual diffs.
- Enriched Excel and HTML report exports.
- AI failure explanations (root cause, suggested fix, proposed revised steps).
- Usage statistics, token/tool-call tracking, pass-rate history, flaky-test detection, and slowest/failing test summaries.
- Audit activity log.

**Automation & access**

- Queue automation through cron schedules and CI/webhook triggers, with queue pause/resume.
- Email and webhook alerts on pass-rate dips or critical-test failures.
- Optional shared-password gate (bearer token) for local or internal deployments.

## Tech Stack

Frontend:

- React 19
- Vite
- TypeScript
- TanStack Router
- TanStack Query
- Tailwind CSS 4
- Radix UI primitives
- lucide-react icons
- shadcn-style component organization

Backend:

- Node.js ESM
- Express
- MongoDB via Mongoose
- Playwright Chromium
- Ollama for chat, test generation, action planning, and failure explanations
- Anthropic Claude as an optional model provider
- Server-Sent Events for run/chat/generation streams
- ExcelJS for spreadsheet exports
- Nodemailer and webhook callbacks for alerts
- axe-core/playwright for accessibility audits
- pixelmatch/pngjs for visual comparisons

## Repository Layout

```text
.
|-- src/                         # Frontend React app
|   |-- components/              # App shell, board, chat, modals, UI primitives
|   |-- components/ui/           # Reusable Radix/Tailwind UI components
|   |-- hooks/                   # Shared React hooks
|   |-- lib/                     # API client, project state, utilities, shared types
|   |-- routes/                  # TanStack Router file routes
|   |-- router.tsx               # Router setup
|   |-- routeTree.gen.ts         # Generated route tree
|   |-- server.ts                # TanStack Start/Vite server entry
|   |-- start.ts                 # Client start entry
|   `-- styles.css               # Global styles and Tailwind setup
|
|-- backend/                     # Backend API package
|   |-- src/
|   |   |-- models/              # Mongoose models
|   |   |-- routes/              # Express routers
|   |   |-- services/            # Runner, queue, reports, Ollama, auth, stats, etc.
|   |   |-- lib/sse.js           # SSE helpers
|   |   |-- config.js            # Backend env parsing
|   |   |-- db.js                # Mongo connection
|   |   |-- seed.js              # Explicit database reset/seed command
|   |   |-- server.js            # Express app and startup
|   |   `-- smoke.js             # Smoke test script
|   |-- artifacts/               # Runtime artifacts served at /artifacts
|   |-- package.json
|   `-- README.md                # Backend-specific notes
|
|-- docs/                        # Design notes/specs
|-- public/                      # Static assets and icons
|-- zerobug-test-cases-template.xlsx
|-- package.json                 # Frontend package scripts
|-- vite.config.ts
|-- tsconfig.json
`-- eslint.config.js
```

## Prerequisites

Install these before running ZeroBug:

- Node.js 20 or newer.
- npm.
- MongoDB running locally or reachable through a connection string.
- Ollama running locally or reachable through the Ollama base URL configured in Settings.
- At least one Ollama model pulled for chat and browser decisions.
- Playwright Chromium installed for the backend.

Recommended Ollama setup:

```bash
ollama serve
ollama pull llama3.1
```

For stronger agentic browser reasoning, use a larger reasoning-capable code model in Settings.

## Quick Start

From the project root:

```bash
npm install
copy .env.example .env
```

Then install and configure the backend:

```bash
cd backend
npm install
copy .env.example .env
npm run install:browser
```

Start MongoDB and Ollama, then run the backend:

```bash
cd backend
npm run dev
```

In another terminal, run the frontend:

```bash
npm run dev
```

Default local URLs:

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:4000`
- Backend health: `http://localhost:4000/api/health`

## Configuration

### Frontend `.env`

The frontend only needs to know where the backend is:

```env
VITE_API_URL=http://localhost:4000
```

### Backend `.env`

The backend `.env` now only keeps server binding and MongoDB connection settings.
Runtime settings such as model provider, model names, API keys, auth password,
Playwright timeouts, storage paths, and notifications are managed from the in-app
Settings page and stored in MongoDB.

```env
# HTTP server
PORT=4000
HOST=localhost
CORS_ORIGIN=

# MongoDB
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB=zerobug
```

Important notes:

- Empty `CORS_ORIGIN` reflects the request origin, which is convenient for local development.
- `PORT`, `HOST`, `CORS_ORIGIN`, `MONGODB_URI`, and `MONGODB_DB` remain environment-only settings.
- Configure Ollama/Anthropic, auth password, Playwright runner behavior, storage, secrets, and notifications in `/settings`.

## Running the App

### Backend

```bash
cd backend
npm run dev
```

This starts the Express API with Node's watch mode. On startup it:

- Creates the artifacts directory if needed.
- Connects to MongoDB and loads saved settings.
- Starts listening after settings are loaded so auth is applied from startup.
- Logs how many projects/tests already exist.
- Reclaims orphaned runs left in `running` state after a crash.
- Ensures a default environment exists.
- Seeds a sample project on a brand-new database.
- Starts the schedule ticker.
- Starts environment health sampling.

### Frontend

```bash
npm run dev
```

The frontend reads `VITE_API_URL`, renders the ZeroBug app, and talks to the backend through `src/lib/api.ts`.

### Production-like Build

```bash
npm run build
npm run preview
```

Backend production start:

```bash
cd backend
npm start
```

## Core Concepts

### Projects

Projects are the primary workspace boundary. Tests, columns, categories, schedules, stats, reports, audit entries, and automation settings are scoped to a project.

Creating a project automatically creates four system columns:

- Queued
- Running
- Passed
- Failed

You can also add custom columns for manual workflow states such as Backlog, Blocked, Needs Review, or Retest.

### Tests

Tests are natural-language specifications plus metadata. A test can include:

- Title and description.
- Suite.
- Priority.
- Tags.
- Dependencies.
- Data rows.
- Estimated or budgeted duration.
- Natural-language steps.
- Attachments/reference images.
- Retry count.
- Mode (`ui` or API-oriented modes).
- Viewport (`desktop`, `tablet`, `mobile`).
- Assertion types such as functional, visual, and accessibility.
- Optional API request configuration.
- Category assignment.

### Columns and Status

ZeroBug separates a test's execution status from its board position.

- `status` represents execution state: queued, running, passed, failed.
- `columnId` represents where the card appears on the board.

Running a test moves it through system columns. Dragging or moving to a custom column can re-park the test without pretending it has executed.

### Categories

Categories group tests inside a project. Generated suites can be assigned to an existing category or create a new one.

### Environments

Environments are global targets shared across projects. Each environment includes:

- Name.
- URL.
- Kind (`prod`, `staging`, `ephemeral`, `dev`, `qa`, `uat`, `sandbox`, or custom).
- Active/idle state.
- Login instructions.
- Variables count.
- Encrypted secrets.
- Health state and uptime samples.
- Saved login session metadata.

ZeroBug periodically checks environment health and displays the current status in the UI.

### Agent Site-Memory

To fail less over time, the agent keeps a per-site knowledge base of **lessons** and reuses them on later runs. This is a lightweight reinforced-experience loop (a contextual bandit), not model training.

- **Scope:** lessons are keyed by project + site origin, so different projects never cross-contaminate.
- **Learning:** after each UI run, lessons are mined deterministically from what happened (popups/cookie banners dismissed, an on-page login form, stuck-loops, same-origin 5xx/network failures). On a failed run, one short model reflection extracts up to two generalizable site lessons.
- **Reuse:** before the agent decides its next action, the top lessons (by confidence) for the current site are injected into the prompt as fallible hints ("verify against the page").
- **Reinforcement:** each lesson carries a confidence in `[0,1]`. A run that used a lesson and passed nudges its confidence up; a failing run nudges it down. New lessons start "unproven" (~0.3). Once confidence falls through a floor (after a few uses) the lesson is pruned and no longer injected.
- **Control:** the `/memory` page lists everything learned, grouped by site. Click a lesson for full stats, a confidence-over-time sparkline, and metadata; forget a single lesson or an entire site at any time. The whole feature can be toggled off with the `agentMemoryEnabled` setting (Settings → Test execution, or `AGENT_MEMORY_ENABLED`).

### Chat Threads

The agent chat is persisted to the backend as **threads** so a conversation survives navigating to another tab and back, and full page reloads.

- Each project has its own threads; the most recent one loads automatically.
- The chat header has a thread switcher and a "new conversation" button; threads can be renamed automatically from the first message and deleted individually.
- Conversations **auto-clear 10 days after their last activity** via a MongoDB TTL index. Screenshots are not persisted, keeping threads small.

## Frontend Routes

The main routes are:

- `/` - Test runner board, project switcher, agent chat, queue controls, and live run feedback.
- `/generated-specs` - Test report table with Excel and HTML export actions.
- `/stats` - Usage, pass-rate history, flaky tests, model status, tool calls, slowest/failing tests, and audit activity.
- `/memory` - Agent site-memory: per-site lessons the agent has learned, with confidence bars; click a lesson for full stats, a confidence-over-time sparkline, and a forget button.
- `/automation` - Cron schedules, webhook trigger URL, project import/export, and alert settings.
- `/environments` - Global environment management, health, secrets, login instructions, and saved sessions.
- `/settings` - Global providers, models, API keys, auth password, runner, storage, health, and notification settings.

## Backend API

The backend serves JSON APIs under `/api` and static run artifacts under `/artifacts`.

### Health and Auth

- `GET /api/health` - Backend health, Mongo status, Ollama reachability, notification configuration.
- `GET /api/auth/status` - Whether shared-password auth is required.
- `POST /api/auth/login` - Exchange the configured shared password for a bearer token.

When a shared app password is set in Settings, all `/api/*` routes below the auth router require a bearer token.

### Projects

- `GET /api/projects`
- `POST /api/projects`
- `PATCH /api/projects/:id`
- `DELETE /api/projects/:id`
- `GET /api/projects/:id/export`
- `POST /api/projects/import`
- `POST /api/projects/:id/generate-suite` - SSE stream for AI suite generation.

### Columns and Categories

- `GET /api/projects/:id/columns`
- `POST /api/projects/:id/columns`
- `PATCH /api/columns/:id`
- `DELETE /api/columns/:id`
- `GET /api/projects/:id/categories`
- `POST /api/projects/:id/categories`
- `PATCH /api/categories/:id`
- `DELETE /api/categories/:id`

### Tests

- `GET /api/tests?projectId=:projectId`
- `POST /api/tests`
- `PATCH /api/tests/:id`
- `DELETE /api/tests/:id`
- `POST /api/tests/bulk`
- `POST /api/tests/:id/reset`
- `DELETE /api/tests/:id/baseline`
- `GET /api/tests/:id/runs/latest`

### Runs

- `GET /api/runs/stream?projectId=:projectId` - SSE stream for live queue/run state.
- `POST /api/runs/start`
- `POST /api/runs/start-all`
- `POST /api/runs/stop`
- `POST /api/runs/answer` - Answers a question asked by the browser agent.
- `POST /api/runs/explain` - AI failure explanation and proposed remediation.

### Environments

- `GET /api/environments`
- `POST /api/environments`
- `PATCH /api/environments/:id`
- `DELETE /api/environments/:id`
- `GET /api/environments/:id/secrets`
- `PUT /api/environments/:id/secrets`
- `DELETE /api/environments/:id/secrets/:key`
- `DELETE /api/environments/:id/session`

### Reports

- `GET /api/reports?projectId=:projectId`
- `GET /api/reports/export?projectId=:projectId`
- `GET /api/reports/html?projectId=:projectId`
- `POST /api/reports/generate`
- `PATCH /api/reports/:id`
- `DELETE /api/reports/:id`

### Stats, Models, Chat, Audit

- `GET /api/stats?projectId=:projectId`
- `GET /api/stats/history?projectId=:projectId&days=30`
- `GET /api/stats/insights?projectId=:projectId`
- `GET /api/settings`
- `PATCH /api/settings`
- `GET /api/models`
- `PATCH /api/models`
- `POST /api/chat` - SSE chat stream.
- `POST /api/chat/summarize`
- `GET /api/chat/threads?projectId=:projectId` - List persisted chat threads (metadata).
- `POST /api/chat/threads` - Create a thread.
- `GET /api/chat/threads/:id` - Full thread with messages.
- `PUT /api/chat/threads/:id` - Save a thread's messages / title.
- `DELETE /api/chat/threads/:id` - Delete a thread.
- `GET /api/memory?projectId=:projectId` - List learned site-memory lessons.
- `DELETE /api/memory/:id?projectId=:projectId` - Forget one lesson.
- `DELETE /api/memory?projectId=:projectId&origin=:origin` - Forget all lessons (optionally for one site).
- `GET /api/audit`

### Automation

- `GET /api/automation/projects/:id/queue`
- `POST /api/automation/projects/:id/queue/run` - SSE queue run.
- `POST /api/automation/projects/:id/queue/pause`
- `POST /api/automation/projects/:id/queue/stop`
- `POST /api/automation/projects/:id/queue/clear`
- `POST /api/automation/projects/:id/queue/cancel`
- `PATCH /api/automation/projects/:id/queue/order`
- `GET /api/automation/projects/:id/schedules`
- `POST /api/automation/projects/:id/schedules`
- `PATCH /api/automation/schedules/:id`
- `DELETE /api/automation/schedules/:id`
- `POST /api/automation/projects/:id/webhook-token`
- `POST /api/automation/webhooks/:token/run`

## How Test Runs Work

ZeroBug does not simply run a static script generated by an LLM. The UI runner is an agentic loop around a live Playwright browser.

At a high level:

1. Bug opens the selected environment in Chromium.
2. The runner observes the current page.
3. Visible interactive elements are tagged with `[ref]` numbers.
4. Visible page text, URL, title, dialog state, and login state are collected.
5. The configured Ollama code model chooses one next action.
6. ZeroBug executes that action through Playwright.
7. The runner settles the page, captures screenshots/events, and observes again.
8. The loop continues until the model finishes, the step budget is exceeded, the run is stopped, or the test fails.

Supported action styles include:

- Navigate.
- Type into a referenced element.
- Click a referenced element.
- Click by text fallback.
- Press a key.
- Select an option.
- Hover.
- Wait.
- Ask the user for missing information.
- Finish with success/failure and a result.

The runner includes recovery logic for common browser automation problems:

- Stale or invalid element refs.
- Repeated actions with no visible page change.
- Login forms without instructions.
- Popups and dialogs.
- Placeholder domains accidentally emitted by the model.
- Relative paths and bare domains.
- Slow SPAs that need time to settle.

Runs can target desktop, tablet, or mobile viewport profiles.

## Reports and Artifacts

ZeroBug stores run evidence in the backend artifacts directory and serves it through `/artifacts`.

Common artifacts:

- Final screenshot.
- Page video.
- Playwright trace zip.
- Network HAR.
- DOM snapshot.
- Visual actual screenshot.
- Visual baseline screenshot.
- Visual diff image.
- axe accessibility result JSON.

Reports page exports:

- Excel report (`zerobug-test-report.xlsx`).
- HTML report (`zerobug-test-report.html`).

The report includes:

- Serial number.
- Page/suite.
- Test case.
- Mode.
- Steps.
- Expected result.
- Status.
- Attempts.
- Failure reason.
- Steps to reproduce.
- Artifact links.

## Automation

ZeroBug supports two automation paths.

### Scheduled Runs

Use the Automation page to create cron schedules for a project. Example cron expressions:

```text
*/15 * * * *   every 15 minutes
0 * * * *      hourly
0 9 * * *      daily at 9am
0 9 * * 1-5    weekdays at 9am
0 1 * * *      nightly at 1am
```

Schedules can optionally target a suite, environment, callback URL, and retry count.

### Webhook Runs

Generate a webhook token from the Automation page. ZeroBug returns a URL that can be called from CI or a script:

```bash
curl -X POST http://localhost:4000/api/automation/webhooks/YOUR_TOKEN/run
```

Optional JSON body:

```json
{
  "suite": "smoke",
  "environmentId": "ENVIRONMENT_ID",
  "maxRetries": 1,
  "callbackUrl": "https://example.com/zerobug-callback"
}
```

The webhook returns `202 Accepted` and runs the queue in the background.

## Authentication and Secrets

### Shared Password Auth

Set the shared app password from the Settings page to require login.

When enabled:

- The frontend shows a login screen.
- The backend returns a bearer token after successful login.
- The frontend stores the token in browser local storage.
- API requests include `Authorization: Bearer <token>`.
- File downloads are fetched with auth headers and opened/downloaded as blobs.

Leave the password empty for open local development.

### Environment Secrets

Environment secrets are saved server-side and encrypted at rest. Add secrets from the environment edit modal.

Tests can reference secrets with placeholders:

```text
Log in with {{ADMIN_EMAIL}} / {{ADMIN_PASSWORD}}
```

Unknown placeholders are left unchanged. Set the secrets encryption key from Settings before storing real credentials in a shared or production-like environment.

### Saved Browser Sessions

After successful login flows, ZeroBug can save a Playwright storage state for an environment/category combination. Later runs can reuse that session and skip repetitive login work.

Saved sessions live under the backend data directory and are not publicly served.

## Development Commands

Frontend commands from the root:

```bash
npm run dev          # Start Vite dev server
npm run build        # Production build
npm run build:dev    # Development-mode build
npm run preview      # Preview built app
npm run lint         # ESLint
npm run format       # Prettier write
```

Backend commands from `backend/`:

```bash
npm run dev              # Start API with node --watch
npm start                # Start API normally
npm test                 # Run the fast unit suite (node:test)
npm run test:integration # Run real-browser integration tests (needs Chromium)
npm run smoke            # Smoke test API routes
npm run install:browser  # Install Playwright Chromium
npm run db:reset -- --force
```

`npm test` runs only the fast, dependency-light unit tests. Real-browser tests
(named `*.integration.test.js`) are excluded from it and run separately via
`npm run test:integration`, which launches headless Chromium; they self-skip if
no Chromium binary is installed (`npm run install:browser`).

Database reset is intentionally opt-in. Running `npm run db:reset` without `--force` prints a warning and does not delete data.

## Data Persistence

ZeroBug stores application data in MongoDB. Restarting the backend does not wipe data.

Runtime evidence is stored on disk under `backend/artifacts` by default. If you deploy ZeroBug somewhere ephemeral, mount persistent storage for:

- MongoDB data.
- The configured artifacts directory.
- The configured private data directory.

## Testing and Verification

Recommended local verification after changes:

```bash
npm run lint
npm run build
cd backend
npm test                 # fast unit suite
npm run test:integration # real-browser tests (uploads/downloads) — optional, needs Chromium
npm run smoke
```

`npm test` is the fast unit suite (no browser, no network). `npm run test:integration`
runs the real-browser tests and needs Playwright Chromium (`npm run install:browser`);
it self-skips cleanly if Chromium isn't installed. The smoke test needs MongoDB. Real
browser *runs* (actual test execution) need MongoDB, Ollama, and Playwright Chromium.

## Troubleshooting

### Frontend cannot reach the backend

Check:

- Backend is running.
- `VITE_API_URL` points to the backend origin.
- Backend `PORT` matches the URL.
- CORS is not blocking the frontend. For local dev, leave `CORS_ORIGIN` blank.

Test:

```bash
curl http://localhost:4000/api/health
```

### MongoDB is down

The backend starts even if MongoDB is temporarily unreachable, but data routes will fail until MongoDB connects.

Check:

- MongoDB service is running.
- `MONGODB_URI` is correct.
- `MONGODB_DB` is set as expected.

### Ollama is unreachable

Check:

- `ollama serve` is running.
- The Ollama base URL in Settings is correct.
- The selected models are pulled and available.

Useful command:

```bash
ollama list
```

### Browser runs fail immediately

Check:

- Run `npm run install:browser` inside `backend/`.
- The selected environment URL is reachable.
- Disable headless mode in Settings if you want to watch the browser while debugging.
- The navigation timeout in Settings is high enough for slow apps.

### Generated or seeded tests fail

Some sample or generated tests may point at placeholder or unreachable domains until you configure a real environment. Create or edit an environment and point it at your app.

### Login flows get stuck

Add login instructions to the environment. Include enough detail for the agent to complete the flow, for example:

```text
Log in with {{ADMIN_EMAIL}} and {{ADMIN_PASSWORD}}. If asked for a workspace, choose Demo.
```

Store the actual values as environment secrets.

### Visual tests fail after intentional UI changes

Reset the visual baseline for the affected test. The next run will capture a new baseline.

### Authenticated artifact links fail in a new tab

When auth is enabled, plain links cannot send bearer headers. The frontend handles report downloads through authenticated blob fetches. If you add new artifact/file actions, use the existing authenticated `downloadFile` or `openFile` helpers in `src/lib/api.ts`.

## Notes for Contributors

- Prefer existing component and API patterns before introducing new abstractions.
- Keep frontend API calls centralized in `src/lib/api.ts`.
- Keep backend route handlers thin and push business logic into services.
- Do not eval model-generated code. Browser execution should remain constrained to the runner action DSL.
- Treat artifacts and saved sessions as runtime data, not source-controlled fixtures.
- Keep `backend/artifacts` out of production commits unless a specific artifact is intentionally documented.
- Update this README when adding routes, env vars, workflows, or operational requirements.

## License

ZeroBug Core is licensed under the [Sustainable Use License](./LICENSE.md) (see also
[NOTICE.md](./NOTICE.md) for a plain-language explanation).

In plain terms: **ZeroBug Core is free to self-host, use, and modify — including
internal use at a company.** What you can't do is take this code and offer it as
your own competing hosted/SaaS product.

If you want the managed cloud version instead of self-hosting, see
**ZeroBug Cloud** (coming soon).
