import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronsUpDown, FolderKanban, Pencil, Plus, Trash2, X } from "lucide-react";
import { api, type Project } from "@/lib/api";
import { useProject } from "@/lib/use-project";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { cn } from "@/lib/utils";

export function ProjectSwitcher() {
  const qc = useQueryClient();
  const { projects, currentProject, currentProjectId, setProjectId } = useProject();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<Project | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
        setRenamingId(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["projects"] });

  const createMut = useMutation({
    mutationFn: (name: string) => api.createProject({ name }),
    onSuccess: (p) => {
      invalidate();
      setProjectId(p.id);
      setCreating(false);
      setNewName("");
      setOpen(false);
    },
  });
  const renameMut = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.updateProject(id, { name }),
    onSuccess: () => {
      invalidate();
      setRenamingId(null);
    },
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: () => {
      invalidate();
      setConfirmDelete(null);
    },
  });

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm transition hover:bg-accent"
      >
        <FolderKanban className="h-4 w-4 text-primary" />
        <span className="max-w-[180px] truncate font-medium text-foreground">
          {currentProject?.name ?? "Select project"}
        </span>
        <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1.5 w-80 overflow-hidden rounded-xl border border-border bg-popover shadow-xl animate-scale-in">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <FolderKanban className="h-3.5 w-3.5 text-signal" />
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Projects
            </span>
            <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {projects.length}
            </span>
          </div>

          <div className="max-h-72 space-y-0.5 overflow-y-auto scrollbar-thin p-1.5">
            {projects.length === 0 && (
              <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                No projects yet. Create your first one below.
              </div>
            )}
            {projects.map((p) => {
              const active = p.id === currentProjectId;
              if (renamingId === p.id) {
                return (
                  <form
                    key={p.id}
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (renameValue.trim())
                        renameMut.mutate({ id: p.id, name: renameValue.trim() });
                    }}
                    className="flex items-center gap-1.5 rounded-md bg-accent/40 p-1"
                  >
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring/40"
                    />
                    <button
                      type="submit"
                      title="Save"
                      className="grid h-7 w-7 place-items-center rounded-md bg-signal text-signal-foreground transition hover:brightness-105"
                    >
                      <Check className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setRenamingId(null)}
                      title="Cancel"
                      className="grid h-7 w-7 place-items-center rounded-md border border-border text-muted-foreground transition hover:bg-accent hover:text-foreground"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </form>
                );
              }
              return (
                <div
                  key={p.id}
                  className={cn(
                    "group relative flex items-center gap-2.5 rounded-md border py-2 pl-2.5 pr-1.5 text-sm transition",
                    active
                      ? "border-signal/40 bg-signal/10"
                      : "border-transparent hover:border-border hover:bg-accent/60",
                  )}
                >
                  <button
                    onClick={() => {
                      setProjectId(p.id);
                      setOpen(false);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  >
                    <span
                      className={cn(
                        "grid h-7 w-7 shrink-0 place-items-center rounded-md border",
                        active
                          ? "border-signal/40 bg-signal/15 text-signal"
                          : "border-border bg-card text-muted-foreground",
                      )}
                    >
                      <FolderKanban className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block truncate font-medium",
                          active ? "text-foreground" : "text-foreground/90",
                        )}
                      >
                        {p.name}
                      </span>
                      {active && (
                        <span className="text-[10px] font-medium uppercase tracking-wide text-signal">
                          Active
                        </span>
                      )}
                    </span>
                    {active && <Check className="h-4 w-4 shrink-0 text-signal" />}
                  </button>
                  <button
                    onClick={() => {
                      setRenamingId(p.id);
                      setRenameValue(p.name);
                    }}
                    title="Rename"
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => {
                      setConfirmDelete(p);
                      setOpen(false);
                    }}
                    title="Delete"
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition hover:bg-destructive hover:text-destructive-foreground group-hover:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>

          <div className="border-t border-border p-1.5">
            {creating ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (newName.trim()) createMut.mutate(newName.trim());
                }}
                className="flex items-center gap-1.5"
              >
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Project name"
                  className="flex-1 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring/40"
                />
                <button
                  type="submit"
                  disabled={!newName.trim() || createMut.isPending}
                  className="rounded-md bg-signal px-3 py-1.5 text-xs font-semibold text-signal-foreground transition hover:brightness-105 disabled:opacity-40"
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreating(false);
                    setNewName("");
                  }}
                  title="Cancel"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border text-muted-foreground transition hover:bg-accent hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </form>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border py-2 text-sm font-medium text-muted-foreground transition hover:border-signal/50 hover:bg-signal/5 hover:text-foreground"
              >
                <Plus className="h-4 w-4 text-signal" />
                New project
              </button>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete project?"
        description={
          <>
            <span className="font-medium text-foreground">{confirmDelete?.name}</span> and all of
            its tests, columns, environments and reports will be permanently deleted. This can't be
            undone.
          </>
        }
        confirmLabel="Delete project"
        pending={deleteMut.isPending}
        onCancel={() => !deleteMut.isPending && setConfirmDelete(null)}
        onConfirm={() => confirmDelete && deleteMut.mutate(confirmDelete.id)}
      />
    </div>
  );
}
