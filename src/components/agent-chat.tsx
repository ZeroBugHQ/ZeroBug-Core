import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Layers,
  Loader2,
  MessageSquarePlus,
  Plus,
  Send,
  Sparkles,
  PanelRightClose,
  Trash2,
  X,
} from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import type { ChatThreadSummary } from "@/lib/api";
import { useReduced } from "@/lib/motion";
import { BrandMark } from "./brand-mark";

// New chat messages slide + fade in from below.
function MessageMotion({ children }: { children: ReactNode }) {
  const reduced = useReduced();
  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 320, damping: 30 }}
    >
      {children}
    </motion.div>
  );
}

export type ChatRole = "user" | "agent" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  ts: number;
  testCode?: string;
  kind?:
    | "thought"
    | "action"
    | "step"
    | "result-pass"
    | "result-fail"
    | "user"
    | "screenshot"
    | "compaction";
  // For kind === "compaction": how much was folded into the summary.
  meta?: { summarizedCount: number; tokensBefore: number; tokensAfter: number };
  // For kind === "step": live status + what actually happened + step number.
  stepStatus?: "running" | "pass" | "fail";
  detail?: string;
  stepNo?: number;
}

// ── Reusable drag-resize hook ─────────────────────────────────────────────────

export function useResizeHandle(options: {
  axis: "x" | "y";
  defaultSize: number;
  minSize: number;
  maxSize: number;
  invert?: boolean;
}) {
  const [size, setSize] = useState(options.defaultSize);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    startPos: number;
    startSize: number;
  } | null>(null);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const pos = options.axis === "x" ? e.clientX : e.clientY;
      dragRef.current = { startPos: pos, startSize: size };
      setDragging(true);
    },
    [options.axis, size],
  );

  useEffect(() => {
    if (!dragging || !dragRef.current) return;
    const { startPos, startSize } = dragRef.current;

    const onMouseMove = (e: MouseEvent) => {
      const currentPos = options.axis === "x" ? e.clientX : e.clientY;
      const rawDelta = currentPos - startPos;
      const delta = options.invert ? -rawDelta : rawDelta;
      const clamped = Math.max(options.minSize, Math.min(options.maxSize, startSize + delta));
      setSize(clamped);
    };

    const onMouseUp = () => {
      dragRef.current = null;
      setDragging(false);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [dragging, options.axis, options.invert, options.minSize, options.maxSize]);

  return { size, dragging, onMouseDown, setSize };
}

// ── Chat sidebar panel ─────────────────────────────────────────────────────────

export function AgentChatPanel({
  collapsed,
  onToggle,
  messages,
  agentStatus,
  chatBusy,
  liveTokens,
  context,
  compacting,
  onCompact,
  pendingQuestion,
  onSend,
  chatRef,
  onImageClick,
  threads,
  activeThreadId,
  onSelectThread,
  onNewThread,
  onDeleteThread,
  defaultWidth = 380,
  minWidth = 280,
  maxWidth = 600,
}: {
  collapsed: boolean;
  onToggle: () => void;
  messages: ChatMessage[];
  agentStatus: "idle" | "working" | "waiting";
  chatBusy: boolean;
  liveTokens: number;
  context: { used: number; window: number } | null;
  compacting: boolean;
  onCompact: () => void;
  pendingQuestion: { question: string } | null;
  onSend: (text: string) => void;
  chatRef: React.RefObject<HTMLDivElement | null>;
  onImageClick: (src: string) => void;
  threads?: ChatThreadSummary[];
  activeThreadId?: string | null;
  onSelectThread?: (id: string) => void;
  onNewThread?: () => void;
  onDeleteThread?: (id: string) => void;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
}) {
  const {
    size: chatWidth,
    dragging: isResizing,
    onMouseDown: onResizeStart,
  } = useResizeHandle({
    axis: "x",
    defaultSize: defaultWidth,
    minSize: minWidth,
    maxSize: maxWidth,
    invert: true,
  });

  return (
    <aside
      className={cn(
        "shrink-0 flex-col overflow-hidden bg-panel-raised/50 backdrop-blur-xl",
        // Mobile/tablet: a full-screen overlay when open, hidden when collapsed.
        // Large screens: an inline, resizable side panel.
        collapsed
          ? "hidden"
          : "fixed inset-0 z-50 flex max-lg:!w-full lg:relative lg:inset-auto lg:z-auto lg:border-l lg:border-border",
        !isResizing && "transition-[width] duration-200",
      )}
      style={{ width: collapsed ? 0 : chatWidth }}
    >
      {/* Drag handle on the left edge — a visible grip pill signals it's resizable. */}
      {!collapsed && (
        <div
          onMouseDown={onResizeStart}
          title="Drag to resize"
          className={cn(
            "group/resize absolute left-0 top-0 z-20 hidden h-full w-1.5 cursor-col-resize items-center justify-center transition-colors lg:flex",
            isResizing ? "bg-signal/50" : "hover:bg-signal/30",
          )}
        >
          <span
            className={cn(
              "h-10 w-1 rounded-full bg-signal transition-opacity",
              isResizing ? "opacity-100" : "opacity-70 group-hover/resize:opacity-100",
            )}
          />
        </div>
      )}

      <div className="flex h-full flex-col max-lg:!w-full" style={{ width: chatWidth }}>
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <BrandMark className="h-7 w-7" animate={agentStatus === "idle" ? "idle" : "active"} />
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold">ZeroBug</span>
            <span
              className={cn(
                "text-[11px]",
                agentStatus === "idle" ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {agentStatus === "waiting"
                ? "Waiting for your reply…"
                : agentStatus === "working"
                  ? "Online · working…"
                  : "Idle · ready to run"}
            </span>
          </div>
          <span
            className={cn(
              "ml-auto h-2 w-2 rounded-full",
              agentStatus === "waiting" && "bg-warning breathe",
              agentStatus === "working" && "bg-success breathe",
              agentStatus === "idle" && "bg-muted-foreground/40",
            )}
            title={
              agentStatus === "waiting"
                ? "Paused — waiting for your reply"
                : agentStatus === "working"
                  ? "Online — running"
                  : "Idle"
            }
          />
          <button
            onClick={onToggle}
            title="Hide ZeroBug"
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <PanelRightClose className="h-4 w-4" />
          </button>
        </div>

        {onNewThread && (
          <ThreadMenu
            threads={threads ?? []}
            activeThreadId={activeThreadId ?? null}
            onSelectThread={onSelectThread}
            onNewThread={onNewThread}
            onDeleteThread={onDeleteThread}
          />
        )}

        <div ref={chatRef} className="flex-1 space-y-3 overflow-y-auto scrollbar-thin p-4">
          {messages.map((m) => (
            <MessageMotion key={m.id}>
              <ChatBubble msg={m} onImageClick={onImageClick} />
            </MessageMotion>
          ))}
          {agentStatus === "working" && <ThinkingIndicator tokens={liveTokens} />}
        </div>

        <ChatComposer
          pendingQuestion={pendingQuestion}
          busy={chatBusy}
          onSubmit={onSend}
          context={context}
          compacting={compacting}
          onCompact={onCompact}
        />
      </div>
    </aside>
  );
}

// ── Thread selector ─────────────────────────────────────────────────────────

function relativeTime(iso: string) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function ThreadMenu({
  threads,
  activeThreadId,
  onSelectThread,
  onNewThread,
  onDeleteThread,
}: {
  threads: ChatThreadSummary[];
  activeThreadId: string | null;
  onSelectThread?: (id: string) => void;
  onNewThread?: () => void;
  onDeleteThread?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = threads.find((t) => t.id === activeThreadId);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} className="relative border-b border-border px-3 py-2">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-accent"
          title="Switch conversation"
        >
          <MessageSquarePlus className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{active?.title || "New chat"}</span>
          <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
        <button
          onClick={() => {
            onNewThread?.();
            setOpen(false);
          }}
          title="New conversation"
          aria-label="New conversation"
          className="shrink-0 rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {open && (
        <div className="absolute inset-x-3 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg scrollbar-thin">
          {threads.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              No saved conversations yet.
            </div>
          )}
          {threads.map((t) => (
            <div
              key={t.id}
              className={cn(
                "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition hover:bg-accent",
                t.id === activeThreadId && "bg-accent/60",
              )}
            >
              <button
                onClick={() => {
                  onSelectThread?.(t.id);
                  setOpen(false);
                }}
                className="flex min-w-0 flex-1 flex-col text-left"
              >
                <span className="truncate">{t.title || "New chat"}</span>
                <span className="text-[11px] text-muted-foreground">
                  {t.messageCount} message{t.messageCount === 1 ? "" : "s"} ·{" "}
                  {relativeTime(t.updatedAt)}
                </span>
              </button>
              {onDeleteThread && (
                <button
                  onClick={() => onDeleteThread(t.id)}
                  title="Delete conversation"
                  aria-label="Delete conversation"
                  className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
          <div className="mt-1 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
            Conversations auto-clear 10 days after their last activity.
          </div>
        </div>
      )}
    </div>
  );
}

// ── Chat bubble ────────────────────────────────────────────────────────────────

export const ChatBubble = memo(function ChatBubble({
  msg,
  onImageClick,
}: {
  msg: ChatMessage;
  onImageClick: (src: string) => void;
}) {
  if (msg.kind === "compaction") {
    return <CompactionTimeline msg={msg} />;
  }
  if (msg.kind === "screenshot") {
    return (
      <div className="flex gap-2">
        <BrandMark className="mt-0.5 h-7 w-7" />
        <button
          onClick={() => onImageClick(msg.content)}
          title="Click to expand"
          className="group relative overflow-hidden rounded-md border border-border transition hover:border-muted-foreground/50"
        >
          <img src={msg.content} alt="Page screenshot" className="block max-h-44 w-auto" />
          <span className="absolute inset-x-0 bottom-0 bg-background/70 px-2 py-0.5 text-center text-[10px] text-muted-foreground opacity-0 transition group-hover:opacity-100">
            Click to expand
          </span>
        </button>
      </div>
    );
  }
  if (msg.kind === "step") {
    // A live play-by-play row: status icon + action label + what actually
    // happened. Rendered as a nested timeline under the agent (indented).
    const status = msg.stepStatus ?? "running";
    const accent =
      status === "pass"
        ? "border-success/30 bg-success/5"
        : status === "fail"
          ? "border-destructive/40 bg-destructive/5"
          : "border-running/40 bg-running/5";
    return (
      <div className="flex gap-2 pl-9">
        <div className={cn("min-w-0 flex-1 rounded-md border px-2.5 py-1.5", accent)}>
          <div className="flex items-center gap-1.5">
            {status === "running" ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-running" />
            ) : status === "pass" ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-success" />
            ) : (
              <X className="h-3.5 w-3.5 shrink-0 text-destructive" />
            )}
            {msg.stepNo != null && (
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                #{msg.stepNo}
              </span>
            )}
            <span className="min-w-0 flex-1 break-words text-xs font-medium text-foreground">
              {msg.content}
            </span>
          </div>
          {msg.detail && (
            <div className="mt-1 break-words pl-5 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {msg.detail}
            </div>
          )}
        </div>
      </div>
    );
  }
  if (msg.role === "system") {
    return (
      <div className="flex items-center gap-2 py-1 text-center text-[11px] text-muted-foreground">
        <div className="h-px flex-1 bg-border" />
        <span className="whitespace-pre-wrap">{renderMarkdownLite(msg.content)}</span>
        <div className="h-px flex-1 bg-border" />
      </div>
    );
  }
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-md border border-border bg-panel-raised px-3 py-2 text-sm text-foreground">
          {msg.content}
        </div>
      </div>
    );
  }
  // Empty agent bubble = the streaming placeholder before the first token; the
  // ThinkingIndicator already conveys activity, so render nothing here.
  if (!msg.content) return null;
  const accent =
    msg.kind === "result-pass"
      ? "border-l-[3px] border-l-success border-border bg-panel-raised"
      : msg.kind === "result-fail"
        ? "border-l-[3px] border-l-destructive border-border bg-panel-raised"
        : msg.kind === "action"
          ? "border-l-[3px] border-l-signal border-border bg-panel-raised"
          : "border-border bg-panel-raised";
  return (
    <div className="flex gap-2">
      <BrandMark className="mt-0.5 h-7 w-7" />
      <div className={cn("max-w-[85%] rounded-md border px-3 py-2 text-sm", accent)}>
        {msg.testCode && (
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {msg.testCode}
          </div>
        )}
        <div className="whitespace-pre-wrap leading-relaxed">{renderMarkdownLite(msg.content)}</div>
      </div>
    </div>
  );
});

