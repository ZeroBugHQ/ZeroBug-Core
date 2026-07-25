import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Cpu,
  History,
  Loader2,
  Repeat,
  TrendingUp,
  Wrench,
  XCircle,
  Zap,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { api, type AuditEntry, type Insights, type PassRateBucket, type Stats } from "@/lib/api";
import { useProject } from "@/lib/use-project";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/stats")({
  head: () => ({
    meta: [
      { title: "Statistics — ZeroBug" },
      { name: "description", content: "Model token usage, tool calls, and run outcomes." },
    ],
  }),
  component: StatsPage,
});

function fmt(n: number) {
  return n.toLocaleString();
}
function secs(ms: number) {
  return ms > 0 ? `${(ms / 1000).toFixed(2)}s` : "—";
}

function StatsPage() {
  const { currentProjectId } = useProject();
  const [historyDays, setHistoryDays] = useState(365);
  const {
    data: stats,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ["stats", currentProjectId],
    queryFn: () => api.getStats(currentProjectId!),
    enabled: !!currentProjectId,
    refetchInterval: 4000,
  });

  const { data: history = [] } = useQuery({
    queryKey: ["stats-history", currentProjectId, historyDays],
    queryFn: () => api.getPassRateHistory(currentProjectId!, historyDays),
    enabled: !!currentProjectId,
    refetchInterval: 30_000,
  });

  const { data: insights } = useQuery({
    queryKey: ["stats-insights", currentProjectId],
    queryFn: () => api.getInsights(currentProjectId!),
    enabled: !!currentProjectId,
    refetchInterval: 15_000,
  });

  return (
    <AppShell title="Statistics" breadcrumb="Insights">
      <div className="p-4 md:p-6">
        <div className="mb-5">
          <h1 className="font-display text-2xl font-semibold tracking-tight">Statistics</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Live model usage, tool calls, and run outcomes for this project.
          </p>
        </div>

        {!currentProjectId && (
          <Empty>Select or create a project (top-left) to view its statistics.</Empty>
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
            <Loader2 className="h-4 w-4 animate-spin" /> Loading statistics…
          </div>
        )}

        {stats && (
          <StatsBody
            stats={stats}
            history={history}
            onHistoryDaysChange={setHistoryDays}
            insights={insights}
            projectId={currentProjectId}
          />
        )}
      </div>
    </AppShell>
  );
}

