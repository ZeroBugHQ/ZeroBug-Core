import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type FormEvent,
  type ReactNode,
} from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  RefreshCw,
  Save,
  Server,
  SlidersHorizontal,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { StyledSelect } from "@/components/styled-select";
import { api, setAuthToken, type AppSettings, type SettingsUpdate } from "@/lib/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — ZeroBug" },
      {
        name: "description",
        content:
          "Configure ZeroBug providers, models, authentication, runner settings, and alerts.",
      },
    ],
  }),
  component: SettingsPage,
});

type FormState = SettingsUpdate & {
  authPassword: string;
  anthropicApiKey: string;
  secretsKey: string;
  smtpPass: string;
  notifyEmailsText: string;
  notifyWebhookUrlsText: string;
};

function fromSettings(settings?: AppSettings): FormState {
  return {
    modelProvider: settings?.modelProvider ?? "ollama",
    ollamaBaseUrl: settings?.ollamaBaseUrl ?? "http://127.0.0.1:11434",
    ollamaChatModel: settings?.ollamaChatModel ?? "llama3.1",
    ollamaCodeModel: settings?.ollamaCodeModel ?? "llama3.1",
    ollamaNumCtx: settings?.ollamaNumCtx ?? 8192,
    ollamaVision: settings?.ollamaVision ?? false,
    anthropicApiKey: settings?.anthropicApiKey ?? "",
    anthropicBaseUrl: settings?.anthropicBaseUrl ?? "https://api.anthropic.com",
    anthropicChatModel: settings?.anthropicChatModel ?? "claude-3-5-haiku-latest",
    anthropicCodeModel: settings?.anthropicCodeModel ?? "claude-3-5-sonnet-latest",
    anthropicVersion: settings?.anthropicVersion ?? "2023-06-01",
    authPassword: settings?.authPassword ?? "",
    agentMemoryEnabled: settings?.agentMemoryEnabled ?? true,
    runConcurrency: settings?.runConcurrency ?? 3,
    playwrightHeadless: settings?.playwrightHeadless ?? true,
    playwrightTimeoutMs: settings?.playwrightTimeoutMs ?? 30000,
    playwrightNavTimeoutMs: settings?.playwrightNavTimeoutMs ?? 60000,
    artifactsDir: settings?.artifactsDir ?? "",
    dataDir: settings?.dataDir ?? "",
    secretsKey: settings?.secretsKey ?? "",
    environmentHealthTimeoutMs: settings?.environmentHealthTimeoutMs ?? 5000,
    visualDiffThreshold: settings?.visualDiffThreshold ?? 1,
    smtpHost: settings?.smtpHost ?? "",
    smtpPort: settings?.smtpPort ?? 587,
    smtpSecure: settings?.smtpSecure ?? false,
    smtpUser: settings?.smtpUser ?? "",
    smtpPass: settings?.smtpPass ?? "",
    smtpFrom: settings?.smtpFrom ?? "",
    notifyEmails: settings?.notifyEmails ?? [],
    notifyWebhookUrls: settings?.notifyWebhookUrls ?? [],
    notifyEmailsText: (settings?.notifyEmails ?? []).join(", "),
    notifyWebhookUrlsText: (settings?.notifyWebhookUrls ?? []).join(", "),
  };
}

