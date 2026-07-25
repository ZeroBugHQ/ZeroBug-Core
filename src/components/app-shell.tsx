import { useState, type ReactNode } from "react";
import { useNavigate, useLocation } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { AppSidebar, MobileSidebar } from "./app-sidebar";
import { ThemeToggle } from "./theme-toggle";
import { ProjectSwitcher } from "./project-switcher";
import { ChevronRight, Menu, Search } from "lucide-react";
import { SPRING_CARD, useReduced } from "@/lib/motion";

// ── Spotlight (⌘K) ──────────────────────────────────────────────────────────
// Navigates to the Runs board and opens the full spotlight there.
function GlobalSearchButton() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <button
      onClick={() => {
        if (location.pathname !== "/") {
          // Navigate to runs page first; the TestRunnerApp's ⌘K listener
          // opens the spotlight on mount, so we redirect and let it handle it.
          navigate({ to: "/" });
        } else {
          // Already on the runs page — open the spotlight directly.
          window.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "k",
              metaKey: true,
              ctrlKey: true,
              bubbles: true,
            }),
          );
        }
      }}
      title="Search tests (Ctrl/⌘ + K)"
      className="inline-flex h-8 w-full max-w-80 items-center justify-between gap-2 rounded-md border border-border bg-background px-3.5 text-sm text-muted-foreground transition hover:border-primary/50 hover:text-foreground sm:w-80"
    >
      <span className="flex items-center gap-2">
        <Search className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Search tests…</span>
      </span>
      <kbd className="hidden rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] sm:inline">
        ⌘K
      </kbd>
    </button>
  );
}

export function AppShell({
  title,
  breadcrumb,
  hideProjectSwitcher,
  actions,
  children,
}: {
  title: string;
  breadcrumb?: string;
  hideProjectSwitcher?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const reduced = useReduced();

  return (
    <div className="flex h-screen w-screen overflow-hidden text-foreground">
      <AppSidebar collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
      <MobileSidebar open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 sm:gap-3 md:px-6">
          <button
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open menu"
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground md:hidden"
          >
            <Menu className="h-5 w-5" />
          </button>
          {!hideProjectSwitcher && (
            <>
              <ProjectSwitcher />
              <div className="hidden items-center gap-2 text-sm text-muted-foreground lg:flex">
                <ChevronRight className="h-3.5 w-3.5" />
                <span className="font-medium text-foreground">{title}</span>
                {breadcrumb && (
                  <>
                    <ChevronRight className="h-3.5 w-3.5" />
                    <span>{breadcrumb}</span>
                  </>
                )}
              </div>
            </>
          )}
          <div className="flex flex-1 items-center justify-center">
            <GlobalSearchButton />
          </div>
          <div className="flex items-center gap-2">
            {actions}
            <ThemeToggle />
          </div>
        </header>
        <motion.div
          className="min-h-0 flex-1 overflow-auto"
          initial={reduced ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reduced ? { duration: 0 } : SPRING_CARD}
        >
          {children}
        </motion.div>
      </main>
    </div>
  );
}
