import ExcelJS from "exceljs";
import { summarizeBugDescription, summarizeReproduce } from "./ollama.js";

function statusLabel(status) {
  if (status === "passed") return "Pass";
  if (status === "failed") return "Fail";
  return "Pending";
}

function passedLabel(status) {
  return status === "passed" ? "YES" : "NO";
}

function reportDate(test, run) {
  const value = run?.createdAt || test?.updatedAt || test?.createdAt;
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function bugExplanation(test, run, reproduce) {
  if (test.status !== "failed") return "";
  const reason = test.failureReason || run?.failureReason || "";
  const failedStep = Array.isArray(run?.steps)
    ? run.steps.find((step) => step.status === "fail")
    : null;
  const parts = [];
  if (reason) parts.push(`The bug appeared because ${reason.replace(/[.。]\s*$/, "")}.`);
  if (failedStep?.label || failedStep?.detail) {
    parts.push(
      `It surfaced while running "${failedStep.label || "the failing step"}"${
        failedStep.detail ? `: ${failedStep.detail}` : ""
      }.`,
    );
  }
  if (reproduce) parts.push(reproduce);
  return parts.join(" ");
}

export async function buildReportRows(tests, runsByTestId = new Map(), categoriesById = new Map()) {
  return Promise.all(
    tests.map(async (test, i) => {
      const run = runsByTestId.get(String(test.id ?? test._id));
      const steps = Array.isArray(test.steps) ? test.steps.filter(Boolean).join("\n") : "";

      // Only summarise for failed tests that have run steps recorded,
      // and skip agent-internal failures (stuck loop) — those aren't real bugs.
      const isAgentFailure =
        /agent got stuck|could not get a valid decision|repeated actions with no progress/i.test(
          test.failureReason || run?.failureReason || "",
        );
      const reproduce =
        test.status === "failed" && run?.steps?.length && !isAgentFailure
          ? await summarizeReproduce(run.steps, test.title).catch(() => "")
          : "";
      const bugDescription =
        test.status === "failed"
          ? await summarizeBugDescription({ test, run }).catch(
              () => test.failureReason || run?.failureReason || test.title || "Test failed",
            )
          : "";

      const durationMs = Number.isFinite(run?.durationMs)
        ? run.durationMs
        : Number.isFinite(test.durationMs)
          ? test.durationMs
          : 0;
      const artifacts = Array.isArray(run?.artifacts)
        ? run.artifacts.map((a) => ({ kind: a.kind, label: a.label, url: a.url }))
        : [];
      const forensics = run?.forensics || {};

      return {
        slNo: i + 1,
        date: reportDate(test, run),
        code: test.code || "",
        pages: test.suite || "General",
        page: test.suite || "General",
        category:
          (test.categoryId && categoriesById.get(String(test.categoryId))) || "Uncategorized",
        testCase: test.title || "",
        priority: test.priority || "medium",
        mode: (test.mode || "ui").toUpperCase(),
        viewport: test.viewport || "desktop",
        assertions: (test.assertionTypes && test.assertionTypes.length
          ? test.assertionTypes
          : ["functional"]
        ).join(", "),
        stepsCount: Array.isArray(test.steps) ? test.steps.length : 0,
        steps,
        durationMs,
        duration: fmtDuration(durationMs),
        consoleErrors: Array.isArray(forensics.console) ? forensics.console.length : 0,
        networkErrors: Array.isArray(forensics.network) ? forensics.network.length : 0,
        bugDescription,
        bugExplanation: bugExplanation(test, run, reproduce),
        expected: test.description && test.description !== "No description" ? test.description : "",
        status: statusLabel(test.status),
        passed: passedLabel(test.status),
        attempts: run
          ? run.attempt != null && run.maxAttempts != null
            ? `${run.attempt}/${run.maxAttempts}`
            : "—"
          : test.maxRetries != null
            ? `1/${(test.maxRetries ?? 0) + 1}`
            : "—",
        failureReason: test.failureReason || run?.failureReason || "",
        reproduce,
        artifacts,
        artifactText: artifacts.map((a) => a.label).join(", "),
      };
    }),
  );
}

/** High-level totals for the report header/summary. */
export function summarizeReport(rows) {
  const total = rows.length;
  const pass = rows.filter((r) => r.status === "Pass").length;
  const fail = rows.filter((r) => r.status === "Fail").length;
  const pending = total - pass - fail;
  const ran = rows.filter((r) => Number.isFinite(r.durationMs) && r.durationMs > 0);
  const avgMs = ran.length ? Math.round(ran.reduce((s, r) => s + r.durationMs, 0) / ran.length) : 0;
  const totalMs = ran.reduce((s, r) => s + r.durationMs, 0);
  return {
    total,
    pass,
    fail,
    pending,
    passRate: total ? Math.round((pass / total) * 100) : 0,
    avgDuration: fmtDuration(avgMs),
    totalDuration: fmtDuration(totalMs),
  };
}

const COLUMNS = [
  { header: "SL", key: "slNo", width: 6 },
  { header: "DATE", key: "date", width: 12 },
  { header: "CODE", key: "code", width: 12 },
  { header: "TEST CASE", key: "testCase", width: 42 },
  { header: "CATEGORY", key: "category", width: 18 },
  { header: "PAGE / SUITE", key: "pages", width: 18 },
  { header: "PRIORITY", key: "priority", width: 10 },
  { header: "TYPE", key: "mode", width: 8 },
  { header: "VIEWPORT", key: "viewport", width: 10 },
  { header: "DURATION", key: "duration", width: 10 },
  { header: "ATTEMPTS", key: "attempts", width: 10 },
  { header: "STATUS", key: "status", width: 10 },
  { header: "BUG DESCRIPTION", key: "bugDescription", width: 58 },
  { header: "BUG EXPLANATION", key: "bugExplanation", width: 58 },
  { header: "STEPS TO REPRODUCE", key: "reproduce", width: 50 },
  { header: "EXPECTED RESULT", key: "expected", width: 44 },
  { header: "ARTIFACTS", key: "artifactText", width: 28 },
  { header: "PASSED", key: "passed", width: 10 },
];

export function buildReportWorkbook(projectName, rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ZeroBug";
  const ws = wb.addWorksheet("Test Report", {
    views: [{ state: "frozen", ySplit: 3 }],
  });
  ws.columns = COLUMNS;

  // ── Summary banner (rows 1–2) ──
  const s = summarizeReport(rows);
  const lastCol = COLUMNS.length;
  ws.mergeCells(1, 1, 1, lastCol);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = `ZeroBug Test Report — ${projectName}`;
  titleCell.font = { bold: true, size: 14 };
  titleCell.alignment = { vertical: "middle" };
  ws.mergeCells(2, 1, 2, lastCol);
  const summaryCell = ws.getCell(2, 1);
  summaryCell.value =
    `${s.total} tests   ·   ${s.pass} passed   ·   ${s.fail} failed   ·   ${s.pending} pending   ·   ` +
    `pass rate ${s.passRate}%   ·   avg ${s.avgDuration || "—"}   ·   total ${s.totalDuration || "—"}`;
  summaryCell.font = { size: 10, color: { argb: "FF444444" } };

  // ── Column headers (row 3) ──
  const header = ws.getRow(3);
  header.values = COLUMNS.map((c) => c.header);
  header.font = { bold: true, color: { argb: "FF000000" }, size: 10 };
  header.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  header.height = 18;
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE07055" } };
    cell.border = thin();
  });

  for (const row of rows) {
    const r = ws.addRow(row);
    r.alignment = { vertical: "top", wrapText: true };
    r.eachCell((cell) => (cell.border = thin()));
    // Colour the status/passed cells for quick scanning.
    const statusCell = r.getCell("status");
    statusCell.alignment = { vertical: "middle", horizontal: "center" };
    statusCell.font = {
      bold: true,
      color: {
        argb: row.status === "Pass" ? "FF1B7F3B" : row.status === "Fail" ? "FFB42318" : "FF9A6700",
      },
    };
    const passedCell = r.getCell("passed");
    passedCell.alignment = { vertical: "middle", horizontal: "center" };
    passedCell.dataValidation = { type: "list", allowBlank: true, formulae: ['"YES,NO"'] };
  }

  return wb;
}

