import { config } from "../config.js";

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error("Stopped by user.");
}

// Replace {{KEY}} with decrypted environment secrets (server-side only).
function sub(text, secrets) {
  if (!text || !secrets) return text;
  return String(text).replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(secrets, k) ? secrets[k] : m,
  );
}

function resolveApiUrl(raw, environment) {
  const value = String(raw ?? "").trim();
  if (!value) return environment?.url || "";
  if (/^https?:\/\//i.test(value)) return value;
  if (environment?.url) {
    try {
      return new URL(value, environment.url).href;
    } catch {
      return value;
    }
  }
  return value;
}

function getJsonPath(input, path) {
  return String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((value, part) => (value == null ? undefined : value[part]), input);
}

export async function runApiTest({ test, environment, onEvent = () => {}, signal, secrets = {} }) {
  const startedAt = Date.now();
  const steps = [];
  const apiConfig = test.apiConfig || {};
  const method = String(apiConfig.method || "GET").toUpperCase();
  const url = resolveApiUrl(sub(apiConfig.url, secrets), environment);
  const headers = Object.fromEntries(
    Object.entries(apiConfig.headers || {}).map(([key, value]) => [key, sub(String(value), secrets)]),
  );
  const output = {
    url,
    title: `${method} ${url}`,
    text: "",
    result: "",
    statusCode: undefined,
  };

  const finish = (index, label, status, detail) => {
    const step = { index, label, status, detail };
    steps.push(step);
    onEvent({ type: "step", ...step });
  };

  try {
    throwIfAborted(signal);
    onEvent({ type: "step", index: 0, label: `Send ${method} ${url}`, status: "running" });
    const response = await fetch(url, {
      method,
      headers,
      body: sub(apiConfig.body, secrets) || undefined,
      signal: AbortSignal.any(
        [AbortSignal.timeout(config.playwrightTimeoutMs), signal].filter(Boolean),
      ),
    });
    const text = await response.text();
    output.statusCode = response.status;
    output.text = text.slice(0, 4000);

    finish(0, `Send ${method} ${url}`, response.ok ? "pass" : "fail", `HTTP ${response.status}`);

    throwIfAborted(signal);
    const expectedStatus = Number.isFinite(apiConfig.expectedStatus)
      ? apiConfig.expectedStatus
      : Number(apiConfig.expectedStatus || 200);
    const expectedBodyContains = sub(String(apiConfig.expectedBodyContains || "").trim(), secrets);
    const expectedJsonPath = String(apiConfig.expectedJsonPath || "").trim();
    const expectedJsonValue = sub(String(apiConfig.expectedJsonValue || "").trim(), secrets);

    if (expectedStatus) {
      const ok = response.status === expectedStatus;
      finish(
        1,
        `Assert status ${expectedStatus}`,
        ok ? "pass" : "fail",
        `Received ${response.status}`,
      );
      if (!ok) {
        return {
          status: "failed",
          durationMs: Date.now() - startedAt,
          failureReason: `Expected status ${expectedStatus}, received ${response.status}.`,
          actions: [],
          steps,
          output,
          artifacts: [],
        };
      }
    }

    if (expectedBodyContains) {
      const ok = text.includes(expectedBodyContains);
      finish(
        2,
        `Assert body contains ${expectedBodyContains}`,
        ok ? "pass" : "fail",
        ok ? "Matched expected text." : "Expected text not found.",
      );
      if (!ok) {
        return {
          status: "failed",
          durationMs: Date.now() - startedAt,
          failureReason: `Response did not include expected text: ${expectedBodyContains}`,
          actions: [],
          steps,
          output,
          artifacts: [],
        };
      }
    }

    if (expectedJsonPath) {
      let parsed;
      try {
        parsed = JSON.parse(text || "null");
      } catch {
        finish(
          3,
          `Assert JSON path ${expectedJsonPath}`,
          "fail",
          "Response body was not valid JSON.",
        );
        return {
          status: "failed",
          durationMs: Date.now() - startedAt,
          failureReason: "Response body was not valid JSON.",
          actions: [],
          steps,
          output,
          artifacts: [],
        };
      }
      const actual = getJsonPath(parsed, expectedJsonPath);
      const actualString = actual == null ? "" : JSON.stringify(actual);
      const ok = expectedJsonValue ? actualString === expectedJsonValue : actual !== undefined;
      finish(
        3,
        `Assert JSON path ${expectedJsonPath}`,
        ok ? "pass" : "fail",
        ok ? actualString || "Value found." : `Received ${actualString || "undefined"}`,
      );
      if (!ok) {
        return {
          status: "failed",
          durationMs: Date.now() - startedAt,
          failureReason: expectedJsonValue
            ? `Expected ${expectedJsonPath} to equal ${expectedJsonValue}, received ${actualString || "undefined"}.`
            : `Expected JSON path ${expectedJsonPath} to exist.`,
          actions: [],
          steps,
          output,
          artifacts: [],
        };
      }
      output.result = actualString || output.result;
    }

    output.result ||= `HTTP ${response.status}`;
    return {
      status: "passed",
      durationMs: Date.now() - startedAt,
      actions: [],
      steps,
      output,
      artifacts: [],
    };
  } catch (err) {
    return {
      status: "failed",
      durationMs: Date.now() - startedAt,
      failureReason: err.message,
      actions: [],
      steps,
      output,
      artifacts: [],
    };
  }
}
