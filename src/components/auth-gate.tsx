import { useEffect, useState, type ReactNode } from "react";
import { api, getAuthToken, setAuthToken } from "../lib/api";
import { BrandMark, BrandWordmark } from "./brand-mark";

type Phase = "checking" | "open" | "locked";

/**
 * Optional shared-password gate. The backend reports whether auth is required
 * (only when ZEROBUG_AUTH_PASSWORD is set); otherwise this renders children
 * straight through so an open install is unaffected.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getAuthStatus()
      .then((s) => {
        if (cancelled) return;
        if (!s.required) setPhase("open");
        else setPhase(getAuthToken() ? "open" : "locked");
      })
      .catch(() => {
        // Backend unreachable — don't block the app behind a gate we can't verify.
        if (!cancelled) setPhase("open");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // If a request 401s later, the api layer clears the token and fires this.
  useEffect(() => {
    const onUnauth = () => {
      setError("Your session expired. Please sign in again.");
      setPhase("locked");
    };
    window.addEventListener("zerobug:unauthorized", onUnauth);
    return () => window.removeEventListener("zerobug:unauthorized", onUnauth);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const { token } = await api.login(password);
      setAuthToken(token);
      setPassword("");
      setPhase("open");
    } catch {
      setError("Incorrect password.");
    } finally {
      setBusy(false);
    }
  }

  if (phase === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-signal border-t-transparent" />
      </div>
    );
  }

  if (phase === "locked") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <form
          onSubmit={submit}
          className="w-full max-w-sm rounded-lg border border-border bg-card p-6"
        >
          <div className="mb-5 flex flex-col items-center text-center">
            <BrandMark className="mb-3 h-12 w-12" />
            <h1 className="text-lg font-semibold text-foreground">
              Sign in to <BrandWordmark />
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              This workspace is password-protected.
            </p>
          </div>
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring/40"
          />
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
          <button
            type="submit"
            disabled={busy || !password.trim()}
            className="mt-4 inline-flex w-full items-center justify-center rounded-md bg-signal px-4 py-2 text-sm font-semibold text-signal-foreground transition-colors hover:brightness-105 disabled:opacity-50"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    );
  }

  return <>{children}</>;
}
