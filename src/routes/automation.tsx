import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bell,
  CalendarClock,
  Clock,
  Database,
  Download,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  Webhook,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { api, type Project, type Schedule } from "@/lib/api";
import { useProject } from "@/lib/use-project";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/automation")({
  head: () => ({
    meta: [
      { title: "Automation — ZeroBug" },
      {
        name: "description",
        content: "Schedule runs on a cron and trigger them from CI via webhook.",
      },
    ],
  }),
  component: AutomationPage,
});

const CRON_PRESETS = [
  { label: "Every 15 min", cron: "*/15 * * * *" },
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Daily 9am", cron: "0 9 * * *" },
  { label: "Weekdays 9am", cron: "0 9 * * 1-5" },
  { label: "Nightly 1am", cron: "0 1 * * *" },
];

const STATUS_BADGE: Record<string, string> = {
  passed: "bg-success/15 text-success",
  failed: "bg-destructive/15 text-destructive",
  running: "bg-running/15 text-running",
  skipped: "bg-muted text-muted-foreground",
};

function AutomationPage() {
  const qc = useQueryClient();
  const { currentProjectId, currentProject } = useProject();

  const { data: schedules = [], isLoading } = useQuery({
    queryKey: ["schedules", currentProjectId],
    queryFn: () => api.listSchedules(currentProjectId!),
    enabled: !!currentProjectId,
    refetchInterval: 15000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["schedules", currentProjectId] });

  const create = useMutation({
    mutationFn: (data: Parameters<typeof api.createSchedule>[1]) =>
      api.createSchedule(currentProjectId!, data),
    onSuccess: invalidate,
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.updateSchedule(id, { enabled }),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: api.deleteSchedule, onSuccess: invalidate });
  const genToken = useMutation({
    mutationFn: () => api.generateWebhookToken(currentProjectId!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });

  return (
    <AppShell title="Automation" breadcrumb="Schedules & triggers">
      <div className="space-y-6 p-4 md:p-6">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Automation</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Run this project's queue on a schedule, or trigger it from CI / curl via a webhook.
          </p>
        </div>

        {!currentProjectId && (
          <div className="rounded-xl border border-dashed border-border/70 p-10 text-center text-sm text-muted-foreground">
            Select or create a project (top-left) to manage automation.
          </div>
        )}

        {currentProjectId && (
          <>
            {/* Webhook trigger */}
            <section className="rounded-xl border border-border bg-card p-4">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <Webhook className="h-4 w-4 text-primary" />
                Webhook trigger (CI / curl)
              </h2>
              {currentProject?.webhookToken ? (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    POST to this URL to run the queue. Keep it secret — anyone with it can trigger
                    runs.
                  </p>
                  <code className="block overflow-x-auto rounded-lg border border-border bg-background p-2.5 font-mono text-xs scrollbar-thin">
                    curl -X POST {api.webhookRunUrl(currentProject.webhookToken)}
                  </code>
                  <button
                    onClick={() => genToken.mutate()}
                    disabled={genToken.isPending}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-40"
                  >
                    {genToken.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    Regenerate token
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => genToken.mutate()}
                  disabled={genToken.isPending}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
                >
                  {genToken.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Webhook className="h-3.5 w-3.5" />
                  )}
                  Generate webhook token
                </button>
              )}
            </section>

            {/* Alerts */}
            {currentProject && <AlertsSection project={currentProject} />}

            {/* Backup & migration */}
            <BackupSection projectId={currentProjectId} />

            {/* Schedules */}
            <section className="rounded-xl border border-border bg-card p-4">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <CalendarClock className="h-4 w-4 text-primary" />
                Scheduled runs
              </h2>

              <ScheduleForm
                pending={create.isPending}
                error={create.error as Error | null}
                onCreate={(data) => create.mutate(data)}
              />

              <div className="mt-4 space-y-2">
                {isLoading && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading schedules…
                  </div>
                )}
                {!isLoading && schedules.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    No schedules yet. Add one above — e.g.{" "}
                    <span className="font-mono">0 1 * * *</span> to run nightly at 1am.
                  </p>
                )}
                {schedules.map((s) => (
                  <ScheduleRow
                    key={s.id}
                    schedule={s}
                    onToggle={() => toggle.mutate({ id: s.id, enabled: !s.enabled })}
                    onDelete={() => remove.mutate(s.id)}
                  />
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </AppShell>
  );
}

function BackupSection({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { setProjectId } = useProject();
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const exportProject = async () => {
    if (exporting) return;
    setExporting(true);
    setMsg(null);
    try {
      await api.downloadProjectExport(projectId);
    } catch (e) {
      if ((e as Error)?.name !== "AuthError") setMsg(`Export failed: ${(e as Error).message}`);
    } finally {
      setExporting(false);
    }
  };

  const importMut = useMutation({
    mutationFn: (data: unknown) => api.importProject(data),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ["projects"] });
      setProjectId(res.project.id);
      setMsg(`Imported "${res.project.name}" with ${res.importedTests} test(s).`);
    },
    onError: (e: Error) => setMsg(`Import failed: ${e.message}`),
  });

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      importMut.mutate(JSON.parse(await file.text()));
    } catch {
      setMsg("That file isn't valid JSON.");
    }
  };

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Database className="h-4 w-4 text-primary" />
        Backup & migration
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Export this project (tests, custom columns, schedules, alerts) to a JSON file, or import a
        file as a brand-new project. Run history isn't included.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={exportProject}
          disabled={exporting}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 text-sm font-medium transition hover:bg-accent disabled:opacity-60"
        >
          {exporting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          Export project
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={importMut.isPending}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
        >
          {importMut.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          Import project
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          onChange={onFile}
          className="hidden"
        />
      </div>
      {msg && <p className="mt-2 text-[11px] text-muted-foreground">{msg}</p>}
    </section>
  );
}

