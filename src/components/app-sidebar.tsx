import { Link, useRouterState } from "@tanstack/react-router";
import { motion } from "framer-motion";
import {
  Activity,
  BarChart3,
  Brain,
  CalendarClock,
  Hash,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SPRING_LAYOUT, useReduced } from "@/lib/motion";
import { BrandMark, BrandWordmark } from "./brand-mark";

const NAV = [
  { to: "/", icon: Activity, label: "Runs" },
  { to: "/generated-specs", icon: Sparkles, label: "Test report" },
  { to: "/stats", icon: BarChart3, label: "Statistics" },
  { to: "/memory", icon: Brain, label: "Agent memory" },
  { to: "/automation", icon: CalendarClock, label: "Automation" },
  { to: "/environments", icon: Hash, label: "Environments" },
  { to: "/settings", icon: Settings, label: "Settings" },
] as const;

function NavLinks({
  collapsed,
  onNavigate,
  scope = "desktop",
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
  scope?: string;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const reduced = useReduced();
  return (
    <nav className="flex flex-col gap-1 text-sm">
      {NAV.map((item) => {
        const active = pathname === item.to;
        return (
          <Link
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            title={collapsed ? item.label : undefined}
            className={cn(
              "relative flex items-center gap-2.5 rounded-md px-2.5 py-2 transition-colors",
              active
                ? "text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              collapsed && "justify-center px-2",
            )}
          >
            {/* Active-item pill slides between items via a shared layoutId. */}
            {active && (
              <motion.span
                layoutId={reduced ? undefined : `nav-active-${scope}`}
                transition={SPRING_LAYOUT}
                className="absolute inset-0 -z-10 rounded-md border border-signal/30 bg-accent"
              />
            )}
            <item.icon className="relative h-4 w-4 shrink-0" />
            {!collapsed && <span className="relative truncate">{item.label}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

function AgentReadyCard() {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-3 text-xs text-muted-foreground">
      <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
        <Zap className="h-3.5 w-3.5 text-primary" />
        Agent ready
      </div>
      Playwright runner connected · Chromium 131
    </div>
  );
}

// Desktop sidebar (hidden below md; the mobile drawer takes over there).
export function AppSidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <aside
      className={cn(
        "relative hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar/50 p-3 backdrop-blur-xl transition-[width] duration-200 md:flex",
        collapsed ? "w-[68px]" : "w-60",
      )}
    >
      <div className={cn("flex items-center gap-2 px-1", collapsed && "flex-col")}>
        <BrandMark className="h-8 w-8" />
        {!collapsed && <BrandWordmark className="text-lg" />}
        <button
          onClick={onToggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "rounded-md p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground",
            !collapsed && "ml-auto",
          )}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </button>
      </div>

      <div className="mt-6">
        <NavLinks collapsed={collapsed} scope="desktop" />
      </div>

      {!collapsed && (
        <div className="mt-auto">
          <AgentReadyCard />
        </div>
      )}
    </aside>
  );
}

// Mobile slide-in drawer (shown below md via a hamburger in the header).
export function MobileSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <div
      className={cn(
        "fixed inset-0 z-50 md:hidden",
        open ? "pointer-events-auto" : "pointer-events-none",
      )}
      aria-hidden={!open}
    >
      <div
        onClick={onClose}
        className={cn(
          "absolute inset-0 bg-background/70 backdrop-blur-sm transition-opacity",
          open ? "opacity-100" : "opacity-0",
        )}
      />
      <aside
        className={cn(
          "absolute left-0 top-0 flex h-full w-64 max-w-[80vw] flex-col border-r border-sidebar-border bg-sidebar/75 p-3 shadow-xl backdrop-blur-xl transition-transform duration-200",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center gap-2 px-1">
          <BrandMark className="h-8 w-8" />
          <BrandWordmark className="text-lg" />
          <button
            onClick={onClose}
            aria-label="Close menu"
            className="ml-auto rounded-md p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-6">
          <NavLinks onNavigate={onClose} scope="mobile" />
        </div>

        <div className="mt-auto">
          <AgentReadyCard />
        </div>
      </aside>
    </div>
  );
}
