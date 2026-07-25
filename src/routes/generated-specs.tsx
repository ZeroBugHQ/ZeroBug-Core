import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  FileCode2,
  FileSpreadsheet,
  Loader2,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { api, assetUrl, type ReportRow } from "@/lib/api";
import { useProject } from "@/lib/use-project";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/generated-specs")({
  head: () => ({
    meta: [
      { title: "Test report — ZeroBug" },
      {
        name: "description",
        content:
          "Download the ZeroBug agent's test run results as Excel or a shareable HTML report.",
      },
    ],
  }),
  component: TestReportPage,
});

function TestReportPage() {
  const { currentProjectId } = useProject();
  const {
    data: rows = [],
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ["report-rows", currentProjectId],
    queryFn: () => api.getReportRows(currentProjectId!),
    enabled: !!currentProjectId,
  });

  const [busy, setBusy] = useState<null | "excel" | "html">(null);
  const [exportError, setExportError] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Reset to the first page when the project or page size changes.
  useEffect(() => setPage(1), [currentProjectId, pageSize]);

  async function runExport(kind: "excel" | "html") {
    if (!currentProjectId || busy) return;
    setBusy(kind);
    setExportError("");
    try {
      if (kind === "excel") await api.downloadReport(currentProjectId);
      else await api.downloadReportHtml(currentProjectId);
    } catch (e) {
      if ((e as Error)?.name !== "AuthError")
        setExportError((e as Error)?.message || "Export failed.");
    } finally {
      setBusy(null);
    }
  }

  const counts = rows.reduce(
    (acc, row) => {
      acc[row.status] += 1;
      return acc;
    },
    { Pass: 0, Fail: 0, Pending: 0 } as Record<ReportRow["status"], number>,
  );
  const passRate = rows.length ? Math.round((counts.Pass / rows.length) * 100) : 0;
  const ran = rows.filter((r) => r.durationMs > 0);
  const avgDuration = ran.length
    ? fmtMs(Math.round(ran.reduce((s, r) => s + r.durationMs, 0) / ran.length))
    : "—";

  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pagedRows = rows.slice((safePage - 1) * pageSize, safePage * pageSize);
  const firstShown = rows.length ? (safePage - 1) * pageSize + 1 : 0;
  const lastShown = Math.min(safePage * pageSize, rows.length);

  return (
    <AppShell
      title="Test report"
      breadcrumb="Results"
      actions={
        currentProjectId && rows.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => runExport("html")}
              disabled={busy !== null}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 text-sm font-semibold text-foreground transition hover:bg-accent disabled:opacity-60"
            >
              {busy === "html" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FileCode2 className="h-3.5 w-3.5" />
              )}
              Download HTML report
            </button>
            <button
              onClick={() => runExport("excel")}
              disabled={busy !== null}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
            >
              {busy === "excel" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              Download Excel report
            </button>
          </div>
        ) : undefined
      }
    >
      <div className="p-4 md:p-6">
        {exportError && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Couldn't export the report: {exportError}
          </div>
        )}

        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight">Test report</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Share the latest bug report as HTML or download it as an Excel sheet.
            </p>
          </div>
          {rows.length > 0 && (
            <div className="flex items-center gap-2 text-xs">
              <Tally label="Pass" value={counts.Pass} className="bg-success/15 text-success" />
              <Tally
                label="Fail"
                value={counts.Fail}
                className="bg-destructive/15 text-destructive"
              />
              <Tally
                label="Pending"
                value={counts.Pending}
                className="bg-warning/15 text-warning"
              />
            </div>
          )}
        </div>

        {!currentProjectId && (
          <div className="rounded-xl border border-dashed border-border/70 p-10 text-center text-sm text-muted-foreground">
            Select or create a project (top-left) to view its test report.
          </div>
        )}

        {isError && (
          <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-5 text-sm text-destructive">
            <AlertTriangle className="mb-2 h-5 w-5" />
            Couldn't reach the backend:{" "}
            <span className="font-mono">{(error as Error)?.message}</span>
          </div>
        )}

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading results...
          </div>
        )}

        {!isLoading && !isError && currentProjectId && rows.length === 0 && (
          <div className="rounded-xl border border-dashed border-border/70 p-10 text-center text-sm text-muted-foreground">
            <FileSpreadsheet className="mx-auto mb-2 h-6 w-6 text-muted-foreground/70" />
            No tests yet. Add tests on the board and run them. Their results show up here, ready to
            export.
          </div>
        )}

        {rows.length > 0 && (
          <>
            {/* Summary */}
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Total tests" value={rows.length} />
              <Stat label="Passed" value={counts.Pass} tone="success" />
              <Stat label="Failed" value={counts.Fail} tone="destructive" />
              <Stat label="Pending" value={counts.Pending} tone="warning" />
              <Stat label="Pass rate" value={`${passRate}%`} />
              <Stat label="Avg duration" value={avgDuration} />
            </div>

            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              <div className="overflow-x-auto scrollbar-thin">
                <table className="w-full min-w-[2200px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <Th className="w-12 text-center">SL</Th>
                      <Th className="w-28">Date</Th>
                      <Th className="w-24">Code</Th>
                      <Th className="w-64">Test case</Th>
                      <Th className="w-40">Category</Th>
                      <Th className="w-24">Priority</Th>
                      <Th className="w-28">Type</Th>
                      <Th className="w-24 text-center">Duration</Th>
                      <Th className="w-24 text-center">Attempts</Th>
                      <Th className="w-24 text-center">Status</Th>
                      <Th className="w-[22rem]">Bug description</Th>
                      <Th className="w-[24rem]">Bug explanation</Th>
                      <Th className="w-[20rem]">Steps to reproduce</Th>
                      <Th className="w-[18rem]">Expected result</Th>
                      <Th className="w-44">Artifacts</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRows.map((row) => (
                      <tr
                        key={row.slNo}
                        className="border-b border-border/60 align-top transition last:border-0 hover:bg-accent/20"
                      >
                        <Td className="text-center font-mono text-xs text-muted-foreground">
                          {row.slNo}
                        </Td>
                        <Td className="font-mono text-xs text-muted-foreground">
                          {row.date || "-"}
                        </Td>
                        <Td className="font-mono text-[11px] uppercase text-muted-foreground">
                          {row.code || "-"}
                        </Td>
                        <Td className="font-medium text-foreground">{row.testCase || "-"}</Td>
                        <Td className="text-muted-foreground">{row.category || "Uncategorized"}</Td>
                        <Td>
                          <PriorityBadge priority={row.priority} />
                        </Td>
                        <Td className="text-xs text-muted-foreground">
                          <span className="font-medium uppercase">{row.mode}</span>
                          {row.mode?.toUpperCase() === "UI" &&
                            row.viewport &&
                            row.viewport !== "desktop" && (
                              <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[10px] capitalize">
                                {row.viewport}
                              </span>
                            )}
                        </Td>
                        <Td className="text-center font-mono text-xs text-muted-foreground">
                          {row.duration || "-"}
                        </Td>
                        <Td className="text-center font-mono text-xs text-muted-foreground">
                          {row.attempts}
                        </Td>
                        <Td className="text-center">
                          <StatusPill status={row.status} />
                        </Td>
                        <Td className="whitespace-pre-wrap text-muted-foreground">
                          {row.bugDescription || "-"}
                        </Td>
                        <Td className="whitespace-pre-wrap text-muted-foreground">
                          {row.bugExplanation || "-"}
                        </Td>
                        <Td className="whitespace-pre-wrap text-muted-foreground">
                          {row.reproduce || "-"}
                        </Td>
                        <Td className="whitespace-pre-wrap text-muted-foreground">
                          {row.expected || "-"}
                        </Td>
                        <Td>
                          {row.artifacts && row.artifacts.length ? (
                            <div className="flex flex-col gap-1">
                              {row.artifacts.map((a) => (
                                <a
                                  key={a.url}
                                  href={
                                    a.kind === "trace"
                                      ? `https://trace.playwright.dev/?trace=${encodeURIComponent(assetUrl(a.url))}`
                                      : assetUrl(a.url)
                                  }
                                  target="_blank"
                                  rel="noreferrer"
                                  className="truncate text-[11px] text-primary hover:underline"
                                >
                                  {a.label}
                                  {a.kind === "trace" ? " ↗" : ""}
                                </a>
                              ))}
                            </div>
                          ) : (
                            "-"
                          )}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Pagination */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">
                Showing <span className="font-medium text-foreground">{firstShown}</span>–
                <span className="font-medium text-foreground">{lastShown}</span> of{" "}
                <span className="font-medium text-foreground">{rows.length}</span>
              </span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Rows per page</span>
                {[25, 50, 100].map((sz) => (
                  <button
                    key={sz}
                    onClick={() => setPageSize(sz)}
                    className={cn(
                      "rounded-md border px-2 py-1 text-xs font-medium transition",
                      pageSize === sz
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {sz}
                  </button>
                ))}
                <div className="mx-1 h-5 w-px bg-border" />
                <button
                  disabled={safePage <= 1}
                  onClick={() => setPage(Math.max(1, safePage - 1))}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium transition hover:bg-accent disabled:opacity-40"
                >
                  <ChevronLeft className="h-3.5 w-3.5" /> Prev
                </button>
                <span className="text-xs text-muted-foreground">
                  Page <span className="font-medium text-foreground">{safePage}</span> / {pageCount}
                </span>
                <button
                  disabled={safePage >= pageCount}
                  onClick={() => setPage(Math.min(pageCount, safePage + 1))}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium transition hover:bg-accent disabled:opacity-40"
                >
                  Next <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th className={cn("px-3 py-2.5 font-medium", className)}>{children}</th>;
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn("px-3 py-3", className)}>{children}</td>;
}

function Tally({ label, value, className }: { label: string; value: number; className: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium",
        className,
      )}
    >
      {value} {label}
    </span>
  );
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: "success" | "destructive" | "warning";
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-3.5 py-2.5 shadow-sm">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 font-display text-xl font-semibold tabular-nums",
          tone === "success" && "text-success",
          tone === "destructive" && "text-destructive",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
      </div>
    </div>
  );
}

const PRIORITY_STYLES: Record<string, string> = {
  low: "bg-muted text-muted-foreground",
  medium: "bg-primary/10 text-primary",
  high: "bg-warning/15 text-warning",
  critical: "bg-destructive/15 text-destructive",
};

function PriorityBadge({ priority }: { priority: string }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium capitalize",
        PRIORITY_STYLES[priority] ?? "bg-muted text-muted-foreground",
      )}
    >
      {priority || "medium"}
    </span>
  );
}

function StatusPill({ status }: { status: ReportRow["status"] }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-16 justify-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
        status === "Pass" && "bg-success/15 text-success",
        status === "Fail" && "bg-destructive/15 text-destructive",
        status === "Pending" && "bg-warning/15 text-warning",
      )}
    >
      {status}
    </span>
  );
}