function listFromText(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function SettingsPage() {
  const qc = useQueryClient();
  const {
    data: settings,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
  });
  const {
    data: modelStatus,
    refetch: refetchModels,
    isFetching: modelsFetching,
  } = useQuery({
    queryKey: ["models-global"],
    queryFn: api.getModels,
    refetchInterval: 15000,
  });

  const [form, setForm] = useState<FormState>(() => fromSettings());
  const [savedMessage, setSavedMessage] = useState("");
  const [revealError, setRevealError] = useState("");
  const [secretRevealOpen, setSecretRevealOpen] = useState(false);
  const [secretRevealPassword, setSecretRevealPassword] = useState("");
  const [secretRevealPending, setSecretRevealPending] = useState(false);
  const [authChangeOpen, setAuthChangeOpen] = useState(false);
  const [authChangePassword, setAuthChangePassword] = useState("");
  const [authChangeError, setAuthChangeError] = useState("");
  const [authChangePending, setAuthChangePending] = useState(false);
  const [pendingPayload, setPendingPayload] = useState<SettingsUpdate | null>(null);
  const [secretRevealResolver, setSecretRevealResolver] = useState<
    ((allowed: boolean) => void) | null
  >(null);

  useEffect(() => {
    if (settings) setForm(fromSettings(settings));
  }, [settings]);

  const providerModels = useMemo(
    () => (modelStatus?.provider === form.modelProvider ? (modelStatus?.models ?? []) : []),
    [form.modelProvider, modelStatus],
  );
  const isAnthropic = form.modelProvider === "anthropic";
  const codeModelKey =
    form.modelProvider === "anthropic" ? "anthropicCodeModel" : "ollamaCodeModel";
  const chatModelKey =
    form.modelProvider === "anthropic" ? "anthropicChatModel" : "ollamaChatModel";

  const save = useMutation({
    mutationFn: (payload: SettingsUpdate) => api.updateSettings(payload),
    onSuccess: async (_next, payload) => {
      setSavedMessage("Settings saved.");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["settings"] }),
        qc.invalidateQueries({ queryKey: ["models-global"] }),
        qc.invalidateQueries({ queryKey: ["stats"] }),
      ]);
      const changedPassword = "authPassword" in payload;
      if (changedPassword) {
        setAuthToken("");
        window.dispatchEvent(new CustomEvent("zerobug:unauthorized"));
      }
    },
  });

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setSavedMessage("");
    setRevealError("");
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function confirmApiKeyReveal() {
    if (!form.anthropicApiKey) return true;
    if (!settings?.authEnabled) return true;
    setSecretRevealPassword("");
    setSecretRevealOpen(true);
    setRevealError("");
    return new Promise<boolean>((resolve) => {
      setSecretRevealResolver(() => resolve);
    });
  }

  async function verifySecretReveal() {
    if (!secretRevealPassword.trim()) {
      setRevealError("Enter your ZeroBug password to reveal the Anthropic API key.");
      return;
    }
    setSecretRevealPending(true);
    try {
      await api.login(secretRevealPassword);
      setRevealError("");
      setSecretRevealOpen(false);
      setSecretRevealPassword("");
      secretRevealResolver?.(true);
      setSecretRevealResolver(null);
    } catch {
      setRevealError("Incorrect password. The Anthropic API key stayed hidden.");
    } finally {
      setSecretRevealPending(false);
    }
  }

  function closeSecretReveal() {
    if (secretRevealPending) return;
    setSecretRevealOpen(false);
    setSecretRevealPassword("");
    secretRevealResolver?.(false);
    setSecretRevealResolver(null);
  }

  function buildPayload(): SettingsUpdate {
    const payload: SettingsUpdate = {
      modelProvider: form.modelProvider,
      ollamaBaseUrl: form.ollamaBaseUrl,
      ollamaChatModel: form.ollamaChatModel,
      ollamaCodeModel: form.ollamaCodeModel,
      ollamaNumCtx: Number(form.ollamaNumCtx),
      ollamaVision: Boolean(form.ollamaVision),
      anthropicBaseUrl: form.anthropicBaseUrl,
      anthropicChatModel: form.anthropicChatModel,
      anthropicCodeModel: form.anthropicCodeModel,
      anthropicVersion: form.anthropicVersion,
      agentMemoryEnabled: Boolean(form.agentMemoryEnabled),
      runConcurrency: Number(form.runConcurrency),
      playwrightHeadless: Boolean(form.playwrightHeadless),
      playwrightTimeoutMs: Number(form.playwrightTimeoutMs),
      playwrightNavTimeoutMs: Number(form.playwrightNavTimeoutMs),
      artifactsDir: form.artifactsDir,
      dataDir: form.dataDir,
      environmentHealthTimeoutMs: Number(form.environmentHealthTimeoutMs),
      visualDiffThreshold: Number(form.visualDiffThreshold),
      smtpHost: form.smtpHost,
      smtpPort: Number(form.smtpPort),
      smtpSecure: Boolean(form.smtpSecure),
      smtpUser: form.smtpUser,
      smtpFrom: form.smtpFrom,
      notifyEmails: listFromText(form.notifyEmailsText),
      notifyWebhookUrls: listFromText(form.notifyWebhookUrlsText),
    };
    if (form.authPassword !== (settings?.authPassword ?? ""))
      payload.authPassword = form.authPassword;
    if (form.anthropicApiKey !== (settings?.anthropicApiKey ?? ""))
      payload.anthropicApiKey = form.anthropicApiKey;
    if (form.secretsKey !== (settings?.secretsKey ?? "")) payload.secretsKey = form.secretsKey;
    if (form.smtpPass !== (settings?.smtpPass ?? "")) payload.smtpPass = form.smtpPass;
    return payload;
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const payload = buildPayload();
    if ("authPassword" in payload) {
      setPendingPayload(payload);
      setAuthChangePassword("");
      setAuthChangeError("");
      setAuthChangeOpen(true);
      return;
    }
    save.mutate(payload);
  }

  async function confirmAuthChange() {
    if (!pendingPayload) return;
    if (settings?.authEnabled && !authChangePassword.trim()) {
      setAuthChangeError("Enter your current ZeroBug password to change authentication.");
      return;
    }
    setAuthChangePending(true);
    try {
      if (settings?.authEnabled) await api.login(authChangePassword);
      setAuthChangeError("");
      setAuthChangeOpen(false);
      setAuthChangePassword("");
      save.mutate(pendingPayload);
      setPendingPayload(null);
    } catch {
      setAuthChangeError("Incorrect password. Authentication settings were not changed.");
    } finally {
      setAuthChangePending(false);
    }
  }

  function closeAuthChange() {
    if (save.isPending || authChangePending) return;
    setAuthChangeOpen(false);
    setAuthChangePassword("");
    setAuthChangeError("");
    setPendingPayload(null);
  }

  return (
    <AppShell title="Settings" breadcrumb="Global" hideProjectSwitcher>
      <form onSubmit={submit} className="space-y-6 p-4 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight">Settings</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Global configuration for every project. Server port, host, CORS, and MongoDB settings
              still come from the backend environment.
            </p>
          </div>
          <button
            type="submit"
            disabled={save.isPending}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {save.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save settings
          </button>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading settings...
          </div>
        )}
        {isError && (
          <Notice tone="danger" icon={AlertTriangle}>
            Could not load settings: {(error as Error)?.message}
          </Notice>
        )}
        {save.error && (
          <Notice tone="danger" icon={AlertTriangle}>
            Could not save settings: {(save.error as Error).message}
          </Notice>
        )}
        {savedMessage && (
          <Notice tone="success" icon={CheckCircle2}>
            {savedMessage}
          </Notice>
        )}
        {revealError && (
          <Notice tone="danger" icon={AlertTriangle}>
            {revealError}
          </Notice>
        )}

        <Section title="Models and providers" icon={Bot}>
          {/* Provider — where the models run. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ProviderCard
              active={!isAnthropic}
              icon={Server}
              title="Ollama"
              subtitle="Local models on your own Ollama server"
              onClick={() => update("modelProvider", "ollama")}
            />
            <ProviderCard
              active={isAnthropic}
              icon={Bot}
              title="Anthropic Claude"
              subtitle="Claude models via the Anthropic API"
              onClick={() => update("modelProvider", "anthropic")}
            />
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Field
              label="Code / browser agent model"
              hint="Drives the Playwright agent — use your most capable model here."
            >
              <ModelInput
                value={String(form[codeModelKey] ?? "")}
                models={providerModels}
                onChange={(value) =>
                  isAnthropic
                    ? update("anthropicCodeModel", value)
                    : update("ollamaCodeModel", value)
                }
              />
            </Field>
            <Field
              label="Chat / summary model"
              hint="Chat replies, failure explanations, and report summaries."
            >
              <ModelInput
                value={String(form[chatModelKey] ?? "")}
                models={providerModels}
                onChange={(value) =>
                  isAnthropic
                    ? update("anthropicChatModel", value)
                    : update("ollamaChatModel", value)
                }
              />
            </Field>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium",
                modelStatus?.reachable
                  ? "bg-success/15 text-success"
                  : "bg-destructive/15 text-destructive",
              )}
            >
              {modelStatus?.reachable ? "Healthy" : "Degraded"}
            </span>
            {modelStatus?.resolvedModel && (
              <span>
                Active model: <code>{modelStatus.resolvedModel}</code>
              </span>
            )}
            <button
              type="button"
              onClick={() => refetchModels()}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
            >
              <RefreshCw className={cn("h-3 w-3", modelsFetching && "animate-spin")} />
              Refresh models
            </button>
          </div>

          {/* Connection — only the selected provider's fields. */}
          <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {isAnthropic ? (
              <>
                <Field
                  label={`Anthropic API key${settings?.anthropicApiKeySet ? " (saved)" : ""}`}
                  hint="Stored masked. Edit to replace, or clear to remove."
                >
                  <SecretInput
                    value={form.anthropicApiKey}
                    placeholder="sk-ant-..."
                    onChange={(v) => update("anthropicApiKey", v)}
                    beforeReveal={confirmApiKeyReveal}
                    revealLabel="Reveal Anthropic API key"
                    hideLabel="Hide Anthropic API key"
                  />
                </Field>
                <Field label="Anthropic base URL">
                  <Input
                    value={form.anthropicBaseUrl}
                    onChange={(v) => update("anthropicBaseUrl", v)}
                  />
                </Field>
                <Field label="Anthropic API version">
                  <Input
                    value={form.anthropicVersion}
                    onChange={(v) => update("anthropicVersion", v)}
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label="Ollama base URL">
                  <Input value={form.ollamaBaseUrl} onChange={(v) => update("ollamaBaseUrl", v)} />
                </Field>
                <Field label="Ollama context window">
                  <NumberInput
                    value={form.ollamaNumCtx}
                    onChange={(v) => update("ollamaNumCtx", v)}
                  />
                </Field>
                <Toggle
                  label="Send screenshots to the vision model"
                  checked={Boolean(form.ollamaVision)}
                  onChange={(v) => update("ollamaVision", v)}
                />
              </>
            )}
          </div>
        </Section>

        <Section title="Access" icon={Lock}>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Field
              label={`Shared app password${settings?.authEnabled ? " (enabled)" : " (disabled)"}`}
              hint="Stored value is shown masked. Changing or clearing it logs you out."
            >
              <SecretInput
                value={form.authPassword}
                placeholder="Currently disabled"
                onChange={(v) => update("authPassword", v)}
                revealLabel="Reveal shared app password"
                hideLabel="Hide shared app password"
              />
            </Field>
            <Field
              label={`Secrets encryption key${settings?.secretsKeySet ? " (saved)" : ""}`}
              hint="Stored value is shown masked. Edit it here to replace it, or clear it to remove it."
            >
              <SecretInput
                value={form.secretsKey}
                placeholder="Recommended before storing real secrets"
                onChange={(v) => update("secretsKey", v)}
                revealLabel="Reveal secrets encryption key"
                hideLabel="Hide secrets encryption key"
              />
            </Field>
          </div>
        </Section>

        <Section title="Runner" icon={SlidersHorizontal}>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
            <Field label="Run concurrency">
              <NumberInput
                value={form.runConcurrency}
                onChange={(v) => update("runConcurrency", v)}
              />
            </Field>
            <Field label="Action timeout (ms)">
              <NumberInput
                value={form.playwrightTimeoutMs}
                onChange={(v) => update("playwrightTimeoutMs", v)}
              />
            </Field>
            <Field label="Navigation timeout (ms)">
              <NumberInput
                value={form.playwrightNavTimeoutMs}
                onChange={(v) => update("playwrightNavTimeoutMs", v)}
              />
            </Field>
            <Toggle
              label="Run Chromium headless"
              checked={Boolean(form.playwrightHeadless)}
              onChange={(v) => update("playwrightHeadless", v)}
            />
            <Toggle
              label="Agent site-memory (learn from past runs)"
              checked={Boolean(form.agentMemoryEnabled)}
              onChange={(v) => update("agentMemoryEnabled", v)}
            />
          </div>
        </Section>

        <Section title="Storage and health" icon={Server}>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Field label="Artifacts directory">
              <Input value={form.artifactsDir} onChange={(v) => update("artifactsDir", v)} />
            </Field>
            <Field label="Private data directory">
              <Input value={form.dataDir} onChange={(v) => update("dataDir", v)} />
            </Field>
            <Field label="Environment health timeout (ms)">
              <NumberInput
                value={form.environmentHealthTimeoutMs}
                onChange={(v) => update("environmentHealthTimeoutMs", v)}
              />
            </Field>
            <Field label="Visual diff pixel threshold">
              <NumberInput
                value={form.visualDiffThreshold}
                onChange={(v) => update("visualDiffThreshold", v)}
              />
            </Field>
          </div>
        </Section>

        <Section title="Notifications" icon={Mail}>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Field label="SMTP host">
              <Input value={form.smtpHost} onChange={(v) => update("smtpHost", v)} />
            </Field>
            <Field label="SMTP port">
              <NumberInput value={form.smtpPort} onChange={(v) => update("smtpPort", v)} />
            </Field>
            <Toggle
              label="SMTP secure"
              checked={Boolean(form.smtpSecure)}
              onChange={(v) => update("smtpSecure", v)}
            />
            <Field label="SMTP user">
              <Input value={form.smtpUser} onChange={(v) => update("smtpUser", v)} />
            </Field>
            <Field
              label={`SMTP password${settings?.smtpPassSet ? " (saved)" : ""}`}
              hint="Stored value is shown masked. Edit it here to replace it, or clear it to remove it."
            >
              <SecretInput
                value={form.smtpPass}
                placeholder=""
                onChange={(v) => update("smtpPass", v)}
                revealLabel="Reveal SMTP password"
                hideLabel="Hide SMTP password"
              />
            </Field>
            <Field label="SMTP from">
              <Input value={form.smtpFrom} onChange={(v) => update("smtpFrom", v)} />
            </Field>
            <Field label="Notify emails" hint="Comma-separated">
              <Input
                value={form.notifyEmailsText}
                onChange={(v) => update("notifyEmailsText", v)}
              />
            </Field>
            <Field label="Webhook URLs" hint="Comma-separated">
              <Input
                value={form.notifyWebhookUrlsText}
                onChange={(v) => update("notifyWebhookUrlsText", v)}
              />
            </Field>
          </div>
        </Section>
      </form>
      <PasswordPromptDialog
        open={secretRevealOpen}
        title="Reveal Anthropic API key"
        description="Enter your ZeroBug password before showing the saved Anthropic API key."
        password={secretRevealPassword}
        error={revealError}
        pending={secretRevealPending}
        confirmLabel="Reveal key"
        onPasswordChange={(value) => {
          setSecretRevealPassword(value);
          setRevealError("");
        }}
        onConfirm={verifySecretReveal}
        onCancel={closeSecretReveal}
      />
      <PasswordPromptDialog
        open={authChangeOpen}
        title="Update authentication"
        description={
          settings?.authEnabled
            ? "Confirm your current ZeroBug password before changing the shared app password. You will be logged out after saving."
            : "You are enabling app authentication. You will be logged out after saving and must sign in with the new password."
        }
        password={authChangePassword}
        error={authChangeError}
        pending={save.isPending || authChangePending}
        confirmLabel="Save and log out"
        requirePassword={Boolean(settings?.authEnabled)}
        onPasswordChange={(value) => {
          setAuthChangePassword(value);
          setAuthChangeError("");
        }}
        onConfirm={confirmAuthChange}
        onCancel={closeAuthChange}
      />
    </AppShell>
  );
}

