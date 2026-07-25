import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Transition,
  type Variants,
} from "framer-motion";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { cn, uid } from "./utils";

// ── Spring presets (from the design spec) ──────────────────────────────────
export const SPRING_CARD: Transition = { type: "spring", stiffness: 300, damping: 30 };
export const SPRING_HOVER: Transition = { type: "spring", stiffness: 400, damping: 25 };
export const SPRING_LAYOUT: Transition = { type: "spring", stiffness: 260, damping: 28 };
export const SPRING_COUNTER: Transition = { type: "spring", stiffness: 500, damping: 20 };

/** True when the user asked for reduced motion — components fall back to instant. */
export function useReduced(): boolean {
  return useReducedMotion() ?? false;
}

// ── Ambient background — faint amber grid + soft yellow illumination ────────
// Fixed, behind everything, GPU-transform only. Calm/slow so it never distracts
// from a data-dense board.
export function AmbientBackground() {
  const reduced = useReduced();
  const amber = (pct: number) => `color-mix(in oklab, var(--accent-signal) ${pct}%, transparent)`;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {/* Amber diagnostic grid — full-bleed across the whole page, no fade. */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `linear-gradient(to right, ${amber(14)} 1px, transparent 1px), linear-gradient(to bottom, ${amber(14)} 1px, transparent 1px)`,
          backgroundSize: "42px 42px",
        }}
      />
      {/* Warm yellow illumination — a large amber glow drifting very slowly. */}
      <motion.div
        className="absolute -left-32 -top-32 h-[620px] w-[620px] rounded-full blur-3xl"
        style={{ background: `radial-gradient(circle, ${amber(11)}, transparent 70%)` }}
        animate={reduced ? undefined : { x: [0, 60, 0, -60, 0], y: [0, -45, 45, 15, 0] }}
        transition={reduced ? undefined : { duration: 40, ease: "easeInOut", repeat: Infinity }}
      />
      {/* Second, softer amber glow anchoring the bottom-right. */}
      <motion.div
        className="absolute -bottom-40 right-[-8rem] h-[560px] w-[560px] rounded-full blur-3xl"
        style={{ background: `radial-gradient(circle, ${amber(7)}, transparent 70%)` }}
        animate={reduced ? undefined : { x: [0, -50, 0, 50, 0], y: [0, 35, -35, -10, 0] }}
        transition={reduced ? undefined : { duration: 46, ease: "easeInOut", repeat: Infinity }}
      />
      {/* Slow amber scanner sweep — felt more than seen. */}
      {!reduced && (
        <motion.div
          className="absolute top-0 h-[140vh] w-px blur-[1px]"
          style={{ background: amber(9), rotate: "18deg", transformOrigin: "top" }}
          initial={{ x: "-100%" }}
          animate={{ x: "200%" }}
          transition={{ duration: 13, ease: "easeInOut", repeat: Infinity }}
        />
      )}
    </div>
  );
}

// ── Page enter — universal fade + slide-up used on every route page ─────────
export function PageEnter({ children, className }: { children: ReactNode; className?: string }) {
  const reduced = useReduced();
  return (
    <motion.div
      className={className}
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduced ? { duration: 0 } : SPRING_CARD}
    >
      {children}
    </motion.div>
  );
}

// ── Stagger container + item (columns, cards, lists) ────────────────────────
const containerVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } },
};
const itemVariants: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: SPRING_CARD },
};

export function Stagger({
  children,
  className,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "ul";
}) {
  const reduced = useReduced();
  const Comp = as === "ul" ? motion.ul : motion.div;
  return (
    <Comp
      className={className}
      variants={reduced ? undefined : containerVariants}
      initial={reduced ? false : "hidden"}
      animate={reduced ? false : "show"}
    >
      {children}
    </Comp>
  );
}

export function StaggerItem({ children, className }: { children: ReactNode; className?: string }) {
  const reduced = useReduced();
  return (
    <motion.div className={className} variants={reduced ? undefined : itemVariants}>
      {children}
    </motion.div>
  );
}

