import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Brain,
  ChevronRight,
  Globe,
  Loader2,
  LogIn,
  MessageSquareWarning,
  MousePointerClick,
  StickyNote,
  Trash2,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { api, type SiteLesson } from "@/lib/api";
import { useProject } from "@/lib/use-project";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/memory")({
  head: () => ({
    meta: [
      { title: "Agent memory — ZeroBug" },
      {
        name: "description",
        content: "Lessons the agent has learned about each site to run tests more reliably.",
      },
    ],
  }),
  component: MemoryPage,
});

const KIND_META: Record<
  SiteLesson["kind"],
  { label: string; icon: typeof Brain; className: string }
> = {
  popup: {
    label: "Popup",
    icon: MousePointerClick,
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  login: {
    label: "Login",
    icon: LogIn,
    className: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
  failure: {
    label: "Failure",
    icon: MessageSquareWarning,
    className: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  },
  note: {
    label: "Note",
    icon: StickyNote,
    className: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  },
};

function MemoryPage() {
  const { currentProjectId } = useProject();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<SiteLesson | null>(null);

  const {
    data: lessons = [],
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ["memory", currentProjectId],
    queryFn: () => api.listMemory(currentProjectId!),
    enabled: !!currentProjectId,
    refetchInterval: 10_000,
  });

  const forget = useMutation({
    mutationFn: (id: string) => api.forgetLesson(currentProjectId!, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["memory", currentProjectId] }),
  });

  const forgetSite = useMutation({
    mutationFn: (origin: string) => api.forgetAllMemory(currentProjectId!, origin),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["memory", currentProjectId] }),
  });

  // Group lessons by site origin, strongest first within each group.
  const groups = useMemo(() => {
    const map = new Map<string, SiteLesson[]>();
    for (const l of lessons) {
      const list = map.get(l.origin) ?? [];
      list.push(l);
      map.set(l.origin, list);
    }
    return [...map.entries()].map(([origin, items]) => ({
      origin,
      items: items.sort((a, b) => b.confidence - a.confidence),
    }));
  }, [lessons]);

  return (
    <AppShell title="Agent memory" breadcrumb="Learning">
      <div className="p-4 md:p-6">
        <div className="mb-5">
          <h1 className="flex items-center gap-2 font-display text-2xl font-semibold tracking-tight">
            <Brain className="h-6 w-6 text-primary" />
            Agent memory
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Lessons ZeroBug has learned from past runs on each site — popups to dismiss, login
            quirks, slow areas, and flaky features. These are injected as hints before the agent
            acts, and their confidence rises when a run that used them passes and falls when it
            fails. Forget any that look wrong.
          </p>
        </div>

        {!currentProjectId && (
          <Empty>Select or create a project (top-left) to view what the agent has learned.</Empty>
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
            <Loader2 className="h-4 w-4 animate-spin" /> Loading memory…
          </div>
        )}

        {currentProjectId && !isLoading && !groups.length && (
          <Empty>
            Nothing learned yet. Run some UI tests and ZeroBug will start remembering how each site
            behaves.
          </Empty>
        )}

        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.origin} className="rounded-xl border border-border bg-card/40">
              <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono text-sm font-medium">{group.origin}</span>
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {group.items.length}
                  </span>
                </div>
                <button
                  onClick={() => {
                    if (confirm(`Forget everything ZeroBug learned about ${group.origin}?`))
                      forgetSite.mutate(group.origin);
                  }}
                  className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                >
                  Forget site
                </button>
              </header>
              <ul className="divide-y divide-border">
                {group.items.map((lesson) => (
                  <LessonRow
                    key={lesson.id}
                    lesson={lesson}
                    onOpen={() => setSelected(lesson)}
                    onForget={() => forget.mutate(lesson.id)}
                    forgetting={forget.isPending && forget.variables === lesson.id}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>

      {selected && (
        <LessonDetail
          lesson={lessons.find((l) => l.id === selected.id) ?? selected}
          onClose={() => setSelected(null)}
          onForget={() => {
            forget.mutate(selected.id);
            setSelected(null);
          }}
        />
      )}
    </AppShell>
  );
}

function LessonRow({
  lesson,
  onOpen,
  onForget,
  forgetting,
}: {
  lesson: SiteLesson;
  onOpen: () => void;
  onForget: () => void;
  forgetting: boolean;
}) {
  const meta = KIND_META[lesson.kind] ?? KIND_META.note;
  const Icon = meta.icon;
  const pct = Math.round((lesson.confidence ?? 0) * 100);
  const pruned = lesson.status === "pruned";

  return (
    <li className={cn("flex items-stretch", pruned && "opacity-50")}>
      <button
        onClick={onOpen}
        title="View details and stats"
        className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3 text-left transition hover:bg-accent/40"
      >
        <span
          className={cn(
            "mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium",
            meta.className,
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          {meta.label}
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">{lesson.lesson}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <ConfidenceBar pct={pct} pruned={pruned} />
            <span>
              {lesson.wins}✓ / {lesson.losses}✗ over {lesson.uses} use{lesson.uses === 1 ? "" : "s"}
            </span>
            {lesson.source === "reflection" && (
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                AI reflection
              </span>
            )}
            {pruned && <span className="text-rose-500">pruned (low confidence)</span>}
          </div>
        </div>

        <ChevronRight className="mt-1 h-4 w-4 shrink-0 self-center text-muted-foreground" />
      </button>

      <button
        onClick={onForget}
        disabled={forgetting}
        title="Forget this lesson"
        aria-label="Forget this lesson"
        className="flex shrink-0 items-center px-3 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
      >
        {forgetting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
      </button>
    </li>
  );
}

function LessonDetail({
  lesson,
  onClose,
  onForget,
}: {
  lesson: SiteLesson;
  onClose: () => void;
  onForget: () => void;
}) {
  const meta = KIND_META[lesson.kind] ?? KIND_META.note;
  const Icon = meta.icon;
  const pct = Math.round((lesson.confidence ?? 0) * 100);
  const winRate = lesson.uses > 0 ? Math.round((lesson.wins / lesson.uses) * 100) : null;
  const detailEntries = Object.entries(lesson.detail ?? {}).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-card shadow-2xl scrollbar-thin"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-border p-5">
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium",
              meta.className,
            )}
          >
            <Icon className="h-4 w-4" />
            {meta.label}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Globe className="h-3.5 w-3.5" />
              <span className="truncate font-mono">{lesson.origin}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 p-5">
          {/* The lesson itself */}
          <p className="text-sm leading-relaxed text-foreground">{lesson.lesson}</p>

          {/* Confidence gauge */}
          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Confidence
              </span>
              <span className="font-display text-2xl font-semibold tabular-nums">{pct}%</span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  lesson.status === "pruned"
                    ? "bg-rose-500/60"
                    : pct >= 60
                      ? "bg-emerald-500"
                      : pct >= 30
                        ? "bg-amber-500"
                        : "bg-rose-500",
                )}
                style={{ width: `${Math.max(2, pct)}%` }}
              />
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {lesson.status === "pruned"
                ? "Pruned — confidence dropped too low, so this is no longer used as a hint."
                : pct < 40
                  ? "Still unproven — it needs a few more passing runs to be trusted."
                  : pct >= 60
                    ? "Trusted — this has reliably helped past runs."
                    : "Building trust as runs use it."}
            </p>
          </div>

          {/* Confidence history sparkline */}
          <Sparkline history={lesson.history ?? []} />

          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Uses" value={String(lesson.uses)} />
            <Stat label="Passed" value={String(lesson.wins)} tone="pass" />
            <Stat label="Failed" value={String(lesson.losses)} tone="fail" />
            <Stat label="Win rate" value={winRate === null ? "—" : `${winRate}%`} />
          </div>

          {/* Metadata */}
          <dl className="space-y-1.5 text-xs">
            <MetaRow label="Source">
              {lesson.source === "reflection"
                ? "AI reflection (learned from a failure)"
                : "Mined from run data"}
            </MetaRow>
            <MetaRow label="Status">{lesson.status}</MetaRow>
            <MetaRow label="First learned">{fmtDate(lesson.createdAt)}</MetaRow>
            <MetaRow label="Last updated">{fmtDate(lesson.updatedAt)}</MetaRow>
            {lesson.lastUsedAt && <MetaRow label="Last used">{fmtDate(lesson.lastUsedAt)}</MetaRow>}
            {detailEntries.map(([k, v]) => (
              <MetaRow key={k} label={k}>
                <span className="font-mono">{String(v)}</span>
              </MetaRow>
            ))}
          </dl>

          <button
            onClick={onForget}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-destructive/40 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/10"
          >
            <Trash2 className="h-4 w-4" />
            Forget this lesson
          </button>
        </div>
      </div>
    </div>
  );
}

