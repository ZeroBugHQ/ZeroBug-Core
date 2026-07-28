import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Circle,
  ImagePlus,
  Monitor,
  Smartphone,
  Square,
  Tablet,
  Triangle,
  X,
} from "lucide-react";
import type { TestCase } from "@/lib/mock-tests";
import type { ApiTestConfig, Category, NewTestInput } from "@/lib/api";
import { StyledSelect } from "@/components/styled-select";
import { cn } from "@/lib/utils";

type Priority = TestCase["priority"];
type TestMode = TestCase["mode"];
type Viewport = NonNullable<TestCase["viewport"]>;
type AssertionType = TestCase["assertionTypes"][number];

type Engine = NonNullable<TestCase["engine"]>;
// Neutral, non-brand shapes — easy to tell apart at a glance without borrowing
// any browser's logo/identity (this feature isn't affiliated with those brands).
const ENGINES: Array<{ key: Engine; label: string; icon: typeof Monitor }> = [
  { key: "chromium", label: "Chromium", icon: Circle },
  { key: "firefox", label: "Firefox", icon: Square },
  { key: "webkit", label: "WebKit", icon: Triangle },
];

const VIEWPORTS: Array<{ key: Viewport; label: string; icon: typeof Monitor }> = [
  { key: "desktop", label: "Desktop", icon: Monitor },
  { key: "tablet", label: "Tablet", icon: Tablet },
  { key: "mobile", label: "Mobile", icon: Smartphone },
];

const MAX_IMAGES = 5;
const MAX_SIZE_MB = 4;
const ASSERTIONS: Array<{ key: AssertionType; label: string }> = [
  { key: "functional", label: "Functional" },
  { key: "visual", label: "Visual diff" },
  { key: "a11y", label: "A11y audit" },
];

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Parse a small CSV (header row + data rows) into row objects. Header names are
// normalised to identifier-safe keys so they work as {{col}} placeholders.
function parseCsvRows(text: string): Record<string, string>[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0]
    .split(",")
    .map((h) => h.trim().replace(/\s+/g, "_"))
    .filter(Boolean);
  if (!headers.length) return [];
  return lines.slice(1).map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? "";
    });
    return row;
  });
}

// Turn stored rows back into editable CSV text.
function rowsToCsv(rows?: Record<string, string>[]): string {
  if (!rows || rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const head = headers.join(",");
  const body = rows.map((r) => headers.map((h) => r[h] ?? "").join(",")).join("\n");
  return `${head}\n${body}`;
}

function headersToText(headers?: Record<string, string>) {
  return Object.entries(headers || {})
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

function textToHeaders(value: string) {
  return Object.fromEntries(
    value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf(":");
        if (idx < 0) return [line, ""];
        return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
      })
      .filter(([key]) => key),
  );
}