// ── Compaction timeline node ─────────────────────────────────────────────────────

function CompactionTimeline({ msg }: { msg: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const meta = msg.meta;
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return (
    <div className="my-1">
      <div className="flex items-center gap-2">
        <div className="h-px flex-1 bg-border" />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          title="Show what was summarized"
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[10px] font-medium text-muted-foreground transition hover:text-foreground"
        >
          <Layers className="h-3 w-3 text-primary" />
          Context compacted
          {meta && (
            <span className="text-muted-foreground/70">
              · {meta.summarizedCount} msg{meta.summarizedCount === 1 ? "" : "s"} ·{" "}
              {fmt(meta.tokensBefore)}→{fmt(meta.tokensAfter)}
            </span>
          )}
          <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
        </button>
        <div className="h-px flex-1 bg-border" />
      </div>
      {open && msg.content && (
        <div className="mx-6 mt-1.5 whitespace-pre-wrap rounded-lg border border-border bg-background/60 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
          {msg.content}
        </div>
      )}
    </div>
  );
}

// ── Chat composer ──────────────────────────────────────────────────────────────

export const ChatComposer = memo(function ChatComposer({
  pendingQuestion,
  busy,
  onSubmit,
  context,
  compacting,
  onCompact,
}: {
  pendingQuestion: { question: string } | null;
  busy: boolean;
  onSubmit: (text: string) => void;
  context: { used: number; window: number } | null;
  compacting: boolean;
  onCompact: () => void;
}) {
  const [draft, setDraft] = useState("");
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onSubmit(text);
    setDraft("");
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="border-t border-border p-3"
    >
      {pendingQuestion && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-primary/40 bg-primary/10 p-2.5 text-xs text-foreground">
          <span className="mt-px text-sm leading-none">❓</span>
          <div className="flex-1">
            <div className="font-medium text-primary">ZeroBug needs your input to continue</div>
            <p className="mt-0.5 text-muted-foreground">{pendingQuestion.question}</p>
          </div>
        </div>
      )}
      <div
        className={cn(
          "flex items-end gap-2 rounded-xl border bg-background p-2 focus-within:ring-2 focus-within:ring-primary/20",
          pendingQuestion
            ? "border-primary/60 ring-2 ring-primary/20"
            : "border-border focus-within:border-primary/60",
        )}
      >
        <textarea
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            pendingQuestion
              ? "Type login instructions (or “skip”) and press Enter to resume…"
              : "Ask the agent or describe a new test…"
          }
          className="max-h-32 flex-1 resize-none scrollbar-none bg-transparent px-2 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none"
        />
        {context && context.window > 0 && (
          <ContextRing
            used={context.used}
            window={context.window}
            compacting={compacting}
            onCompact={onCompact}
          />
        )}
        <motion.button
          type="submit"
          disabled={!draft.trim() || (busy && !pendingQuestion)}
          whileTap={{ scale: 0.97 }}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-signal text-signal-foreground transition hover:brightness-105 disabled:opacity-40"
        >
          {busy && !pendingQuestion ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </motion.button>
      </div>
      <div className="mt-2 flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
        {pendingQuestion ? (
          <span className="text-primary">
            ZeroBug is paused — waiting for your reply to continue the run.
          </span>
        ) : (
          <>
            <Sparkles className="h-3 w-3" />
            Powered by Playwright · Chromium · WebKit
          </>
        )}
      </div>
    </form>
  );
});

