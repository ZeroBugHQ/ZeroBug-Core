import type { TestCase, TestStatus } from "./mock-tests";

export const API_URL = (
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:4000"
).replace(/\/$/, "");

/**
 * Resolve a server asset path to an absolute URL. Artifacts (screenshots,
 * traces, HAR, video) are served by the backend at `/artifacts/...`, but the
 * frontend runs on a different origin — so a bare `/artifacts/...` would 404
 * against the frontend. data:/blob:/http(s) URLs are returned untouched.
 */
export function assetUrl(url?: string | null): string {
  if (!url) return "";
  if (/^(https?:|data:|blob:)/.test(url)) return url;
  return `${API_URL}${url.startsWith("/") ? "" : "/"}${url}`;
}

// ---- Optional shared-password auth ----
// The backend gate is OFF unless ZEROBUG_AUTH_PASSWORD is set; the token (when
// present) is sent as a Bearer header on every request.
const AUTH_TOKEN_KEY = "zerobug.authToken";

export function getAuthToken(): string {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setAuthToken(token: string): void {
  try {
    if (token) localStorage.setItem(AUTH_TOKEN_KEY, token);
    else localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch {
    // storage unavailable — token simply won't persist
  }
}

/** Headers to merge into every request. Adds Bearer auth when a token is set. */
function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Thrown (via window event) when the server rejects the token. */
export class AuthError extends Error {
  constructor() {
    super("Authentication required");
    this.name = "AuthError";
  }
}

function onUnauthorized() {
  setAuthToken("");
  try {
    window.dispatchEvent(new CustomEvent("zerobug:unauthorized"));
  } catch {
    // non-browser context
  }
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  agentModel?: string;
  webhookToken?: string;
  webhookCallbackUrl?: string;
  queuePaused?: boolean;
  alertPassRateThreshold?: number;
  alertOnCriticalFail?: boolean;
  createdAt?: string;
}

export interface Insights {
  flaky: Array<{ code: string; title: string; passes: number; fails: number }>;
  diff: {
    newlyFailed: Array<{ code: string; title: string }>;
    newlyPassed: Array<{ code: string; title: string }>;
    slower: Array<{ code: string; title: string; prevMs: number; lastMs: number }>;
  };
}

export interface Schedule {
  id: string;
  projectId: string;
  name: string;
  cron: string;
  suite?: string;
  environmentId?: string;
  callbackUrl?: string;
  maxRetries?: number;
  enabled: boolean;
  lastTriggeredAt?: string;
  lastCompletedAt?: string;
  lastStatus?: "passed" | "failed" | "running" | "skipped";
  lastError?: string;
  createdAt?: string;
}

export interface NewSchedule {
  name: string;
  cron: string;
  suite?: string;
  environmentId?: string;
  callbackUrl?: string;
  maxRetries?: number;
  enabled?: boolean;
}

export type ColumnSystemKey = "queued" | "running" | "passed" | "failed" | null;

export interface BoardColumn {
  id: string;
  projectId: string;
  title: string;
  systemKey: ColumnSystemKey;
  order: number;
}

export interface Category {
  id: string;
  projectId: string;
  name: string;
  order: number;
}

export interface Environment {
  id: string;
  name: string;
  url: string;
  kind: string;
  active: boolean;
  loginInstructions?: string;
  vars: number;
  secrets: number;
  health: "healthy" | "degraded";
  lastHealthCheckedAt?: string;
  lastHealthError?: string;
  storageStateSavedAt?: string;
  healthHistory?: Array<{ at: string; healthy: boolean }>;
  createdAt?: string;
}

export interface SecretKey {
  key: string;
  updatedAt?: string;
}

export interface PassRateBucket {
  date: string; // "YYYY-MM-DD"
  passed: number;
  failed: number;
  total: number;
  passRate: number | null; // null means no runs that day
}

export interface Stats {
  usage: {
    promptTokens: number;
    responseTokens: number;
    totalTokens: number;
    requests: number;
    toolRequests: number;
    toolCalls: Record<string, number>;
  };
  outcomes: {
    queued: number;
    running: number;
    passed: number;
    failed: number;
    total: number;
    passRate: number;
    avgDurationMs: number;
  };
  slowest: Array<{ code: string; title: string; durationMs: number }>;
  failing: Array<{ code: string; title: string; fails: number }>;
  model: {
    name: string;
    resolved: string;
    reachable: boolean;
    selectedAvailable: boolean;
    availableCount: number;
  };
}

export interface RunArtifact {
  kind: string;
  label: string;
  url: string;
}

export interface ReportRow {
  slNo: number;
  date: string;
  code: string;
  pages: string;
  page?: string;
  category: string;
  testCase: string;
  priority: string;
  mode: string;
  viewport: string;
  assertions: string;
  stepsCount: number;
  steps: string;
  durationMs: number;
  duration: string;
  consoleErrors: number;
  networkErrors: number;
  bugDescription: string;
  bugExplanation: string;
  expected: string;
  status: "Pass" | "Fail" | "Pending";
  passed: "YES" | "NO";
  attempts: string;
  failureReason: string;
  reproduce: string;
  artifacts: RunArtifact[];
  artifactText: string;
}

export interface RunStep {
  index: number;
  label: string;
  status: "running" | "pass" | "fail";
  detail?: string;
}

export interface RunOutput {
  url?: string;
  title?: string;
  text?: string;
  result?: string;
  screenshot?: string;
  statusCode?: number;
}

export interface RunForensics {
  console?: Array<{ type: string; text: string }>;
  network?: Array<{ url: string; method?: string; status?: number; failure?: string }>;
  domSnapshotUrl?: string;
}

export interface RunRecord {
  id: string;
  testId: string;
  status: "running" | "passed" | "failed";
  durationMs?: number;
  failureReason?: string;
  attempt: number;
  maxAttempts: number;
  steps: RunStep[];
  output?: RunOutput;
  artifacts: RunArtifact[];
  forensics?: RunForensics;
  createdAt?: string;
}

export interface FailureExplanation {
  rootCause: string;
  suggestion: string;
  proposedSteps: string[];
}

export interface ApiTestConfig {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  expectedStatus?: number;
  expectedBodyContains?: string;
  expectedJsonPath?: string;
  expectedJsonValue?: string;
}

export interface NewTestInput {
  title: string;
  suite?: string;
  tags?: string[];
  dependsOn?: string[];
  dataRows?: Record<string, string>[];
  budgetMs?: number;
  priority?: TestCase["priority"];
  description?: string;
  steps?: string[];
  attachments?: string[];
  maxRetries?: number;
  mode?: TestCase["mode"];
  viewport?: TestCase["viewport"];
  engine?: TestCase["engine"];
  assertionTypes?: TestCase["assertionTypes"];
  apiConfig?: ApiTestConfig;
  categoryId?: string | null;
}

export interface AuditEntry {
  id: string;
  action: string;
  detail: string;
  projectId: string | null;
  at: string;
}

export interface ModelInfo {
  name: string;
  size?: number;
  modifiedAt?: string;
}

export interface ModelStatus {
  provider: "ollama" | "anthropic";
  reachable: boolean;
  selectedModel: string;
  resolvedModel: string;
  fallbackModel: string;
  selectedAvailable: boolean;
  models: ModelInfo[];
}

export interface AppSettings {
  authEnabled: boolean;
  authPassword: string;
  modelProvider: "ollama" | "anthropic";
  ollamaBaseUrl: string;
  ollamaChatModel: string;
  ollamaCodeModel: string;
  ollamaNumCtx: number;
  ollamaVision: boolean;
  anthropicApiKeySet: boolean;
  anthropicApiKey: string;
  anthropicBaseUrl: string;
  anthropicChatModel: string;
  anthropicCodeModel: string;
  anthropicVersion: string;
  agentMemoryEnabled: boolean;
  runConcurrency: number;
  playwrightHeadless: boolean;
  playwrightTimeoutMs: number;
  playwrightNavTimeoutMs: number;
  artifactsDir: string;
  dataDir: string;
  secretsKeySet: boolean;
  secretsKey: string;
  environmentHealthTimeoutMs: number;
  visualDiffThreshold: number;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassSet: boolean;
  smtpPass: string;
  smtpFrom: string;
  notifyEmails: string[];
  notifyWebhookUrls: string[];
}

export interface SiteLesson {
  id: string;
  projectId: string;
  origin: string;
  kind: "popup" | "login" | "failure" | "note";
  lesson: string;
  detail?: Record<string, unknown>;
  confidence: number;
  uses: number;
  wins: number;
  losses: number;
  status: "active" | "pruned";
  source: "mined" | "reflection";
  history?: Array<{ ts: number; confidence: number; passed: boolean }>;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

// Persistent chat threads (auto-cleared 10 days after last activity).
export interface ChatThreadSummary {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatThread {
  id: string;
  projectId: string;
  title: string;
  messages: Array<{
    mid: string;
    role: "user" | "agent" | "system";
    content: string;
    kind?: string;
    ts?: number;
    testCode?: string;
    detail?: string;
    stepNo?: number;
    stepStatus?: string;
    meta?: Record<string, unknown>;
  }>;
  createdAt: string;
  updatedAt: string;
}

export type SettingsUpdate = Partial<
  Omit<AppSettings, "authEnabled" | "anthropicApiKeySet" | "secretsKeySet" | "smtpPassSet">
> & {
  authPassword?: string;
  anthropicApiKey?: string;
  secretsKey?: string;
  smtpPass?: string;
};

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...authHeaders(), ...init?.headers },
  });
  if (res.status === 401) {
    onUnauthorized();
    throw new AuthError();
  }
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Request to ${path} failed (${res.status}): ${msg}`);
  }
  return res.json() as Promise<T>;
}

// Fetch a file endpoint WITH the auth header (a plain <a href> / new-tab
// navigation can't send the Bearer token, so those 401 when auth is on).
async function fetchFile(path: string): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(`${API_URL}${path}`, { headers: { ...authHeaders() } });
  if (res.status === 401) {
    onUnauthorized();
    throw new AuthError();
  }
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Download failed (${res.status}): ${msg}`);
  }
  const disposition = res.headers.get("Content-Disposition") || "";
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const filename = match ? decodeURIComponent(match[1]) : "";
  return { blob: await res.blob(), filename };
}