function thin() {
  const side = { style: "thin", color: { argb: "FFD0D0D0" } };
  return { top: side, left: side, bottom: side, right: side };
}

export function reportFileName(projectName, date = new Date()) {
  const slug =
    String(projectName || "project")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project";
  const stamp = date.toISOString().slice(0, 10);
  return `zerobug-test-report-${slug}-${stamp}.xlsx`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statusPill(status) {
  const color =
    status === "Pass"
      ? "background:#dcfce7;color:#166534"
      : status === "Fail"
        ? "background:#fee2e2;color:#991b1b"
        : "background:#fef9c3;color:#854d0e";
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;${color}">${escapeHtml(status)}</span>`;
}

export function buildReportHtml(projectName, rows) {
  const s = summarizeReport(rows);
  const body = rows
    .map(
      (row) => `
        <tr>
          <td style="text-align:center">${row.slNo}</td>
          <td>${escapeHtml(row.date)}</td>
          <td><code>${escapeHtml(row.code)}</code></td>
          <td><strong>${escapeHtml(row.testCase)}</strong></td>
          <td>${escapeHtml(row.category)}</td>
          <td>${escapeHtml(row.pages)}</td>
          <td style="text-transform:capitalize">${escapeHtml(row.priority)}</td>
          <td>${escapeHtml(row.mode)}</td>
          <td>${escapeHtml(row.viewport)}</td>
          <td>${escapeHtml(row.duration)}</td>
          <td style="text-align:center">${escapeHtml(row.attempts)}</td>
          <td style="text-align:center">${statusPill(row.status)}</td>
          <td><pre>${escapeHtml(row.bugDescription)}</pre></td>
          <td><pre>${escapeHtml(row.bugExplanation)}</pre></td>
          <td><pre>${escapeHtml(row.reproduce)}</pre></td>
          <td><pre>${escapeHtml(row.expected)}</pre></td>
          <td>${
            row.artifacts && row.artifacts.length
              ? row.artifacts.map((a) => `<div>${escapeHtml(a.label)}</div>`).join("")
              : "—"
          }</td>
        </tr>
      `,
    )
    .join("");

  const stat = (label, value, color) =>
    `<div style="border:1px solid #e5e7eb;border-radius:10px;padding:10px 14px;min-width:96px">
       <div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280">${label}</div>
       <div style="font-size:20px;font-weight:700;${color || ""}">${value}</div>
     </div>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>ZeroBug test report — ${escapeHtml(projectName)}</title>
    <style>
      body { font-family: Inter, Arial, sans-serif; margin: 24px; color: #111827; }
      h1 { margin: 0 0 4px; }
      .sub { color: #6b7280; margin: 0 0 16px; }
      .stats { display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0 20px; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      th, td { border: 1px solid #d1d5db; padding: 8px 10px; vertical-align: top; text-align: left; }
      th { background: #e07055; color: #000; text-align: center; font-size: 12px; white-space: nowrap; }
      pre { margin: 0; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, monospace; }
      code { font-family: ui-monospace, SFMono-Regular, monospace; background:#f3f4f6; padding:1px 5px; border-radius:4px; }
      .wrap { overflow-x: auto; }
    </style>
  </head>
  <body>
    <h1>ZeroBug test report</h1>
    <p class="sub">Project: <strong>${escapeHtml(projectName)}</strong> · generated ${new Date().toISOString().slice(0, 10)}</p>
    <div class="stats">
      ${stat("Total", s.total)}
      ${stat("Passed", s.pass, "color:#166534")}
      ${stat("Failed", s.fail, "color:#991b1b")}
      ${stat("Pending", s.pending, "color:#854d0e")}
      ${stat("Pass rate", `${s.passRate}%`)}
      ${stat("Avg duration", s.avgDuration || "—")}
    </div>
    <div class="wrap">
      <table>
        <thead>
          <tr>
            ${COLUMNS.filter((c) => c.key !== "passed")
              .map((column) => `<th>${escapeHtml(column.header)}</th>`)
              .join("")}
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  </body>
</html>`;
}