export function AddTestModal({
  open,
  initial,
  categories = [],
  onClose,
  onSubmit,
}: {
  open: boolean;
  initial?: TestCase | null;
  categories?: Category[];
  onClose: () => void;
  onSubmit: (t: NewTestInput) => void;
}) {
  const isEditing = !!initial;
  const [title, setTitle] = useState("");
  const [suite, setSuite] = useState("General");
  const [tags, setTags] = useState("");
  const [dependsOn, setDependsOn] = useState("");
  const [dataRowsText, setDataRowsText] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [sizeError, setSizeError] = useState("");
  const [maxRetries, setMaxRetries] = useState(0);
  const [budgetSec, setBudgetSec] = useState("");
  const [mode, setMode] = useState<TestMode>("ui");
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [engine, setEngine] = useState<Engine>("chromium");
  const [categoryId, setCategoryId] = useState<string>("");
  const [assertionTypes, setAssertionTypes] = useState<AssertionType[]>(["functional"]);
  const [apiMethod, setApiMethod] = useState("GET");
  const [apiUrl, setApiUrl] = useState("");
  const [apiHeaders, setApiHeaders] = useState("");
  const [apiBody, setApiBody] = useState("");
  const [expectedStatus, setExpectedStatus] = useState("200");
  const [expectedBodyContains, setExpectedBodyContains] = useState("");
  const [expectedJsonPath, setExpectedJsonPath] = useState("");
  const [expectedJsonValue, setExpectedJsonValue] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(initial?.title ?? "");
    setSuite(initial?.suite ?? "General");
    setTags(initial?.tags?.join(", ") ?? "");
    setDependsOn(initial?.dependsOn?.join(", ") ?? "");
    setDataRowsText(rowsToCsv(initial?.dataRows));
    setPriority(initial?.priority ?? "medium");
    setDescription(
      initial && initial.description !== "No description provided." ? initial.description : "",
    );
    setSteps(initial?.steps?.join("\n") ?? "");
    setAttachments(initial?.attachments ?? []);
    setSizeError("");
    setMaxRetries(initial?.maxRetries ?? 0);
    setBudgetSec(initial?.budgetMs ? String(initial.budgetMs / 1000) : "");
    setMode(initial?.mode ?? "ui");
    setViewport(initial?.viewport ?? "desktop");
    setEngine(initial?.engine ?? "chromium");
    setCategoryId(initial?.categoryId ?? "");
    setAssertionTypes(initial?.assertionTypes?.length ? initial.assertionTypes : ["functional"]);
    setApiMethod(initial?.apiConfig?.method ?? "GET");
    setApiUrl(initial?.apiConfig?.url ?? "");
    setApiHeaders(headersToText(initial?.apiConfig?.headers));
    setApiBody(initial?.apiConfig?.body ?? "");
    setExpectedStatus(String(initial?.apiConfig?.expectedStatus ?? 200));
    setExpectedBodyContains(initial?.apiConfig?.expectedBodyContains ?? "");
    setExpectedJsonPath(initial?.apiConfig?.expectedJsonPath ?? "");
    setExpectedJsonValue(initial?.apiConfig?.expectedJsonValue ?? "");
    // Auto-open Advanced when editing a test that already uses advanced fields,
    // so nothing is hidden from the user.
    setShowAdvanced(
      !!(
        initial &&
        ((initial.tags && initial.tags.length) ||
          (initial.dependsOn && initial.dependsOn.length) ||
          (initial.dataRows && initial.dataRows.length) ||
          (initial.budgetMs && initial.budgetMs > 0) ||
          (initial.maxRetries && initial.maxRetries > 0) ||
          (initial.viewport && initial.viewport !== "desktop") ||
          (initial.engine && initial.engine !== "chromium") ||
          (initial.assertionTypes && initial.assertionTypes.some((a) => a !== "functional")) ||
          (initial.attachments && initial.attachments.length) ||
          (initial.apiConfig?.headers && Object.keys(initial.apiConfig.headers).length) ||
          initial.apiConfig?.body ||
          initial.apiConfig?.expectedJsonPath ||
          (initial.suite && initial.suite !== "General"))
      ),
    );
  }, [open, initial]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function addFiles(files: FileList | File[]) {
    setSizeError("");
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
    const remaining = MAX_IMAGES - attachments.length;
    if (remaining <= 0) return;
    const toAdd = arr.slice(0, remaining);
    const oversized = toAdd.filter((f) => f.size > MAX_SIZE_MB * 1024 * 1024);
    if (oversized.length) {
      setSizeError(
        `${oversized.map((f) => f.name).join(", ")} exceed${oversized.length === 1 ? "s" : ""} the ${MAX_SIZE_MB} MB limit and were skipped.`,
      );
    }
    const valid = toAdd.filter((f) => f.size <= MAX_SIZE_MB * 1024 * 1024);
    const dataUrls = await Promise.all(valid.map(readAsDataUrl));
    setAttachments((prev) => [...prev, ...dataUrls].slice(0, MAX_IMAGES));
  }

  function removeAttachment(idx: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }

  function toggleAssertion(key: AssertionType) {
    setAssertionTypes((prev) => {
      if (key === "functional") return prev;
      return prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key];
    });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !description.trim()) return;
    const stepList = steps
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    const apiConfig: ApiTestConfig | undefined =
      mode === "api"
        ? {
            method: apiMethod,
            url: apiUrl.trim(),
            headers: textToHeaders(apiHeaders),
            body: apiBody,
            expectedStatus: Number(expectedStatus || 200),
            expectedBodyContains: expectedBodyContains.trim(),
            expectedJsonPath: expectedJsonPath.trim(),
            expectedJsonValue: expectedJsonValue.trim(),
          }
        : undefined;

    onSubmit({
      title: title.trim(),
      description: description.trim() || "No description provided.",
      suite,
      tags: tags
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
      dependsOn: dependsOn
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean),
      dataRows: mode === "ui" ? parseCsvRows(dataRowsText) : [],
      budgetMs: Math.max(0, Math.round((Number(budgetSec) || 0) * 1000)),
      priority,
      steps: mode === "ui" && stepList.length ? stepList : undefined,
      attachments: mode === "ui" && attachments.length ? attachments : undefined,
      maxRetries,
      mode,
      categoryId: categoryId || null,
      viewport: mode === "ui" ? viewport : undefined,
      engine: mode === "ui" ? engine : undefined,
      assertionTypes:
        mode === "api"
          ? ["functional"]
          : ["functional", ...assertionTypes.filter((a) => a !== "functional")],
      apiConfig,
    });
    onClose();
  }

  const priorities: Priority[] = ["low", "medium", "high", "critical"];
  const canAddMore = attachments.length < MAX_IMAGES;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      <div className="absolute inset-0 bg-background/70 backdrop-blur-sm" onClick={onClose} />
      <form
        onSubmit={submit}
        className="relative max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-2xl animate-scale-in scrollbar-thin"
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-display text-lg font-semibold">
              {isEditing ? "Edit test case" : "New test case"}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Fill the essentials. Open “Advanced options” only if you need tags, retries, viewport,
              data-driven rows, and more.
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
          {/* ── Essentials ─────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Title" required>
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="User can reset their password via email"
                className="input"
              />
            </Field>
            <Field label="Type">
              <div className="grid grid-cols-2 gap-2">
                {(["ui", "api"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setMode(item)}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-sm font-medium transition",
                      mode === item
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {item === "ui" ? "UI" : "API"}
                  </button>
                ))}
              </div>
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Priority">
              <div className="flex gap-1.5">
                {priorities.map((p) => (
                  <button
                    type="button"
                    key={p}
                    onClick={() => setPriority(p)}
                    className={cn(
                      "flex-1 rounded-md border px-2 py-1.5 text-[11px] font-medium capitalize transition",
                      priority === p
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Category">
              <StyledSelect
                value={categoryId || "__none__"}
                onChange={(v) => setCategoryId(v === "__none__" ? "" : v)}
                options={[
                  { value: "__none__", label: "Uncategorized" },
                  ...categories.map((c) => ({ value: c.id, label: c.name })),
                ]}
              />
            </Field>
          </div>

          <Field label="Description" required>
            <textarea
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={
                mode === "api"
                  ? "What should the API response prove?"
                  : "What should the agent verify?"
              }
              className="input min-h-24 resize-y py-2 leading-relaxed"
            />
          </Field>

          {mode === "ui" ? (
            <Field label="Steps (one per line)">
              <textarea
                rows={7}
                value={steps}
                onChange={(e) => setSteps(e.target.value)}
                placeholder={
                  "Open /forgot-password\nFill email\nClick Send\nAssert toast 'Check your inbox'"
                }
                className="input min-h-40 resize-y py-2 font-mono text-xs leading-relaxed"
              />
            </Field>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="Method">
                <StyledSelect
                  value={apiMethod}
                  onChange={setApiMethod}
                  options={["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({
                    value: m,
                    label: m,
                  }))}
                />
              </Field>
              <Field label="URL or path" required>
                <input
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                  placeholder="/api/health or https://example.com/api"
                  className="input font-mono text-xs"
                />
              </Field>
              <Field label="Expected status">
                <input
                  type="number"
                  value={expectedStatus}
                  onChange={(e) => setExpectedStatus(e.target.value)}
                  className="input no-spinner"
                />
              </Field>
              <Field label="Expected body contains">
                <input
                  value={expectedBodyContains}
                  onChange={(e) => setExpectedBodyContains(e.target.value)}
                  placeholder="healthy"
                  className="input"
                />
              </Field>
            </div>
          )}

          {/* ── Advanced (collapsed) ───────────────────────────────────── */}
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
            >
              <ChevronDown
                className={cn("h-3.5 w-3.5 transition-transform", showAdvanced && "rotate-180")}
              />
              {showAdvanced ? "Hide advanced options" : "Advanced options"}
            </button>

            {showAdvanced && (
              <div className="mt-3 space-y-4 rounded-lg border border-border/60 bg-background/30 p-3">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <Field label="Tags">
                    <input
                      value={tags}
                      onChange={(e) => setTags(e.target.value)}
                      placeholder="comma-separated, e.g. smoke, critical, auth"
                      className="input"
                    />
                  </Field>
                  <Field label="Depends on (test codes)">
                    <input
                      value={dependsOn}
                      onChange={(e) => setDependsOn(e.target.value)}
                      placeholder="runs after these pass, e.g. AUTH-01, AUTH-02"
                      className="input font-mono"
                    />
                  </Field>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <Field label="Suite">
                    <input
                      value={suite}
                      onChange={(e) => setSuite(e.target.value)}
                      className="input"
                    />
                  </Field>
                  <Field label="Retries">
                    <input
                      type="number"
                      min={0}
                      max={5}
                      value={maxRetries}
                      onChange={(e) =>
                        setMaxRetries(Math.max(0, Math.min(5, Number(e.target.value) || 0)))
                      }
                      className="input no-spinner"
                    />
                  </Field>
                  <Field label="Budget (s)">
                    <input
                      type="number"
                      min={0}
                      value={budgetSec}
                      onChange={(e) => setBudgetSec(e.target.value)}
                      placeholder="0 = none"
                      className="input no-spinner"
                    />
                  </Field>
                </div>

                {mode === "ui" && (
                  <>
                    <Field label="Viewport">
                      <div className="flex gap-1.5">
                        {VIEWPORTS.map((v) => (
                          <button
                            key={v.key}
                            type="button"
                            onClick={() => setViewport(v.key)}
                            className={cn(
                              "flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] font-medium transition",
                              viewport === v.key
                                ? "border-primary bg-primary/10 text-primary"
                                : "border-border text-muted-foreground hover:text-foreground",
                            )}
                          >
                            <v.icon className="h-3.5 w-3.5" />
                            {v.label}
                          </button>
                        ))}
                      </div>
                    </Field>

                    <Field label="Browser">
                      <div className="flex gap-1.5">
                        {ENGINES.map((e) => (
                          <button
                            key={e.key}
                            type="button"
                            onClick={() => setEngine(e.key)}
                            className={cn(
                              "flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] font-medium transition",
                              engine === e.key
                                ? "border-primary bg-primary/10 text-primary"
                                : "border-border text-muted-foreground hover:text-foreground",
                            )}
                          >
                            <e.icon className="h-3.5 w-3.5" />
                            {e.label}
                          </button>
                        ))}
                      </div>
                      {engine === "firefox" && (viewport === "mobile" || viewport === "tablet") && (
                        <p className="mt-1.5 text-[10.5px] leading-snug text-muted-foreground">
                          Firefox can’t emulate touch — a {viewport} viewport uses the mobile size
                          only, not touch input.
                        </p>
                      )}
                    </Field>

                    <Field label="Assertions">
                      <div className="flex flex-wrap gap-1.5">
                        {ASSERTIONS.map((item) => {
                          const checked =
                            item.key === "functional" ? true : assertionTypes.includes(item.key);
                          const disabled = item.key === "functional";
                          return (
                            <button
                              key={item.key}
                              type="button"
                              disabled={disabled}
                              onClick={() => toggleAssertion(item.key)}
                              className={cn(
                                "rounded-md border px-3 py-1.5 text-[11px] font-medium transition",
                                checked
                                  ? "border-primary bg-primary/10 text-primary"
                                  : "border-border text-muted-foreground hover:text-foreground",
                                disabled && "cursor-not-allowed opacity-60",
                              )}
                            >
                              {item.label}
                            </button>
                          );
                        })}
                      </div>
                    </Field>

                    <Field label="Data rows — run the test once per row (optional)">
                      <textarea
                        rows={3}
                        value={dataRowsText}
                        onChange={(e) => setDataRowsText(e.target.value)}
                        placeholder={"email, plan\nalice@x.com, pro\nbob@x.com, free"}
                        className="input min-h-20 resize-y py-2 font-mono text-xs leading-relaxed"
                      />
                      <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                        First line = column names, then one row of values per line
                        (comma-separated). Use a value in your steps with{" "}
                        <code className="rounded bg-muted px-1">{"{{column}}"}</code> (e.g.{" "}
                        <code className="rounded bg-muted px-1">Type {"{{email}}"}</code>). Leave
                        empty for a single normal run.
                      </span>
                    </Field>

                    <div>
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground">
                          Reference images
                          <span className="ml-1 font-normal opacity-60">
                            (optional · {attachments.length}/{MAX_IMAGES})
                          </span>
                        </span>
                        {canAddMore && (
                          <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
                          >
                            <ImagePlus className="h-3.5 w-3.5" />
                            Add image
                          </button>
                        )}
                      </div>

                      {attachments.length === 0 && (
                        <div
                          onDragOver={(e) => {
                            e.preventDefault();
                            setDragOver(true);
                          }}
                          onDragLeave={() => setDragOver(false)}
                          onDrop={(e) => {
                            e.preventDefault();
                            setDragOver(false);
                            addFiles(e.dataTransfer.files);
                          }}
                          onClick={() => fileInputRef.current?.click()}
                          className={cn(
                            "flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed py-5 text-xs text-muted-foreground transition select-none",
                            dragOver
                              ? "border-primary/60 bg-primary/5 text-foreground"
                              : "border-muted-foreground/25 hover:border-primary/40 hover:text-foreground",
                          )}
                        >
                          <ImagePlus className="h-5 w-5 opacity-50" />
                          <span>Drop images here or click to browse</span>
                          <span className="opacity-50">
                            PNG, JPG, WebP · up to {MAX_SIZE_MB} MB each
                          </span>
                        </div>
                      )}

                      {attachments.length > 0 && (
                        <div
                          onDragOver={(e) => {
                            e.preventDefault();
                            setDragOver(true);
                          }}
                          onDragLeave={() => setDragOver(false)}
                          onDrop={(e) => {
                            e.preventDefault();
                            setDragOver(false);
                            addFiles(e.dataTransfer.files);
                          }}
                          className={cn(
                            "flex flex-wrap gap-2 rounded-xl border border-dashed p-2 transition",
                            dragOver
                              ? "border-primary/60 bg-primary/5"
                              : "border-muted-foreground/25",
                          )}
                        >
                          {attachments.map((src, i) => (
                            <div
                              key={i}
                              className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-border"
                            >
                              <img
                                src={src}
                                alt={`Attachment ${i + 1}`}
                                className="h-full w-full object-cover"
                              />
                              <button
                                type="button"
                                onClick={() => removeAttachment(i)}
                                className="absolute inset-0 flex items-center justify-center bg-background/70 opacity-0 transition group-hover:opacity-100"
                              >
                                <X className="h-4 w-4 text-destructive" />
                              </button>
                            </div>
                          ))}
                          {canAddMore && (
                            <button
                              type="button"
                              onClick={() => fileInputRef.current?.click()}
                              className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-dashed border-muted-foreground/25 text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
                            >
                              <ImagePlus className="h-5 w-5" />
                            </button>
                          )}
                        </div>
                      )}

                      {sizeError && (
                        <p className="mt-1.5 text-[11px] text-destructive">{sizeError}</p>
                      )}
                    </div>
                  </>
                )}

                {mode === "api" && (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <Field label="Headers (key: value)">
                      <textarea
                        rows={4}
                        value={apiHeaders}
                        onChange={(e) => setApiHeaders(e.target.value)}
                        placeholder={"Authorization: Bearer token\nAccept: application/json"}
                        className="input min-h-24 resize-y py-2 font-mono text-xs leading-relaxed"
                      />
                    </Field>
                    <Field label="Body (optional)">
                      <textarea
                        rows={4}
                        value={apiBody}
                        onChange={(e) => setApiBody(e.target.value)}
                        placeholder='{"name":"ZeroBug"}'
                        className="input min-h-24 resize-y py-2 font-mono text-xs leading-relaxed"
                      />
                    </Field>
                    <Field label="Expected JSON path">
                      <input
                        value={expectedJsonPath}
                        onChange={(e) => setExpectedJsonPath(e.target.value)}
                        placeholder="data.status"
                        className="input font-mono text-xs"
                      />
                    </Field>
                    <Field label="Expected JSON value">
                      <input
                        value={expectedJsonValue}
                        onChange={(e) => setExpectedJsonValue(e.target.value)}
                        placeholder='"ok"'
                        className="input font-mono text-xs"
                      />
                    </Field>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!title.trim() || !description.trim() || (mode === "api" && !apiUrl.trim())}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
          >
            {isEditing ? "Save changes" : "Add to queue"}
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />

        <style>{`
          .input {
            width: 100%;
            border-radius: 0.5rem;
            border: 1px solid var(--color-border);
            background: var(--color-background);
            padding: 0.5rem 0.75rem;
            font-size: 0.875rem;
            color: var(--color-foreground);
            outline: none;
            transition: border-color 0.15s, box-shadow 0.15s;
          }
          .input::placeholder { color: var(--color-muted-foreground); }
          .input:focus {
            border-color: color-mix(in oklab, var(--color-primary) 60%, transparent);
            box-shadow: 0 0 0 3px color-mix(in oklab, var(--color-primary) 20%, transparent);
          }
          .no-spinner::-webkit-outer-spin-button,
          .no-spinner::-webkit-inner-spin-button {
            -webkit-appearance: none;
            margin: 0;
          }
          .no-spinner {
            appearance: textfield;
            -moz-appearance: textfield;
          }
        `}</style>
      </form>
    </div>
  );
}

function Field({
  label,
  className,
  required,
  children,
}: {
  label: string;
  className?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("block min-w-0 overflow-hidden", className)}>
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
        {label}
        {required && (
          <span className="text-destructive" title="Required">
            {" "}
            *
          </span>
        )}
      </span>
      {children}
    </label>
  );
}