function Sparkline({ history }: { history: NonNullable<SiteLesson["history"]> }) {
  const points = history.filter((h) => Number.isFinite(h.confidence));
  if (points.length < 2) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
        Confidence history appears here once this lesson has been used in a couple of runs.
      </div>
    );
  }
  const W = 100;
  const H = 32;
  const step = W / (points.length - 1);
  const coords = points.map((p, i) => [i * step, H - Math.max(0, Math.min(1, p.confidence)) * H]);
  const path = coords
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const last = points[points.length - 1];
  const first = points[0];
  const trendUp = last.confidence >= first.confidence;

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Confidence over time
        </span>
        <span
          className={cn(
            "inline-flex items-center gap-1 text-xs",
            trendUp ? "text-emerald-500" : "text-rose-500",
          )}
        >
          {trendUp ? (
            <TrendingUp className="h-3.5 w-3.5" />
          ) : (
            <TrendingDown className="h-3.5 w-3.5" />
          )}
          {points.length} data point{points.length === 1 ? "" : "s"}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-12 w-full rounded-lg border border-border bg-muted/20"
      >
        <path
          d={path}
          fill="none"
          stroke={trendUp ? "rgb(16 185 129)" : "rgb(244 63 94)"}
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
        {coords.map(([x, y], i) => (
          <circle
            key={i}
            cx={x}
            cy={y}
            r="1.6"
            fill={points[i].passed ? "rgb(16 185 129)" : "rgb(244 63 94)"}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Green dots = runs that passed using this lesson, red = failed.
      </p>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "pass" | "fail" }) {
  return (
    <div className="rounded-lg border border-border bg-background/40 px-3 py-2">
      <div
        className={cn(
          "font-display text-lg font-semibold tabular-nums",
          tone === "pass" && "text-emerald-500",
          tone === "fail" && "text-rose-500",
        )}
      >
        {value}
      </div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 capitalize text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-foreground">{children}</dd>
    </div>
  );
}

function fmtDate(iso?: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function ConfidenceBar({ pct, pruned }: { pct: number; pruned: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={`Confidence ${pct}%`}>
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
        <span
          className={cn(
            "block h-full rounded-full",
            pruned ? "bg-rose-500/60" : pct >= 60 ? "bg-emerald-500" : "bg-amber-500",
          )}
          style={{ width: `${Math.max(4, pct)}%` }}
        />
      </span>
      <span className="tabular-nums">{pct}%</span>
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/30 p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
