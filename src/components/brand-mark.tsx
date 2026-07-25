import { Bug } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useReduced } from "@/lib/motion";

// The ZeroBug mark: a flat solid-amber square with a bug glyph — a signal lamp,
// not a glowing orb. Size the square via `className` (e.g. "h-8 w-8").
// `animate`: "idle" = slow 3s breathe; "active" = faster 1.6s pulse + wobble.
export function BrandMark({
  className,
  animate,
}: {
  className?: string;
  animate?: "idle" | "active";
}) {
  const reduced = useReduced();
  const motionProps =
    reduced || !animate
      ? {}
      : animate === "active"
        ? {
            // Working: a gentle, faster breathe — no rotate wobble (kept calm).
            animate: { scale: [1, 1.05, 1] },
            transition: { duration: 1.8, ease: "easeInOut" as const, repeat: Infinity },
          }
        : {
            animate: { scale: [1, 1.03, 1] },
            transition: { duration: 3.5, ease: "easeInOut" as const, repeat: Infinity },
          };
  return (
    <motion.span
      {...motionProps}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md bg-signal text-signal-foreground ring-1 ring-white/15",
        className,
      )}
    >
      <Bug className="h-[55%] w-[55%]" strokeWidth={2.4} />
    </motion.span>
  );
}

// The "ZeroBug" wordmark — Space Grotesk, flat foreground color, no gradient.
export function BrandWordmark({ className }: { className?: string }) {
  return (
    <span className={cn("font-display font-semibold tracking-tight text-foreground", className)}>
      ZeroBug
    </span>
  );
}
