import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * A styled dropdown to replace bare native <select>s. The option list renders in
 * a portal with fixed positioning, so it's never clipped by a scrolling/overflow
 * parent (e.g. a modal body or the board). `align="top"` opens upward.
 * With `resetOnSelect`, the trigger keeps showing `placeholder` after a pick —
 * useful for action menus ("Priority…", "Category…").
 */
export function StyledSelect({
  value,
  onChange,
  options,
  placeholder = "Select…",
  align = "bottom",
  resetOnSelect = false,
  disabled = false,
  title,
  className,
}: {
  value?: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  align?: "top" | "bottom";
  resetOnSelect?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    width: number;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const place = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (align === "top") {
      setPos({ left: r.left, bottom: window.innerHeight - r.top + 4, width: r.width });
    } else {
      setPos({ left: r.left, top: r.bottom + 4, width: r.width });
    }
  };

  const toggle = () => {
    if (disabled) return;
    if (!open) place();
    setOpen((v) => !v);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    // Close on any scroll/resize so the fixed-position menu can't drift.
    const onReflow = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open]);

  const selected = options.find((o) => o.value === value);
  const label = resetOnSelect ? placeholder : (selected?.label ?? placeholder);
  const showMuted = resetOnSelect || !selected;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={toggle}
        title={title}
        className={cn(
          "flex h-8 w-full items-center justify-between gap-1.5 rounded-md border border-border bg-background px-2.5 text-sm outline-none transition hover:border-primary/50 hover:bg-accent/20 focus:border-primary/60 focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      >
        <span className={cn("truncate", showMuted && "text-muted-foreground")}>{label}</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            style={{
              position: "fixed",
              left: pos.left,
              top: pos.top,
              bottom: pos.bottom,
              minWidth: pos.width,
            }}
            className="z-[80] max-h-60 max-w-[18rem] overflow-y-auto overflow-x-hidden rounded-lg border border-border bg-card p-1 shadow-xl animate-fade-in scrollbar-thin"
          >
            {options.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">No options</div>
            )}
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition",
                  !resetOnSelect && o.value === value
                    ? "bg-primary/12 text-foreground"
                    : "text-foreground hover:bg-accent/70",
                )}
              >
                <span className="flex-1 truncate">{o.label}</span>
                {!resetOnSelect && o.value === value && (
                  <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                )}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
