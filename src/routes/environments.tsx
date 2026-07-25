import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Globe,
  Plus,
  Lock,
  Server,
  Beaker,
  Trash2,
  Loader2,
  X,
  AlertTriangle,
  Code,
  Zap,
  CheckCircle,
  Boxes,
  Pencil,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { api, type Environment } from "@/lib/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/environments")({
  head: () => ({
    meta: [
      { title: "Environments — ZeroBug" },
      { name: "description", content: "Target environments for your Playwright test runs." },
    ],
  }),
  component: EnvironmentsPage,
});

const MAX_KINDS = 20;
const PAGE_SIZE = 10;

// A fixed global set of kind options (no longer per-project).
const DEFAULT_KINDS = ["prod", "staging", "ephemeral", "dev", "qa", "uat", "sandbox"];

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  prod: Globe,
  staging: Server,
  ephemeral: Beaker,
  dev: Code,
  qa: Zap,
  uat: CheckCircle,
  sandbox: Boxes,
};

function uptimePct(history: { healthy: boolean }[]) {
  if (!history.length) return 100;
  const up = history.filter((h) => h.healthy).length;
  return Math.round((up / history.length) * 100);
}

function kindTile(kind: string) {
  if (kind === "prod") return "bg-destructive/10 text-destructive";
  if (kind === "staging") return "bg-primary/10 text-primary";
  if (kind === "ephemeral") return "bg-warning/15 text-warning";
  return "bg-accent text-foreground";
}

