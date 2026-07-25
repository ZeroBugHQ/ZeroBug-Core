// Unit tests for the report builder. Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReportRows, buildReportWorkbook, reportFileName } from "./report-builder.js";

const TESTS = [
  {
    id: "t1",
    suite: "QB Dashboard",
    title: "Dashboard Load",
    description: "Dashboard loads with all widgets visible",
    steps: ["Open Quotation Dashboard page"],
    status: "passed",
    mode: "ui",
    maxRetries: 0,
  },
  {
    id: "t2",
    suite: "QB Dashboard",
    title: "Verify All Leads Count",
    description: "All Leads count matches total records",
    steps: ["Compare All Leads count with total"],
    status: "failed",
    failureReason: "Count mismatch: showed 12, expected 15",
    mode: "ui",
    maxRetries: 2,
  },
  {
    id: "t3",
    suite: "QB Dashboard",
    title: "Search Lead",
    description: "Matching lead is displayed",
    steps: ["Enter client name"],
    status: "queued",
    mode: "api",
    maxRetries: 1,
  },
];

const RUNS = new Map([
  [
    "t2",
    {
      attempt: 2,
      maxAttempts: 3,
      artifacts: [{ label: "Playwright trace", url: "/artifacts/runs/demo/trace.zip" }],
      steps: [
        { index: 0, label: "Go to dashboard", status: "pass", detail: "Loaded /dashboard" },
        { index: 1, label: "Read All Leads count", status: "fail", detail: "Found 12" },
        { index: 2, label: "thinking", status: "running" },
      ],
    },
  ],
]);

test("maps status to Pass/Fail/Pending", async () => {
  const rows = await buildReportRows(TESTS, RUNS);
  assert.deepEqual(
    rows.map((r) => r.status),
    ["Pass", "Fail", "Pending"],
  );
});

test("rows carry page/testCase/mode/steps/expected in order with 1-based Sl. No", async () => {
  const rows = await buildReportRows(TESTS, RUNS, new Map([["cat1", "Login flow"]]));
  assert.equal(rows[0].slNo, 1);
  assert.equal(rows[0].pages, "QB Dashboard");
  assert.equal(rows[0].page, "QB Dashboard");
  assert.equal(rows[0].testCase, "Dashboard Load");
  assert.equal(rows[0].mode, "UI");
  assert.equal(rows[2].mode, "API");
  assert.equal(rows[0].steps, "Open Quotation Dashboard page");
  assert.equal(rows[0].expected, "Dashboard loads with all widgets visible");
  // Enriched fields present.
  assert.equal(rows[0].priority, "medium");
  assert.equal(rows[0].category, "Uncategorized");
  assert.equal(rows[0].viewport, "desktop");
});

test("category name resolves from the categoriesById map", async () => {
  const rows = await buildReportRows([{ ...TESTS[0], categoryId: "cat1" }], new Map(), new Map([["cat1", "Login flow"]]));
  assert.equal(rows[0].category, "Login flow");
});

test("attempts reflect the run, or the test's retry budget when not yet run", async () => {
  const rows = await buildReportRows(TESTS, RUNS);
  assert.equal(rows[1].attempts, "2/3"); // from the run record
  assert.equal(rows[2].attempts, "1/2"); // never run → 1 of (maxRetries + 1)
});

test("failure reason populates only for the failed test; reproduce stays empty otherwise", async () => {
  const rows = await buildReportRows(TESTS, RUNS);
  // passed + pending: no failure reason, no reproduce
  assert.equal(rows[0].failureReason, "");
  assert.equal(rows[0].reproduce, "");
  assert.equal(rows[0].bugDescription, "");
  assert.equal(rows[0].bugExplanation, "");
  assert.equal(rows[2].reproduce, "");
  // failed: deterministic failure reason; reproduce is AI-summarised (best-effort,
  // empty when the model is unavailable) so we only assert it's a string.
  assert.match(rows[1].failureReason, /Count mismatch/);
  assert.match(rows[1].bugDescription, /Count mismatch/);
  assert.match(rows[1].bugExplanation, /Count mismatch/);
  assert.equal(typeof rows[1].reproduce, "string");
  assert.equal(rows[0].passed, "YES");
  assert.equal(rows[1].passed, "NO");
  assert.equal(rows[2].passed, "NO");
});

test("buildReportWorkbook produces a readable .xlsx with header + rows", async () => {
  const rows = await buildReportRows(TESTS, RUNS);
  const wb = buildReportWorkbook("DVBolt", rows);
  const buf = await wb.xlsx.writeBuffer();
  assert.ok(buf.length > 0);

  // Read it back to confirm the structure round-trips.
  const ExcelJS = (await import("exceljs")).default;
  const re = new ExcelJS.Workbook();
  await re.xlsx.load(buf);
  const ws = re.getWorksheet("Test Report");
  assert.ok(ws);
  // Rows 1–2 are the title + summary banner; the column header is on row 3.
  assert.equal(ws.getRow(3).getCell(1).value, "SL");
  assert.equal(ws.getRow(3).getCell(4).value, "TEST CASE");
  assert.equal(ws.getRow(3).getCell(13).value, "BUG DESCRIPTION");
  assert.equal(ws.getRow(3).getCell(18).value, "PASSED");
  assert.equal(ws.rowCount, 3 + TESTS.length);
  // Failed test (t2) is the 2nd data row → sheet row 5; PASSED is the last column.
  assert.equal(ws.getRow(5).getCell(18).value, "NO");
});

test("reportFileName is filesystem-safe and dated", () => {
  const name = reportFileName("DV Bolt!", new Date("2026-06-18T10:00:00Z"));
  assert.equal(name, "zerobug-test-report-dv-bolt-2026-06-18.xlsx");
});