// ── Context ring (click to compact) ──────────────────────────────────────────────

function fmtTokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function ContextRing({
  used,
  window,
  compacting,
  onCompact,
}: {
  used: number;
  window: number;
  compacting: boolean;
  onCompact: () => void;
}) {
  const pct = Math.min(100, Math.round((used / window) * 100));
  const tone = pct >= 85 ? "text-destructive" : pct >= 60 ? "text-warning" : "text-primary";
  const r = 7;
  const circumference = 2 * Math.PI * r;
  return (
    <button
      type="button"
      onClick={onCompact}
      disabled={compacting}
      title={`Context ${fmtTokens(used)} / ${fmtTokens(window)} · ${pct}% used — click to compact the conversation`}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-accent disabled:opacity-50"
    >
      {compacting ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <span className="relative inline-flex h-5 w-5 items-center justify-center">
          <svg width="20" height="20" viewBox="0 0 20 20" className={tone}>
            <circle
              cx="10"
              cy="10"
              r={r}
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.2"
              strokeWidth="2.5"
            />
            <circle
              cx="10"
              cy="10"
              r={r}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - pct / 100)}
              transform="rotate(-90 10 10)"
            />
          </svg>
        </span>
      )}
    </button>
  );
}

// ── Thinking indicator ─────────────────────────────────────────────────────────