// ── Animated counter — pops (scale 1→1.15→1) whenever the value changes ─────
export function CounterValue({ value, className }: { value: number; className?: string }) {
  const reduced = useReduced();
  if (reduced) return <span className={className}>{value}</span>;
  return (
    <motion.span
      key={value}
      className={cn("inline-block", className)}
      initial={{ scale: 1 }}
      animate={{ scale: [1, 1.15, 1] }}
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      {value}
    </motion.span>
  );
}

// ── Running pulse — two concentric cyan rings expanding + fading ────────────
export function RunningPulse({ className }: { className?: string }) {
  const reduced = useReduced();
  if (reduced) {
    return <span className={cn("h-2 w-2 rounded-full bg-running", className)} />;
  }
  const ring = "absolute inset-0 rounded-full border border-running";
  return (
    <span className={cn("relative inline-flex h-2 w-2", className)}>
      <span className="absolute inset-0 rounded-full bg-running" />
      {[0, 0.6].map((delay) => (
        <motion.span
          key={delay}
          className={ring}
          initial={{ scale: 1, opacity: 0.6 }}
          animate={{ scale: 1.8, opacity: 0 }}
          transition={{ duration: 1.6, ease: "easeInOut", repeat: Infinity, delay }}
        />
      ))}
    </span>
  );
}

// ── Pass burst — 6 dots radiating outward once, then gone ───────────────────
export function PassBurst() {
  const reduced = useReduced();
  if (reduced) return null;
  const dots = Array.from({ length: 6 }, (_, i) => (i / 6) * Math.PI * 2);
  return (
    <span className="pointer-events-none absolute left-3 top-1/2 z-10">
      {dots.map((angle, i) => (
        <motion.span
          key={i}
          className="absolute h-1 w-1 rounded-full bg-status-passed"
          initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
          animate={{
            x: Math.cos(angle) * 16,
            y: Math.sin(angle) * 16,
            opacity: 0,
            scale: 0.4,
          }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        />
      ))}
    </span>
  );
}

// ── Toasts ──────────────────────────────────────────────────────────────────
type ToastTone = "info" | "success" | "error";
type Toast = { id: string; message: string; tone: ToastTone; duration: number };
type ToastCtx = { push: (message: string, tone?: ToastTone, duration?: number) => void };

const ToastContext = createContext<ToastCtx | null>(null);

export function useToast(): ToastCtx {
  return useContext(ToastContext) ?? { push: () => {} };
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const reduced = useReduced();

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback<ToastCtx["push"]>(
    (message, tone = "info", duration = 4000) => {
      const id = uid();
      setToasts((prev) => [...prev, { id, message, tone, duration }]);
      setTimeout(() => remove(id), duration);
    },
    [remove],
  );

  const ctx = useMemo(() => ({ push }), [push]);

  const toneBar: Record<ToastTone, string> = {
    info: "bg-cyan",
    success: "bg-status-passed",
    error: "bg-status-failed",
  };
  const toneRail: Record<ToastTone, string> = {
    info: "border-l-cyan",
    success: "border-l-status-passed",
    error: "border-l-status-failed",
  };

  return (
    <ToastContext.Provider value={ctx}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-[200] flex w-80 flex-col gap-2">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={reduced ? { opacity: 0 } : { opacity: 0, x: 40, scale: 0.96 }}
              animate={reduced ? { opacity: 1 } : { opacity: 1, x: 0, scale: 1 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, x: 40, scale: 0.96 }}
              transition={SPRING_LAYOUT}
              className={cn(
                "pointer-events-auto relative overflow-hidden rounded-md border border-l-[3px] border-border bg-panel-raised px-3 py-2.5 text-sm text-foreground shadow-lg",
                toneRail[t.tone],
              )}
            >
              {t.message}
              {!reduced && (
                <motion.span
                  className={cn("absolute bottom-0 left-0 h-0.5", toneBar[t.tone])}
                  initial={{ width: "100%" }}
                  animate={{ width: "0%" }}
                  transition={{ duration: t.duration / 1000, ease: "linear" }}
                />
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