/** Download an authenticated file endpoint to disk (keeps the API URL hidden). */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const { blob, filename } = await fetchFile(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Open an authenticated file endpoint in a new tab via a blob URL. */
export async function openFile(path: string): Promise<void> {
  const { blob } = await fetchFile(path);
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank", "noopener");
  // If a popup blocker stopped it, fall back to same-tab navigation.
  if (!win) window.location.assign(url);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const api = {
  // ---- Auth (optional shared-password gate) ----
  getAuthStatus: () => http<{ required: boolean }>("/api/auth/status"),
  login: (password: string) =>
    http<{ token: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  // ---- Audit / activity log ----
  listAudit: (projectId?: string | null, limit = 50) =>
    http<AuditEntry[]>(
      `/api/audit?limit=${limit}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`,
    ),

  listProjects: () => http<Project[]>("/api/projects"),
  createProject: (data: { name: string; description?: string }) =>
    http<Project>("/api/projects", { method: "POST", body: JSON.stringify(data) }),
  updateProject: (id: string, data: Partial<Project>) =>
    http<Project>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteProject: (id: string) => http<{ ok: boolean }>(`/api/projects/${id}`, { method: "DELETE" }),
  downloadProjectExport: (id: string) =>
    downloadFile(`/api/projects/${id}/export`, "zerobug-project.json"),
  importProject: (data: unknown) =>
    http<{ project: Project; importedTests: number }>("/api/projects/import", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  // Streams live progress + screenshots (SSE) while exploring/generating.
  generateSuite: (
    projectId: string,
    prompt: string,
    opts: {
      categoryId?: string | null;
      categoryName?: string;
      images?: string[];
      explore?: boolean;
    },
    onEvent: (event: GenerateSuiteEvent) => void,
    signal?: AbortSignal,
  ) =>
    streamSSE<GenerateSuiteEvent>(
      `/api/projects/${projectId}/generate-suite`,
      { prompt, ...opts },
      onEvent,
      signal,
    ),

  listColumns: (projectId: string) => http<BoardColumn[]>(`/api/projects/${projectId}/columns`),
  createColumn: (projectId: string, title: string) =>
    http<BoardColumn>(`/api/projects/${projectId}/columns`, {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  updateColumn: (id: string, data: Partial<BoardColumn>) =>
    http<BoardColumn>(`/api/columns/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteColumn: (id: string) => http<{ ok: boolean }>(`/api/columns/${id}`, { method: "DELETE" }),

  // Categories: user-created groupings of tests within a project.
  listCategories: (projectId: string) => http<Category[]>(`/api/projects/${projectId}/categories`),
  createCategory: (projectId: string, name: string) =>
    http<Category>(`/api/projects/${projectId}/categories`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  renameCategory: (id: string, name: string) =>
    http<Category>(`/api/categories/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteCategory: (id: string) =>
    http<{ ok: boolean }>(`/api/categories/${id}`, { method: "DELETE" }),

  listKinds: (projectId: string) => http<string[]>(`/api/projects/${projectId}/kinds`),
  addKind: (projectId: string, kind: string) =>
    http<string[]>(`/api/projects/${projectId}/kinds`, {
      method: "POST",
      body: JSON.stringify({ kind }),
    }),
  deleteKind: (projectId: string, kind: string) =>
    http<string[]>(`/api/projects/${projectId}/kinds/${encodeURIComponent(kind)}`, {
      method: "DELETE",
    }),

  listTests: (projectId: string) =>
    http<TestCase[]>(`/api/tests?projectId=${encodeURIComponent(projectId)}`),
  createTest: (data: NewTestInput & { projectId: string }) =>
    http<TestCase>("/api/tests", { method: "POST", body: JSON.stringify(data) }),
  updateTest: (id: string, data: Partial<TestCase> & { columnId?: string }) =>
    http<TestCase>(`/api/tests/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  resetTest: (id: string) => http<TestCase>(`/api/tests/${id}/reset`, { method: "POST" }),
  deleteTest: (id: string) => http<{ ok: boolean }>(`/api/tests/${id}`, { method: "DELETE" }),
  // Bulk operations over many tests: requeue | delete | move | addTag | removeTag | setPriority.
  bulkTests: (data: {
    action: "requeue" | "delete" | "move" | "addTag" | "removeTag" | "setPriority" | "setCategory";
    ids: string[];
    tag?: string;
    priority?: TestCase["priority"];
    columnId?: string;
    categoryId?: string | null;
  }) =>
    http<{ ok: boolean; affected: number }>("/api/tests/bulk", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  getLatestRun: (id: string) => http<RunRecord | null>(`/api/tests/${id}/runs/latest`),
  // Reset (reject) a test's visual baseline so the next run re-captures it.
  resetBaseline: (id: string) =>
    http<{ ok: boolean }>(`/api/tests/${id}/baseline`, { method: "DELETE" }),

  startRun: (testId: string, environmentId?: string | null) =>
    http<{ ok: boolean }>("/api/runs/start", {
      method: "POST",
      body: JSON.stringify({ testId, environmentId }),
    }),
  startAllRuns: (projectId: string, environmentId?: string | null, mode?: string | null) =>
    http<{ ok: boolean; total?: number }>("/api/runs/start-all", {
      method: "POST",
      body: JSON.stringify({ projectId, environmentId, mode }),
    }),
  stopRuns: (projectId?: string | null, testId?: string | null) =>
    http<{ ok: boolean }>("/api/runs/stop", {
      method: "POST",
      body: JSON.stringify({ projectId, testId }),
    }),
  answerQuestion: (questionId: string, text: string) =>
    http<{ ok: boolean }>("/api/runs/answer", {
      method: "POST",
      body: JSON.stringify({ questionId, text }),
    }),
  explainFailure: (testId: string) =>
    http<FailureExplanation>("/api/runs/explain", {
      method: "POST",
      body: JSON.stringify({ testId }),
    }),
  summarizeChat: (projectId: string, messages: Array<{ role: string; content: string }>) =>
    http<{ summary: string }>("/api/chat/summarize", {
      method: "POST",
      body: JSON.stringify({ projectId, messages }),
    }),

  listEnvironments: () => http<Environment[]>("/api/environments"),
  createEnvironment: (data: Partial<Environment>) =>
    http<Environment>("/api/environments", { method: "POST", body: JSON.stringify(data) }),
  updateEnvironment: (id: string, data: Partial<Environment>) =>
    http<Environment>(`/api/environments/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteEnvironment: (id: string) =>
    http<{ ok: boolean }>(`/api/environments/${id}`, { method: "DELETE" }),

  // Encrypted secrets (values never leave the server) + saved-session reset.
  listSecrets: (envId: string) => http<SecretKey[]>(`/api/environments/${envId}/secrets`),
  setSecret: (envId: string, key: string, value: string) =>
    http<SecretKey[]>(`/api/environments/${envId}/secrets`, {
      method: "PUT",
      body: JSON.stringify({ key, value }),
    }),
  deleteSecret: (envId: string, key: string) =>
    http<SecretKey[]>(`/api/environments/${envId}/secrets/${encodeURIComponent(key)}`, {
      method: "DELETE",
    }),
  clearSession: (envId: string) =>
    http<{ ok: boolean }>(`/api/environments/${envId}/session`, { method: "DELETE" }),

  getReportRows: (projectId: string) =>
    http<ReportRow[]>(`/api/reports?projectId=${encodeURIComponent(projectId)}`),
  downloadReport: (projectId: string) =>
    downloadFile(
      `/api/reports/export?projectId=${encodeURIComponent(projectId)}`,
      "zerobug-test-report.xlsx",
    ),
  downloadReportHtml: (projectId: string) =>
    downloadFile(
      `/api/reports/html?projectId=${encodeURIComponent(projectId)}`,
      "zerobug-test-report.html",
    ),

  getStats: (projectId: string) =>
    http<Stats>(`/api/stats?projectId=${encodeURIComponent(projectId)}`),
  getPassRateHistory: (projectId: string, days = 30) =>
    http<PassRateBucket[]>(
      `/api/stats/history?projectId=${encodeURIComponent(projectId)}&days=${days}`,
    ),
  getInsights: (projectId: string) =>
    http<Insights>(`/api/stats/insights?projectId=${encodeURIComponent(projectId)}`),

  getSettings: () => http<AppSettings>("/api/settings"),
  updateSettings: (data: SettingsUpdate) =>
    http<AppSettings>("/api/settings", { method: "PATCH", body: JSON.stringify(data) }),

  getModels: () => http<ModelStatus>("/api/models"),
  updateAgentModel: (agentModel: string) =>
    http<{ provider: "ollama" | "anthropic"; agentModel: string }>("/api/models", {
      method: "PATCH",
      body: JSON.stringify({ agentModel }),
    }),

  // Automation: cron schedules + webhook (CI/curl) trigger.
  listSchedules: (projectId: string) =>
    http<Schedule[]>(`/api/automation/projects/${projectId}/schedules`),
  createSchedule: (projectId: string, data: NewSchedule) =>
    http<Schedule>(`/api/automation/projects/${projectId}/schedules`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateSchedule: (id: string, data: Partial<NewSchedule>) =>
    http<Schedule>(`/api/automation/schedules/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteSchedule: (id: string) =>
    http<{ ok: boolean }>(`/api/automation/schedules/${id}`, { method: "DELETE" }),
  generateWebhookToken: (projectId: string) =>
    http<Project>(`/api/automation/projects/${projectId}/webhook-token`, { method: "POST" }),
  // The public URL a CI job / curl POSTs to in order to trigger a queue run.
  webhookRunUrl: (token: string) => `${API_URL}/api/automation/webhooks/${token}/run`,

  // Agent site-memory: lessons the agent has learned about each site.
  listMemory: (projectId: string) =>
    http<SiteLesson[]>(`/api/memory?projectId=${encodeURIComponent(projectId)}`),
  forgetLesson: (projectId: string, id: string) =>
    http<{ deleted: number }>(`/api/memory/${id}?projectId=${encodeURIComponent(projectId)}`, {
      method: "DELETE",
    }),
  forgetAllMemory: (projectId: string, origin?: string) =>
    http<{ deleted: number }>(
      `/api/memory?projectId=${encodeURIComponent(projectId)}${origin ? `&origin=${encodeURIComponent(origin)}` : ""}`,
      { method: "DELETE" },
    ),

  // Persistent chat threads.
  listChatThreads: (projectId: string) =>
    http<ChatThreadSummary[]>(`/api/chat/threads?projectId=${encodeURIComponent(projectId)}`),
  getChatThread: (id: string) => http<ChatThread>(`/api/chat/threads/${id}`),
  createChatThread: (projectId: string, title?: string) =>
    http<ChatThread>("/api/chat/threads", {
      method: "POST",
      body: JSON.stringify({ projectId, title }),
    }),
  saveChatThread: (id: string, data: { messages?: unknown[]; title?: string }) =>
    http<ChatThread>(`/api/chat/threads/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteChatThread: (id: string) =>
    http<{ ok: boolean }>(`/api/chat/threads/${id}`, { method: "DELETE" }),
};

export type RunEvent =
  | { type: "status"; testId: string; status: TestStatus }
  | { type: "plan"; actions: Array<Record<string, unknown>> }
  | { type: "attempt"; testId: string; attempt: number; maxAttempts: number }
  | { type: "retry"; testId: string; attempt: number; maxAttempts: number; failureReason?: string }
  | {
      type: "step";
      testId?: string;
      index: number;
      label: string;
      status: "running" | "pass" | "fail";
      detail?: string;
    }
  | { type: "screenshot"; testId?: string; index: number; dataUrl: string }
  | {
      type: "result";
      testId: string;
      status: TestStatus;
      durationMs?: number;
      failureReason?: string;
      attempt?: number;
      maxAttempts?: number;
      artifacts?: RunArtifact[];
    }
  | { type: "question"; questionId: string; question: string; testCode?: string; testId?: string }
  | {
      type: "usage";
      promptTokens: number;
      responseTokens: number;
      contextWindow?: number;
      testId?: string;
    }
  | {
      type: "queue_started";
      projectId: string;
      kind: "single" | "all";
      total: number;
      testId?: string;
      mode?: string | null;
    }
  | { type: "queue_progress"; projectId: string; testId: string }
  | { type: "queue_complete"; projectId: string; kind: "single" | "all"; stopped: boolean }
  | { type: "queue_stopping"; projectId: string; activeTestId?: string | null }
  | {
      type: "state";
      projectId: string;
      running: boolean;
      kind: string | null;
      activeTestId: string | null;
    }
  | { type: "ping" }
  | { type: "error"; message: string };

export type GenerateSuiteEvent =
  | { type: "progress"; message: string }
  | { type: "log"; message: string }
  | { type: "screenshot"; dataUrl: string }
  | { type: "done"; created: number }
  | { type: "error"; message: string };

export type ChatEvent =
  | { type: "token"; content: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; summary: string }
  | { type: "mutation"; entity: string }
  | { type: "compacted"; summarizedCount: number; tokensBefore: number; tokensAfter: number }
  | RunEvent;

async function readSSE<E>(res: Response, onEvent: (event: E) => void): Promise<void> {
  if (!res.ok || !res.body) {
    throw new Error(`Stream failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const json = dataLine.slice(5).trim();
      if (!json) continue;
      try {
        onEvent(JSON.parse(json) as E);
      } catch {
        // ignore malformed frame
      }
    }
  }
}

export async function streamSSE<E>(
  path: string,
  body: unknown,
  onEvent: (event: E) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (res.status === 401) {
    onUnauthorized();
    throw new AuthError();
  }
  await readSSE(res, onEvent);
}

export async function streamSSEGet<E>(
  path: string,
  onEvent: (event: E) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "GET",
    headers: { ...authHeaders() },
    signal,
  });
  if (res.status === 401) {
    onUnauthorized();
    throw new AuthError();
  }
  await readSSE(res, onEvent);
}