function ThinkingDots() {
  return (
    <span className="flex items-center gap-1">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-current"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

function ThinkingIndicator({ tokens }: { tokens: number }) {
  return (
    <div className="flex gap-2">
      <BrandMark className="mt-0.5 h-7 w-7" />
      <div className="flex items-center gap-2 rounded-md border border-border bg-panel-raised px-3 py-2.5 text-muted-foreground">
        <ThinkingDots />
        <span className="text-xs">
          ZeroBug is thinking…
          {tokens > 0 && (
            <span className="ml-1 font-mono text-[11px] text-primary">{tokens} tokens</span>
          )}
        </span>
      </div>
    </div>
  );
}

// ── Image lightbox ─────────────────────────────────────────────────────────────

export function Lightbox({ src, onClose }: { src: string | null; onClose: () => void }) {
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [src, onClose]);

  if (!src) return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm p-4 animate-fade-in"
      onClick={onClose}
    >
      <img
        src={src}
        alt="Full-size screenshot"
        className="max-h-full max-w-full rounded-xl border border-border object-contain shadow-2xl"
      />
    </div>
  );
}

// ── Markdown lite ──────────────────────────────────────────────────────────────

function renderMarkdownLite(text: string): ReactNode {
  const parts: ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIndex) parts.push(text.slice(lastIndex, m.index));
    const token = m[0];
    if (token.startsWith("**")) {
      parts.push(
        <strong key={key++} className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      parts.push(
        <code
          key={key++}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground"
        >
          {token.slice(1, -1)}
        </code>,
      );
    }
    lastIndex = m.index + token.length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}