function EnvironmentsPage() {
  const qc = useQueryClient();

  // Global — no projectId filter
  const {
    data: envs = [],
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ["environments"],
    queryFn: () => api.listEnvironments(),
    refetchInterval: 10_000,
  });

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Environment | null>(null);
  const [page, setPage] = useState(0);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["environments"] });

  const create = useMutation({
    mutationFn: (data: Partial<Environment>) => api.createEnvironment(data),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Environment> }) =>
      api.updateEnvironment(id, data),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: api.deleteEnvironment,
    onSuccess: invalidate,
  });

  const totalPages = Math.max(1, Math.ceil(envs.length / PAGE_SIZE));
  const paginated = useMemo(
    () => envs.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [envs, page],
  );

  // Reset to first page when the list changes
  useMemo(() => {
    if (page >= totalPages) setPage(0);
  }, [totalPages, page]);

  const closeModal = () => {
    if (create.isPending || update.isPending) return;
    create.reset();
    update.reset();
    setEditing(null);
    setModalOpen(false);
  };

  return (
    <AppShell
      title="Environments"
      breadcrumb="Global"
      hideProjectSwitcher
      actions={
        <button
          onClick={() => {
            setEditing(null);
            setModalOpen(true);
          }}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
        >
          <Plus className="h-3.5 w-3.5" />
          New environment
        </button>
      }
    >
      <div className="flex h-full flex-col">
        <div className="shrink-0 px-4 pb-3 pt-4 md:px-6 md:pt-6">
          <h1 className="font-display text-2xl font-semibold tracking-tight">Environments</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Global target environments shared across all projects. Health is live-pinged every 10
            seconds.
          </p>
        </div>

        <div className="flex-1 overflow-auto px-4 md:px-6">
          {isError && (
            <div className="mb-4 rounded-xl border border-destructive/40 bg-destructive/5 p-5 text-sm text-destructive">
              <AlertTriangle className="mb-2 h-5 w-5" />
              Couldn't reach the backend:{" "}
              <span className="font-mono">{(error as Error)?.message}</span>
            </div>
          )}

          {isLoading && (
            <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading environments…
            </div>
          )}

          {!isLoading && !isError && envs.length === 0 && (
            <div className="rounded-xl border border-dashed border-border/70 p-10 text-center text-sm text-muted-foreground">
              No environments yet. Click "New environment" to add one.
            </div>
          )}

          {!isLoading && !isError && envs.length > 0 && (
            <>
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/30 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      <th className="px-4 py-3">Name</th>
                      <th className="px-4 py-3">URL</th>
                      <th className="px-4 py-3">Kind</th>
                      <th className="px-4 py-3">Health</th>
                      <th className="px-4 py-3 text-center">Variables</th>
                      <th className="px-4 py-3 text-center">Secrets</th>
                      <th className="px-4 py-3 text-center">Status</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {paginated.map((e) => {
                      const Icon = KIND_ICON[e.kind] ?? Globe;
                      return (
                        <tr
                          key={e.id}
                          className={cn("transition hover:bg-accent/20", !e.active && "opacity-70")}
                        >
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <div
                                className={cn(
                                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                                  kindTile(e.kind),
                                )}
                              >
                                <Icon className="h-4 w-4" />
                              </div>
                              <span className="font-medium text-foreground">{e.name}</span>
                            </div>
                          </td>
                          <td className="max-w-[260px] truncate px-4 py-3 font-mono text-xs text-muted-foreground">
                            <a
                              href={e.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-primary hover:underline"
                            >
                              {e.url}
                            </a>
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={cn(
                                "rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground",
                                kindTile(e.kind),
                              )}
                            >
                              {e.kind}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={cn(
                                "inline-flex items-center gap-1.5 text-xs font-medium",
                                e.health === "healthy" ? "text-success" : "text-warning",
                              )}
                            >
                              <span
                                className={cn(
                                  "h-2 w-2 rounded-full",
                                  e.health === "healthy" ? "bg-success" : "bg-warning",
                                )}
                              />
                              {e.health}
                              {e.lastHealthError && (
                                <span className="ml-1 text-[10px] text-muted-foreground">
                                  · {e.lastHealthError}
                                </span>
                              )}
                            </span>
                            {e.healthHistory && e.healthHistory.length > 0 && (
                              <div
                                className="mt-1 text-[10px] text-muted-foreground"
                                title={`${e.healthHistory.length} samples`}
                              >
                                {uptimePct(e.healthHistory)}% uptime
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-center font-mono text-xs tabular-nums">
                            {e.vars}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className="inline-flex items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground">
                              {e.secrets > 0 && <Lock className="h-3 w-3" />}
                              {e.secrets}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span
                              className={cn(
                                "rounded-full px-2 py-0.5 text-[10px] font-medium",
                                e.active
                                  ? "bg-success/10 text-success"
                                  : "bg-muted text-muted-foreground",
                              )}
                            >
                              {e.active ? "Active" : "Idle"}
                            </span>
                            {e.storageStateSavedAt && (
                              <span
                                title="Saved login session — reused on runs"
                                className="ml-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary"
                              >
                                session
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <button
                                onClick={() => {
                                  setEditing(e);
                                  setModalOpen(true);
                                }}
                                title="Edit"
                                className="rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => remove.mutate(e.id)}
                                disabled={remove.isPending}
                                title="Delete"
                                className="rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-destructive disabled:opacity-40"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between border-t border-border px-1 py-3 text-sm">
                  <span className="text-xs text-muted-foreground">
                    Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, envs.length)}{" "}
                    of {envs.length}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                      disabled={page === 0}
                      className="rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    {Array.from({ length: totalPages }, (_, i) => (
                      <button
                        key={i}
                        onClick={() => setPage(i)}
                        className={cn(
                          "flex h-7 w-7 items-center justify-center rounded-md text-xs font-medium transition",
                          i === page
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:bg-accent hover:text-foreground",
                        )}
                      >
                        {i + 1}
                      </button>
                    ))}
                    <button
                      onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                      disabled={page >= totalPages - 1}
                      className="rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {modalOpen && (
        <EnvironmentModal
          editing={editing}
          pending={create.isPending || update.isPending}
          error={(create.error || update.error) as Error | null}
          onClose={closeModal}
          onSubmit={async (data) => {
            if (editing) await update.mutateAsync({ id: editing.id, data });
            else await create.mutateAsync(data);
            closeModal();
          }}
        />
      )}
    </AppShell>
  );
}

function EnvironmentModal({
  editing,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  editing: Environment | null;
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onSubmit: (data: Partial<Environment>) => void;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [url, setUrl] = useState(editing?.url ?? "");
  const [kind, setKind] = useState<string>(editing?.kind ?? "staging");
  const [loginInstructions, setLoginInstructions] = useState(editing?.loginInstructions ?? "");
  const [customKind, setCustomKind] = useState("");

  const allKinds = Array.from(
    new Set([
      ...DEFAULT_KINDS,
      ...(editing?.kind && !DEFAULT_KINDS.includes(editing.kind) ? [editing.kind] : []),
      ...(customKind.trim() ? [customKind.trim().toLowerCase().replace(/\s+/g, "-")] : []),
    ]),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      <div className="absolute inset-0 bg-background/70 backdrop-blur-sm" onClick={onClose} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const finalKind = customKind.trim()
            ? customKind.trim().toLowerCase().replace(/\s+/g, "-")
            : kind;
          if (name.trim() && url.trim())
            onSubmit({
              name: name.trim(),
              url: url.trim(),
              kind: finalKind,
              loginInstructions: loginInstructions.trim(),
            });
        }}
        className="relative w-full max-w-lg rounded-2xl border border-border bg-card p-5 shadow-2xl animate-scale-in"
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-display text-lg font-semibold">
              {editing ? "Edit environment" : "New environment"}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Point ZeroBug at a real URL — shared across all projects.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Staging"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">URL</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://staging.example.com"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
            />
          </label>

          <div>
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Kind</span>
            <div className="flex flex-wrap gap-1.5">
              {allKinds.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={cn(
                    "rounded-md border px-2 py-1 text-[11px] font-medium capitalize transition",
                    kind === k && !customKind.trim()
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {k}
                </button>
              ))}
            </div>
            <input
              value={customKind}
              onChange={(e) => setCustomKind(e.target.value)}
              placeholder="Or type a custom kind…"
              className="mt-2 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
            />
          </div>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Login instructions <span className="text-muted-foreground/60">(optional)</span>
            </span>
            <textarea
              rows={2}
              value={loginInstructions}
              onChange={(e) => setLoginInstructions(e.target.value)}
              placeholder='e.g. "log in with admin@example.com / hunter2"'
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
            />
            <span className="mt-1 block text-[11px] text-muted-foreground">
              ZeroBug reuses this whenever it hits a login — so it only asks you once.
            </span>
          </label>

          {editing && <EnvSecretsPanel env={editing} />}

          {error && <p className="text-xs text-destructive">{error.message}</p>}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || !url.trim() || pending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
          >
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {editing ? "Save changes" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

function EnvSecretsPanel({ env }: { env: Environment }) {
  const qc = useQueryClient();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");

  const { data: secrets = [], isLoading } = useQuery({
    queryKey: ["secrets", env.id],
    queryFn: () => api.listSecrets(env.id),
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["secrets", env.id] });
    qc.invalidateQueries({ queryKey: ["environments"] });
  };
  const save = useMutation({
    mutationFn: () => api.setSecret(env.id, key.trim(), value),
    onSuccess: () => {
      setKey("");
      setValue("");
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (k: string) => api.deleteSecret(env.id, k),
    onSuccess: invalidate,
  });
  const clearSession = useMutation({
    mutationFn: () => api.clearSession(env.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["environments"] }),
  });

  return (
    <div className="rounded-lg border border-border bg-background/40 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-x-2 text-xs font-medium text-muted-foreground">
        <Lock className="h-3.5 w-3.5" /> Secrets
        <span className="font-normal text-[10px]">
          reference in a test as <code className="rounded bg-muted px-1">{"{{KEY}}"}</code>
        </span>
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : secrets.length === 0 ? (
        <p className="text-xs text-muted-foreground">No secrets yet.</p>
      ) : (
        <div className="space-y-1">
          {secrets.map((s) => (
            <div key={s.key} className="flex items-center gap-2 text-sm">
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{s.key}</code>
              <span className="text-[11px] tracking-widest text-muted-foreground">••••••</span>
              <button
                type="button"
                onClick={() => remove.mutate(s.key)}
                title="Delete secret"
                className="ml-auto rounded-md p-1 text-muted-foreground transition hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 flex gap-1.5">
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="KEY"
          className="w-28 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none focus:border-primary/60"
        />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          type="password"
          placeholder="value (encrypted at rest)"
          className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary/60"
        />
        <button
          type="button"
          disabled={!key.trim() || save.isPending}
          onClick={() => save.mutate()}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-40"
        >
          {save.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Plus className="h-3 w-3" />
          )}
          Save
        </button>
      </div>
      {save.error && (
        <p className="mt-1 text-[11px] text-destructive">{(save.error as Error).message}</p>
      )}

      <div className="mt-3 border-t border-border pt-2 text-xs">
        {env.storageStateSavedAt ? (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">
              Logged-in session saved — reused on runs to skip login.
            </span>
            <button
              type="button"
              onClick={() => clearSession.mutate()}
              disabled={clearSession.isPending}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-muted-foreground transition hover:text-destructive disabled:opacity-40"
            >
              {clearSession.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <X className="h-3 w-3" />
              )}
              Clear session
            </button>
          </div>
        ) : (
          <span className="text-muted-foreground">
            No saved session yet — one is captured after a passing run.
          </span>
        )}
      </div>
    </div>
  );
}