function AlertsSection({ project }: { project: Project }) {
  const qc = useQueryClient();
  const [threshold, setThreshold] = useState("");
  const [critical, setCritical] = useState(false);

  useEffect(() => {
    setThreshold(project.alertPassRateThreshold ? String(project.alertPassRateThreshold) : "");
    setCritical(!!project.alertOnCriticalFail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const save = useMutation({
    mutationFn: () =>
      api.updateProject(project.id, {
        alertPassRateThreshold: Math.max(0, Math.min(100, Number(threshold) || 0)),
        alertOnCriticalFail: critical,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Bell className="h-4 w-4 text-primary" />
        Alerts
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        After a batch run, notify your configured channels (email / Slack / webhook) if results dip
        below a pass-rate threshold or a critical test fails.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
            Min pass rate (%)
          </span>
          <input
            type="number"
            min={0}
            max={100}
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            placeholder="0 = off"
            className="h-9 w-32 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus:border-primary/60"
          />
        </label>
        <label className="flex h-9 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={critical}
            onChange={(e) => setCritical(e.target.checked)}
            className="h-4 w-4 accent-[var(--primary)]"
          />
          Alert when a critical test fails
        </label>
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
        >
          {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {save.isSuccess ? "Saved" : "Save alerts"}
        </button>
      </div>
    </section>
  );
}

function ScheduleForm({
  pending,
  error,
  onCreate,
}: {
  pending: boolean;
  error: Error | null;
  onCreate: (data: { name: string; cron: string; suite?: string }) => void;
}) {
  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 1 * * *");
  const [suite, setSuite] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && cron.trim())
          onCreate({ name: name.trim(), cron: cron.trim(), suite: suite.trim() || undefined });
        setName("");
      }}
      className="rounded-lg border border-border bg-background/40 p-3"
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-muted-foreground">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nightly regression"
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary/60"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
            Cron (m h dom mon dow)
          </span>
          <input
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="0 1 * * *"
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm outline-none focus:border-primary/60"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
            Suite (optional)
          </span>
          <input
            value={suite}
            onChange={(e) => setSuite(e.target.value)}
            placeholder="all queued"
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary/60"
          />
        </label>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Clock className="h-3 w-3 text-muted-foreground" />
        {CRON_PRESETS.map((p) => (
          <button
            key={p.cron}
            type="button"
            onClick={() => setCron(p.cron)}
            className={cn(
              "rounded-md border px-2 py-0.5 text-[11px] transition",
              cron === p.cron
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {p.label}
          </button>
        ))}
        <button
          type="submit"
          disabled={!name.trim() || !cron.trim() || pending}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          Add schedule
        </button>
      </div>
      {error && <p className="mt-1 text-[11px] text-destructive">{error.message}</p>}
    </form>
  );
}

function ScheduleRow({
  schedule,
  onToggle,
  onDelete,
}: {
  schedule: Schedule;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background/40 px-3 py-2">
      <span className="font-medium">{schedule.name}</span>
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
        {schedule.cron}
      </code>
      {schedule.suite && (
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {schedule.suite}
        </span>
      )}
      {schedule.lastStatus && (
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-medium",
            STATUS_BADGE[schedule.lastStatus] ?? "bg-muted text-muted-foreground",
          )}
        >
          last: {schedule.lastStatus}
        </span>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        <button
          onClick={onToggle}
          className={cn(
            "rounded-md border px-2 py-1 text-xs font-medium transition",
            schedule.enabled
              ? "border-success/40 bg-success/10 text-success"
              : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          {schedule.enabled ? "Enabled" : "Disabled"}
        </button>
        <button
          onClick={onDelete}
          title="Delete schedule"
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      {schedule.lastError && (
        <p className="flex w-full items-start gap-1 text-[11px] text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          {schedule.lastError}
        </p>
      )}
    </div>
  );
}