function PasswordPromptDialog({
  open,
  title,
  description,
  password,
  error,
  pending,
  confirmLabel,
  requirePassword = true,
  onPasswordChange,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  password: string;
  error?: string;
  pending?: boolean;
  confirmLabel: string;
  requirePassword?: boolean;
  onPasswordChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!open) {
      setVisible(false);
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onCancel();
      if (event.key === "Enter" && !pending) onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, pending, onCancel, onConfirm]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 animate-fade-in">
      <button
        type="button"
        aria-label="Close dialog"
        className="absolute inset-0 bg-background/75 backdrop-blur-sm"
        onClick={() => !pending && onCancel()}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-2xl animate-scale-in"
      >
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <KeyRound className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="font-display text-lg font-semibold">{title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          </div>
        </div>

        {requirePassword && (
          <div className="mt-5">
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Current password
              </span>
              <div className="relative">
                <input
                  autoFocus
                  type={visible ? "text" : "password"}
                  value={password}
                  onChange={(event) => onPasswordChange(event.target.value)}
                  className="input pr-10"
                  placeholder="Enter your ZeroBug password"
                />
                <button
                  type="button"
                  onClick={() => setVisible((value) => !value)}
                  aria-label={visible ? "Hide password" : "Show password"}
                  title={visible ? "Hide password" : "Show password"}
                  className="absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
                >
                  {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>
          </div>
        )}

        {error && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProviderCard({
  active,
  icon: Icon,
  title,
  subtitle,
  onClick,
}: {
  active: boolean;
  icon: ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-start gap-3 rounded-xl border p-3 text-left transition",
        active
          ? "border-primary bg-primary/10"
          : "border-border bg-background/40 hover:border-primary/40 hover:bg-accent/20",
      )}
    >
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
          active ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground",
        )}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          {title}
          {active && <CheckCircle2 className="h-3.5 w-3.5 text-primary" />}
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</div>
      </div>
    </button>
  );
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: ComponentType<{ className?: string }>;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
        <Icon className="h-4 w-4 text-primary" />
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );
}

