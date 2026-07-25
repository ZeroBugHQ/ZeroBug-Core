export type TestStatus = "queued" | "running" | "passed" | "failed" | "blocked";

export type AssertionType = "functional" | "visual" | "a11y";
export type TestMode = "ui" | "api";

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

export interface TestCase {
  id: string;
  projectId: string;
  columnId?: string;
  categoryId?: string | null;
  code: string;
  title: string;
  description: string;
  suite: string;
  tags?: string[];
  dependsOn?: string[];
  dataRows?: Record<string, string>[];
  flaky?: boolean;
  budgetMs?: number;
  priority: "low" | "medium" | "high" | "critical";
  estMs: number;
  status: TestStatus;
  durationMs?: number;
  failureReason?: string;
  steps?: string[];
  attachments?: string[];
  maxRetries: number;
  mode: TestMode;
  viewport?: "desktop" | "tablet" | "mobile";
  assertionTypes: AssertionType[];
  apiConfig?: ApiTestConfig;
  createdAt?: string;
  updatedAt?: string;
}