function StatsBody({
  stats,
  history,
  insights,
  projectId,
  onHistoryDaysChange,
}: {
  stats: Stats;
  history: PassRateBucket[];
  insights?: Insights;
  projectId: string | null;
  onHistoryDaysChange: (days: number) => void;
}) {
  const { usage, outcomes, slowest, failing, model } = stats;
  const toolEntries = Object.entries(usage.toolCalls).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-6">
      {insights && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Section title="Flaky tests" icon={Repeat}>
            {insights.flaky.length === 0 ? (
              <p className="text-sm text-muted-foreground">None — results are consistent.</p>
            ) : (
              <ul className="space-y-1.5">
                {insights.flaky.map((f) => (
                  <li key={f.code} className="flex items-center gap-2 text-sm">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      {f.code}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-foreground">{f.title}</span>
                    <span className="shrink-0 text-xs text-warning">
                      {f.passes}✓ / {f.fails}✗
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Since last run" icon={TrendingUp}>
            <div className="space-y-2 text-sm">
              <DiffRow label="Newly failed" tone="destructive" rows={insights.diff.newlyFailed} />
              <DiffRow label="Newly passed" tone="success" rows={insights.diff.newlyPassed} />
              <DiffRow
                label="Slower"
                tone="warning"
                rows={insights.diff.slower.map((s) => ({
                  code: s.code,
                  title: `${s.title} (${secs(s.prevMs)} → ${secs(s.lastMs)})`,
                }))}
              />
            </div>
          </Section>
        </div>
      )}

      {/* Model usage */}
      <Section title="Model usage" icon={Cpu}>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono text-foreground">{model.name}</span>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium",
              model.reachable ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                model.reachable ? "bg-success" : "bg-destructive",
              )}
            />
            {model.reachable ? "online" : "offline"}
          </span>
          <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-foreground">
            resolved: <span className="font-mono">{model.resolved}</span>
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium",
              model.selectedAvailable ? "bg-success/15 text-success" : "bg-warning/15 text-warning",
            )}
          >
            {model.selectedAvailable ? "selected model available" : "falling back to another model"}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Metric label="Total tokens" value={fmt(usage.totalTokens)} icon={Zap} />
          <Metric label="Prompt tokens" value={fmt(usage.promptTokens)} />
          <Metric label="Response tokens" value={fmt(usage.responseTokens)} />
          <Metric label="Model requests" value={fmt(usage.requests)} />
        </div>
      </Section>

      {/* Tool calls */}
      <Section title="Tool calls" icon={Wrench}>
        {toolEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tool calls yet.</p>
        ) : (
          <div className="space-y-2">
            {toolEntries.map(([name, count]) => {
              const max = toolEntries[0][1] || 1;
              return (
                <div key={name} className="flex items-center gap-3">
                  <span className="w-32 shrink-0 truncate font-mono text-xs text-foreground">
                    {name}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.round((count / max) * 100)}%` }}
                    />
                  </div>
                  <span className="w-10 shrink-0 text-right font-mono text-xs text-muted-foreground">
                    {fmt(count)}
                  </span>
                </div>
              );
            })}
            <p className="pt-1 text-[11px] text-muted-foreground">
              {fmt(usage.toolRequests)} tool call{usage.toolRequests === 1 ? "" : "s"} total
            </p>
          </div>
        )}
      </Section>

      {/* Run outcomes */}
      <Section title="Run outcomes" icon={Activity}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Metric label="Passed" value={fmt(outcomes.passed)} icon={CheckCircle2} tone="success" />
          <Metric label="Failed" value={fmt(outcomes.failed)} icon={XCircle} tone="destructive" />
          <Metric label="Pass rate" value={`${outcomes.passRate}%`} />
          <Metric label="Avg duration" value={secs(outcomes.avgDurationMs)} icon={Clock} />
        </div>
      </Section>

      {/* Per-test breakdown */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Section title="Slowest tests" icon={Clock}>
          <Breakdown
            rows={slowest.map((s) => ({ code: s.code, title: s.title, right: secs(s.durationMs) }))}
            empty="No timed runs yet."
          />
        </Section>
        <Section title="Most-failing tests" icon={XCircle}>
          <Breakdown
            rows={failing.map((f) => ({
              code: f.code,
              title: f.title,
              right: `${f.fails}×`,
            }))}
            empty="No failures recorded."
          />
        </Section>
      </div>

      {/* Recent activity (audit log) */}
      <RecentActivity projectId={projectId} />

      <PassRateChart buckets={history} onNeedDays={onHistoryDaysChange} />
    </div>
  );
}

// ── Recent activity (audit log) ───────────────────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  "project.create": "Project created",
  "project.delete": "Project deleted",
  "project.import": "Project imported",
  "suite.generate": "Test suite generated",
  "run.start": "Run started",
  "run.start-all": "Queue run started",
  "run.stop": "Runs stopped",
};

function timeAgo(iso: string) {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (!Number.isFinite(diff)) return "";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function RecentActivity({ projectId }: { projectId: string | null }) {
  const { data: entries = [] } = useQuery({
    queryKey: ["audit", projectId],
    queryFn: () => api.listAudit(projectId, 25),
    enabled: !!projectId,
    refetchInterval: 10_000,
  });

  return (
    <Section title="Recent activity" icon={History}>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No recorded activity yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {entries.map((e: AuditEntry) => (
            <li key={e.id} className="flex items-center gap-3 text-sm">
              <span className="w-36 shrink-0 truncate text-xs font-medium text-foreground">
                {ACTION_LABELS[e.action] ?? e.action}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{e.detail}</span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {timeAgo(e.at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ── Pass-rate chart ───────────────────────────────────────────────────────────

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string) {
  const a = new Date(`${from}T00:00:00`).getTime();
  const b = new Date(`${to}T00:00:00`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 30;
  return Math.max(1, Math.ceil((b - a) / 86_400_000) + 1);
}

function PassRateChart({
  buckets,
  onNeedDays,
}: {
  buckets: PassRateBucket[];
  onNeedDays: (days: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<{ destroy: () => void } | null>(null);
  const [from, setFrom] = useState(daysAgoIso(29));
  const [to, setTo] = useState(todayIso());

  useEffect(() => {
    onNeedDays(Math.min(1095, Math.max(30, daysBetween(from, todayIso()))));
  }, [from, onNeedDays]);

  const filtered = useMemo(
    () => buckets.filter((bucket) => bucket.date >= from && bucket.date <= to),
    [buckets, from, to],
  );
  const hasData = filtered.some((bucket) => bucket.total > 0);

  useEffect(() => {
    let cancelled = false;

    async function draw() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const { Chart } = await import("chart.js/auto");
      if (cancelled) return;

      const styles = getComputedStyle(document.documentElement);
      const css = (name: string, fallback: string) =>
        styles.getPropertyValue(name).trim() || fallback;
      const success = css("--success", "#22c55e");
      const destructive = css("--destructive", "#ef4444");
      const primary = css("--primary", "#f97316");
      const card = css("--card", "#15110f");
      const muted = css("--muted-foreground", "#9a8f87");
      const border = css("--border", "rgba(255,255,255,0.16)");

      chartRef.current?.destroy();
      chartRef.current = new Chart(canvas, {
        type: "line",
        data: {
          labels: filtered.map((bucket) => bucket.date.slice(5)),
          datasets: [
            {
              label: "Pass rate",
              data: filtered.map((bucket) => bucket.passRate),
              borderColor: success,
              backgroundColor: "rgba(34, 197, 94, 0.12)",
              pointBackgroundColor: filtered.map((bucket) =>
                bucket.passRate === 100 ? success : bucket.passRate === 0 ? destructive : primary,
              ),
              pointBorderColor: card,
              pointBorderWidth: 2,
              pointRadius: 4,
              pointHoverRadius: 7,
              tension: 0.35,
              fill: true,
              spanGaps: true,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          scales: {
            y: {
              min: 0,
              max: 100,
              ticks: {
                color: muted,
                callback: (value) => `${value}%`,
              },
              grid: { color: border },
            },
            x: {
              ticks: { color: muted, maxRotation: 0 },
              grid: { display: false },
            },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                title: (items) => filtered[items[0]?.dataIndex]?.date ?? "",
                label: (item) => {
                  const bucket = filtered[item.dataIndex];
                  return bucket
                    ? `Pass rate: ${bucket.passRate ?? "-"}% (${bucket.passed} passed, ${bucket.failed} failed)`
                    : "";
                },
              },
            },
          },
        },
      });
    }

    void draw();
    return () => {
      cancelled = true;
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [filtered]);

  return (
    <Section title="Pass rate over time" icon={TrendingUp}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Filter the chart by date range. Days without runs are left empty.
        </p>
        <DateRangePicker
          from={from}
          to={to}
          onChange={(next) => {
            setFrom(next.from);
            setTo(next.to);
          }}
        />
      </div>
      {!hasData && (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No runs recorded in this date range.
        </p>
      )}
      <div className={cn("h-[320px] w-full", !hasData && "hidden")}>
        <canvas ref={canvasRef} />
      </div>
    </Section>
  );
}

function DateRangePicker({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(() => new Date(`${to}T00:00:00`));
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const first = new Date(year, month, 1);
  const startOffset = first.getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const cells = Array.from({ length: startOffset + days }, (_, i) =>
    i < startOffset ? null : new Date(year, month, i - startOffset + 1),
  );

  const pick = (iso: string) => {
    if (!from || (from && to)) onChange({ from: iso, to: iso });
    else if (iso < from) onChange({ from: iso, to: from });
    else onChange({ from, to: iso });
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium transition hover:bg-accent/50"
      >
        <CalendarDays className="h-4 w-4 text-primary" />
        <span className="font-mono text-xs">{from}</span>
        <span className="text-muted-foreground">to</span>
        <span className="font-mono text-xs">{to}</span>
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 rounded-xl border border-border bg-card p-3 shadow-xl animate-fade-in">
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setCursor(new Date(year, month - 1, 1))}
              className="rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="text-sm font-semibold">
              {cursor.toLocaleString(undefined, { month: "long", year: "numeric" })}
            </div>
            <button
              type="button"
              onClick={() => setCursor(new Date(year, month + 1, 1))}
              className="rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-medium uppercase text-muted-foreground">
            {["S", "M", "T", "W", "T", "F", "S"].map((day, i) => (
              <div key={`${day}-${i}`} className="py-1">
                {day}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((date, i) => {
              if (!date) return <div key={i} />;
              const iso = date.toISOString().slice(0, 10);
              const inRange = iso >= from && iso <= to;
              const edge = iso === from || iso === to;
              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => pick(iso)}
                  className={cn(
                    "h-8 rounded-md text-xs transition hover:bg-accent",
                    inRange && "bg-primary/10 text-primary",
                    edge && "bg-primary text-primary-foreground hover:bg-primary",
                  )}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => onChange({ from: daysAgoIso(6), to: todayIso() })}
              className="rounded-md border border-border px-2 py-1 text-xs transition hover:bg-accent"
            >
              7 days
            </button>
            <button
              type="button"
              onClick={() => onChange({ from: daysAgoIso(29), to: todayIso() })}
              className="rounded-md border border-border px-2 py-1 text-xs transition hover:bg-accent"
            >
              30 days
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Icon className="h-4 w-4 text-primary" />
        {title}
      </h2>
      {children}
    </section>
  );
}

function Metric({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: "success" | "destructive";
}) {
  return (
    <div className="rounded-lg border border-border bg-background/40 px-3 py-2.5">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </div>
      <div
        className={cn(
          "mt-1 font-mono text-lg font-semibold",
          tone === "success" && "text-success",
          tone === "destructive" && "text-destructive",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function Breakdown({
  rows,
  empty,
}: {
  rows: Array<{ code: string; title: string; right: string }>;
  empty: string;
}) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.code} className="flex items-center gap-2 text-sm">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {r.code}
          </span>
          <span className="min-w-0 flex-1 truncate text-foreground">{r.title}</span>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{r.right}</span>
        </li>
      ))}
    </ul>
  );
}

function DiffRow({
  label,
  tone,
  rows,
}: {
  label: string;
  tone: "destructive" | "success" | "warning";
  rows: Array<{ code: string; title: string }>;
}) {
  const color =
    tone === "destructive"
      ? "text-destructive"
      : tone === "success"
        ? "text-success"
        : "text-warning";
  return (
    <div>
      <div className={cn("text-[11px] font-medium uppercase tracking-wide", color)}>
        {label} ({rows.length})
      </div>
      {rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">—</p>
      ) : (
        <ul className="mt-0.5 space-y-0.5">
          {rows.map((r) => (
            <li key={r.code} className="flex items-center gap-2 text-xs">
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                {r.code}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground">{r.title}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border/70 p-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