function Input({
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  value?: string | number | boolean;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <input
      type={type}
      value={String(value ?? "")}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="input"
    />
  );
}

function SecretInput({
  value,
  onChange,
  placeholder,
  beforeReveal,
  revealLabel = "Reveal value",
  hideLabel = "Hide value",
}: {
  value?: string | number | boolean;
  onChange: (value: string) => void;
  placeholder?: string;
  beforeReveal?: () => Promise<boolean> | boolean;
  revealLabel?: string;
  hideLabel?: string;
}) {
  const [visible, setVisible] = useState(false);

  async function toggle() {
    if (visible) {
      setVisible(false);
      return;
    }
    if (beforeReveal) {
      const ok = await beforeReveal();
      if (!ok) return;
    }
    setVisible(true);
  }

  return (
    <div className="relative">
      <input
        type={visible ? "text" : "password"}
        value={String(value ?? "")}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="input pr-10"
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={visible ? hideLabel : revealLabel}
        title={visible ? hideLabel : revealLabel}
        className="absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

function NumberInput({
  value,
  onChange,
}: {
  value?: string | number | boolean;
  onChange: (value: number) => void;
}) {
  return (
    <input
      type="number"
      value={Number(value ?? 0)}
      onChange={(e) => onChange(Number(e.target.value))}
      className="input"
    />
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-[58px] items-center justify-between gap-3 rounded-lg border border-border bg-background/40 px-3 py-2">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-[var(--primary)]"
      />
    </label>
  );
}

function ModelInput({
  value,
  models,
  onChange,
}: {
  value: string;
  models: Array<{ name: string }>;
  onChange: (value: string) => void;
}) {
  const options = models.map((model) => ({ value: model.name, label: model.name }));

  return (
    <div className="grid gap-2">
      {options.length > 0 ? (
        <StyledSelect
          value={value}
          onChange={onChange}
          options={options}
          placeholder="Select model..."
          className="h-10 rounded-lg bg-background/70 px-3 font-mono text-xs"
        />
      ) : null}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={options.length ? "Or type a custom model name" : "Model name"}
        className="input h-8 bg-background/50 font-mono text-xs"
      />
    </div>
  );
}

function Notice({
  tone,
  icon: Icon,
  children,
}: {
  tone: "success" | "danger";
  icon: ComponentType<{ className?: string }>;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
        tone === "success"
          ? "border-success/40 bg-success/5 text-success"
          : "border-destructive/40 bg-destructive/5 text-destructive",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {children}
    </div>
  );
}
