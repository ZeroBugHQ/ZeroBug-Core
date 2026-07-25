# ZeroBug Backend — Design

Date: 2026-06-16

## Goal
Replace the frontend's mock data and simulated test execution with a real,
standalone **Express + MongoDB + Ollama + Playwright** backend. ZeroBug Agent chat
streams from Ollama (conversational + agentic). Everything configurable via env.

## Topology
- Standalone `backend/` package, **Node.js (ESM, plain JS)**, run via `node --watch`.
- Express HTTP server on `PORT`.
- Frontend calls it via `VITE_API_URL`; CORS enabled (origin reflected in dev).
- Mongoose for schemas. Native `fetch` for Ollama. `playwright` for execution.

```
backend/
  .env.example
  package.json
  src/
    config.js              # env load + validation
    db.js                  # mongoose connection
    server.js              # express app, mounts routes
    models/{test,run,report,environment}.model.js
    routes/{tests,reports,environments,chat}.routes.js
    services/ollama.js     # streamChat, generateActions, generateSpec
    services/playwright-runner.js   # DSL executor, streamed events
    lib/sse.js             # SSE helpers
    seed.js                # seed from former mock data
```

## Config (env)
Backend `.env`: `PORT`, `CORS_ORIGIN`, `MONGODB_URI`, `MONGODB_DB`,
`OLLAMA_BASE_URL`, `OLLAMA_CHAT_MODEL`, `OLLAMA_CODE_MODEL`,
`PLAYWRIGHT_HEADLESS`, `PLAYWRIGHT_TIMEOUT_MS`.
Frontend `.env`: `VITE_API_URL`.

## Data model (Mongoose)
- **Test**: code, title, description, suite, priority, estMs, steps[], status
  (queued/running/passed/failed), durationMs, failureReason, timestamps.
- **Environment**: name, url, kind (prod/staging/ephemeral), active, vars, secrets,
  health (healthy/degraded), timestamps.
- **Report**: name, suite, prompt, status (approved/review), snippet (spec code), timestamps.
- **Run**: testId, status, startedAt, finishedAt, durationMs, failureReason,
  steps[{index,label,status,detail}], actions[], timestamps.

## Real Playwright execution (two streamed stages)
Tests carry natural-language steps, not code. A run:
1. **Plan** — Ollama (`OLLAMA_CODE_MODEL`, JSON mode) turns the test + target env URL
   into a constrained **action DSL** list (goto/fill/click/press/waitFor/
   expectVisible/expectText/expectUrl), each with a human `label`.
2. **Execute** — `playwright-runner.js` drives real Chromium through the actions,
   emitting a step event per action and a final verdict from real assertions.

Safety: a DSL interpreter, never `eval` of LLM code.

Note: seeded env URLs are placeholders (`app.acme.dev`) and will fail real runs —
point an environment at a real URL for green runs. Documented in backend README.

## ZeroBug chat (streamed, SSE over fetch POST)
- `POST /api/chat` streams Ollama tokens.
- Board state (tests, counts, recent results) injected as context each turn.
- Agentic tools: `create_test`, `queue_test`, `run_test`, `run_all`. Tool calls are
  executed server-side via the same services; results (incl. live Playwright step
  events for runs) are streamed back into the chat as action/result events.

## API surface
- Tests: `GET/POST /api/tests`, `PATCH/DELETE /api/tests/:id`, `POST /api/tests/:id/reset`,
  `POST /api/tests/:id/run` (SSE), `POST /api/tests/run-all` (orchestrated client-side).
- Reports: `GET /api/reports`, `POST /api/reports/generate`, `DELETE /api/reports/:id`.
- Environments: `GET/POST /api/environments`, `PATCH/DELETE /api/environments/:id`.
- Chat: `POST /api/chat` (SSE).
- Health: `GET /api/health` (reports mongo + ollama reachability).

## Frontend changes
- `src/lib/api.ts` — typed client + `streamSSE` helper (fetch + ReadableStream).
- TanStack Query hooks replace mock arrays in test-runner-app, generated-specs, environments.
- `runTest`/`runAll` consume the run SSE; `sendChat` consumes the chat SSE.
- `mock-tests.ts` keeps only shared TS types; `INITIAL_TESTS` deleted (moves to seed).

## Verification
- Backend: `GET /api/health` + a smoke script that exercises CRUD against a test DB;
  graceful errors when Mongo/Ollama are down (server still boots).
- Frontend: `npm run build` + manual run-through.
