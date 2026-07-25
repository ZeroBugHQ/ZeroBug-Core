# ZeroBug Backend

Express + MongoDB + Ollama/Anthropic + Playwright API for the ZeroBug test runner.

## Prerequisites
- **Node.js 20+**
- **MongoDB** running (local `mongodb://127.0.0.1:27017` or any URI)
- **Ollama** running (`ollama serve`) with the configured models pulled, e.g.
  `ollama pull llama3.1`
  or an **Anthropic API key** when using Claude as the provider.
- **Playwright Chromium** browser (installed via the step below)

## Setup
```bash
cd backend
cp .env.example .env        # then edit values as needed
npm install
npm run install:browser     # downloads Chromium for Playwright
npm run dev                 # starts the API (default http://localhost:4000)
```

ZeroBug organises everything under **projects** you create in the UI — there is no
starter data. Create a project from the switcher (top-left), then add tests,
environments and reports to it.

### Data persistence
Your data lives in MongoDB and is **preserved across restarts** — the server never
deletes anything on start/restart (on boot it logs how many projects/tests it found).
The only command that clears data is an explicit, opt-in reset:

```bash
npm run db:reset -- --force   # DELETES all projects/tests/etc. Running it without
                              # --force only prints a warning and changes nothing.
```

> If your data still disappears after a restart, your MongoDB itself isn't persisting
> (e.g. a Docker container without a mounted volume, or an in-memory instance). Point
> `MONGODB_URI` at a durable MongoDB.

## Configuration (`.env`)
The backend `.env` only keeps server binding and MongoDB connection settings.
Runtime settings such as providers, models, API keys, auth password, Playwright,
storage, and notifications live in the ZeroBug UI under **Settings**.

| Var | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP port | `4000` |
| `HOST` | HTTP host | `localhost` |
| `CORS_ORIGIN` | Allowed frontend origin (blank = reflect any) | blank |
| `MONGODB_URI` | Mongo connection string | `mongodb://127.0.0.1:27017` |
| `MONGODB_DB` | Database name | `zerobug` |

## API
- `GET  /api/health` — mongo + ollama reachability
- **Projects**: `GET/POST /api/projects`, `PATCH/DELETE /api/projects/:id`
  (creating a project auto-creates its 4 system columns; deleting cascades to its
  tests/environments/reports/columns)
- **Columns**: `GET/POST /api/projects/:id/columns`, `PATCH/DELETE /api/columns/:id`
  (system columns can't be deleted; deleting a custom column moves its tests to Queued)
- **Tests** (scoped by `?projectId=`): `GET/POST /api/tests`, `PATCH/DELETE /api/tests/:id`,
  `POST /api/tests/:id/reset`, `POST /api/tests/:id/run` (**SSE** real Playwright run)
- **Environments** (scoped): `GET/POST /api/environments`, `PATCH/DELETE /api/environments/:id`
- **Reports** (scoped): `GET /api/reports`, `POST /api/reports/generate`, `PATCH/DELETE /api/reports/:id`
- **Chat**: `POST /api/chat` — **SSE** agentic ZeroBug chat (body includes `projectId`)

## Projects & columns
Everything is scoped to a project. Each project has four **system columns** (Queued,
Running, Passed, Failed) that the runner drives automatically, plus any **custom
columns** you add (manual holding areas like Backlog/Blocked). A test carries both a
`status` (execution state) and a `columnId` (board position); running a test moves it
through the system columns, while dragging to a custom column just re-parks it.

## How runs work (DOM-aware agent)
A run is an **agentic loop**, not a pre-planned script. Each step the runner:
1. **Observes** the live page — tags the visible interactive elements with `[ref]`
   numbers and captures the visible text.
2. **Decides** one next action via the configured code model (navigate / type / click / press /
   select / wait / scroll / finish), choosing a real element by its `[ref]`.
3. **Acts**, then re-observes and repeats until the model `finish`es (with the value
   the task asked for) or the step budget runs out.

Because the model picks from elements that actually exist, it doesn't guess selectors —
it reliably handles real flows (logins, navigation, reading values). Failed actions don't
abort the run; the agent re-observes and recovers.

### Model choice matters
Agentic multi-step automation needs real reasoning. A small model (e.g. `qwen3.5:4b`)
can stumble on multi-field logins; a stronger model is strongly recommended. With Ollama
cloud models, **`gpt-oss:20b-cloud`** is both capable and fast — set it as the code model in Settings.

> ⚠️ The seeded environments point at placeholder domains (`app.acme.dev`) that
> don't exist, so seeded runs will fail/timeout. Point an environment at a real URL
> (edit it in the Environments page or via `PATCH /api/environments/:id`) for green runs.

## Smoke test
```bash
npm run smoke   # boots on :4555, hits the read routes + health (needs Mongo)
```
