import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { CounterValue, RunningPulse, SPRING_HOVER, useReduced, useToast } from "@/lib/motion";
import {
  AlertTriangle,
  ArrowDownWideNarrow,
  Ban,
  ArrowUpNarrowWide,
  Bot,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Clock,
  FolderPlus,
  Hash,
  ImagePlus,
  Layers,
  ListChecks,
  Loader2,
  Menu,
  MessageSquare,
  Minus,
  Monitor,
  PanelRightClose,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Send,
  Smartphone,
  Sparkles,
  Square,
  Tablet,
  Terminal,
  Trash2,
  Wand2,
  X,
  XCircle,
} from "lucide-react";
import { type TestCase, type TestStatus } from "@/lib/mock-tests";
import {
  api,
  assetUrl,
  streamSSE,
  streamSSEGet,
  type BoardColumn,
  type Category,
  type ChatEvent,
  type ColumnSystemKey,
  type GenerateSuiteEvent,
  type Environment,
  type RunEvent,
  type RunRecord,
} from "@/lib/api";
import { useProject } from "@/lib/use-project";
import { cn, uid } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
import { AppSidebar, MobileSidebar } from "@/components/app-sidebar";
import { StyledSelect } from "@/components/styled-select";
import { AddTestModal } from "@/components/add-test-modal";
import { ProjectSwitcher } from "@/components/project-switcher";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { AgentChatPanel, Lightbox } from "@/components/agent-chat";
import type { ChatMessage } from "@/components/agent-chat";

const COLUMN_HINT: Record<string, string> = {
  queued: "Drop tests here or add a new one",
  running: "Playwright executing",
  passed: "Assertions green",
  failed: "Needs review",
};

const PRIORITY_STYLES: Record<TestCase["priority"], string> = {
  low: "bg-muted text-muted-foreground border border-border",
  medium: "bg-muted text-muted-foreground border border-border",
  high: "bg-warning/10 text-warning border border-warning/40",
  critical: "bg-destructive/10 text-destructive border border-destructive/40",
};

const PRIORITY_ORDER: TestCase["priority"][] = ["critical", "high", "medium", "low"];

type TestFilters = { text: string; tags: string[]; priorities: string[] };

function failureKind(test: TestCase): "Bug" | "Agent Bug" {
  const reason = `${test.failureReason ?? ""} ${test.description ?? ""}`.toLowerCase();
  const agentSignals = [
    "agent got stuck",
    "repeating",
    "elementhandle",
    "locator",
    "strict mode violation",
    "not attached to the dom",
    "execution context was destroyed",
    "target closed",
    "browser closed",
    "context closed",
    "page closed",
    "protocol error",
    "playwright",
    "could not decide next action",
    "model did not return",
    "stopped by user",
  ];
  return agentSignals.some((signal) => reason.includes(signal)) ? "Agent Bug" : "Bug";
}

// Does a test pass the active board filters? (text matches code/title/suite/tags;
// tags/priorities are AND across groups, OR within a group.)
function matchesFilters(test: TestCase, f: TestFilters): boolean {
  const text = f.text.trim().toLowerCase();
  if (text) {
    const hay = [test.code, test.title, test.suite, ...(test.tags ?? [])].join(" ").toLowerCase();
    if (!hay.includes(text)) return false;
  }
  if (f.tags.length && !f.tags.every((tag) => (test.tags ?? []).includes(tag))) return false;
  if (f.priorities.length && !f.priorities.includes(test.priority)) return false;
  return true;
}

// Compact date + time for the cards, e.g. "Jul 6, 2:34 PM". Returns "" if absent.
function formatDateTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Full date + time for tooltips, e.g. "Jul 6, 2026, 2:34:05 PM".
function formatDateTimeFull(iso?: string): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "unknown" : d.toLocaleString();
}

// Rough token estimate (~4 chars/token) used for the auto-compaction threshold.
function estTokens(text?: string): number {
  return Math.ceil((text || "").length / 4);
}

const WELCOME_TEXT =
  "Hi — I'm ZeroBug. Queue tests on the board, then press **Run all** and I'll execute each with Playwright, narrating as I go.";

function welcomeMessage(): ChatMessage {
  return { id: "m0", role: "agent", kind: "thought", ts: Date.now(), content: WELCOME_TEXT };
}

// Map a persisted thread message back to the on-screen ChatMessage shape.
function toChatMessage(m: {
  mid: string;
  role: string;
  content: string;
  kind?: string;
  ts?: number;
  testCode?: string;
  detail?: string;
  stepNo?: number;
  stepStatus?: string;
  meta?: unknown;
}): ChatMessage {
  return {
    id: m.mid || uid(),
    role: m.role as ChatMessage["role"],
    content: m.content,
    kind: m.kind as ChatMessage["kind"],
    ts: m.ts ?? Date.now(),
    testCode: m.testCode,
    detail: m.detail,
    stepNo: m.stepNo,
    stepStatus: m.stepStatus as ChatMessage["stepStatus"],
    meta: m.meta as ChatMessage["meta"],
  };
}

// Derive a short thread title from the first user message.
function deriveThreadTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const text = (firstUser?.content || "").trim().replace(/\s+/g, " ");
  return text ? text.slice(0, 60) : "New chat";
}

export function TestRunnerApp() {
  const qc = useQueryClient();
  const reducedMotion = useReduced();
  const toast = useToast();
  const navigate = useNavigate();
  const { currentProjectId, currentProject, isLoading: projectsLoading } = useProject();

  const {
    data: tests = [],
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ["tests", currentProjectId],
    queryFn: () => api.listTests(currentProjectId!),
    enabled: !!currentProjectId,
  });
  const { data: columns = [] } = useQuery({
    queryKey: ["columns", currentProjectId],
    queryFn: () => api.listColumns(currentProjectId!),
    enabled: !!currentProjectId,
  });
  const { data: categories = [] } = useQuery({
    queryKey: ["categories", currentProjectId],
    queryFn: () => api.listCategories(currentProjectId!),
    enabled: !!currentProjectId,
  });
  const { data: environments = [] } = useQuery({
    queryKey: ["environments"],
    queryFn: () => api.listEnvironments(),
    refetchInterval: 10000,
  });
  const [running, setRunning] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [chatBusy, setChatBusy] = useState(false);
  // Set while the agent is paused waiting for a reply (e.g. login instructions).
  // The next chat submission answers this question instead of starting a new turn.
  const [pendingQuestion, setPendingQuestion] = useState<{
    questionId: string;
    question: string;
  } | null>(null);
  // Live token count for the current run/chat turn, shown in the thinking indicator.
  const [liveTokens, setLiveTokens] = useState(0);
  // Chat context-window usage (from the agent's last turn): tokens in the prompt.
  const [context, setContext] = useState<{ used: number; window: number } | null>(null);
  const [compacting, setCompacting] = useState(false);
  // ⌘K spotlight search + which card to briefly highlight after picking.
  const [spotlightOpen, setSpotlightOpen] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const testsRef = useRef(tests);
  const stepCountsRef = useRef<Record<string, number>>({});

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Auto-open the agent chat on large screens (it starts collapsed for mobile).
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth >= 1024) setChatCollapsed(false);
  }, []);
  // Start collapsed (matches SSR; avoids a full-screen chat flash on mobile),
  // then auto-open on large screens after mount.
  const [chatCollapsed, setChatCollapsed] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [genSuiteOpen, setGenSuiteOpen] = useState(false);
  const [editing, setEditing] = useState<TestCase | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColumnName, setNewColumnName] = useState("");
  const [renamingCol, setRenamingCol] = useState<string | null>(null);
  const [renameColValue, setRenameColValue] = useState("");
  const [confirmColumn, setConfirmColumn] = useState<BoardColumn | null>(null);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string | null>(null);
  const [filters, setFilters] = useState<TestFilters>({ text: "", tags: [], priorities: [] });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Sort order for the Queued column (by created time).
  const [queuedSort, setQueuedSort] = useState<"newest" | "oldest">("newest");
  // Category grouping: collapse state keyed by `${columnId}::${categoryId|none}`,
  // plus the category a dragged card is hovering over. Create/rename/delete all
  // happen in a dedicated manager modal (no inline inputs in the columns).
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set());
  const [dragOverCat, setDragOverCat] = useState<string | null>(null);
  const [catManagerOpen, setCatManagerOpen] = useState(false);
  const executionBusy = running || activeId !== null;

  const [messages, setMessages] = useState<ChatMessage[]>([welcomeMessage()]);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  // ── Persistent chat threads ──────────────────────────────────────────────
  // Conversations are saved to the backend so they survive navigating away and
  // back (the runs page remounts), and auto-clear 10 days after last activity.
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const hydratingRef = useRef(false); // suppress autosave while loading a thread
  const { data: chatThreads = [] } = useQuery({
    queryKey: ["chat-threads", currentProjectId],
    queryFn: () => api.listChatThreads(currentProjectId!),
    enabled: !!currentProjectId,
  });

  // Load the most-recent thread on mount / project change (or create one).
  useEffect(() => {
    if (!currentProjectId) return;
    let cancelled = false;
    hydratingRef.current = true;
    (async () => {
      try {
        const list = await api.listChatThreads(currentProjectId);
        if (cancelled) return;
        if (list.length) {
          const full = await api.getChatThread(list[0].id);
          if (cancelled) return;
          setActiveThreadId(full.id);
          setMessages(full.messages.length ? full.messages.map(toChatMessage) : [welcomeMessage()]);
        } else {
          const created = await api.createChatThread(currentProjectId, "New chat");
          if (cancelled) return;
          setActiveThreadId(created.id);
          setMessages([welcomeMessage()]);
          qc.invalidateQueries({ queryKey: ["chat-threads", currentProjectId] });
        }
      } catch {
        /* backend offline — keep the local welcome message */
      } finally {
        // Let the setMessages above flush before re-enabling autosave.
        setTimeout(() => {
          if (!cancelled) hydratingRef.current = false;
        }, 0);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId]);

  // Debounced autosave of the current conversation to its thread.
  useEffect(() => {
    if (hydratingRef.current || !activeThreadId || !currentProjectId) return;
    const handle = setTimeout(() => {
      api
        .saveChatThread(activeThreadId, {
          messages: messages.filter((m) => m.kind !== "screenshot"),
          title: deriveThreadTitle(messages),
        })
        .then(() => qc.invalidateQueries({ queryKey: ["chat-threads", currentProjectId] }))
        .catch(() => {});
    }, 1200);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, activeThreadId]);

  const selectThread = useCallback(
    async (id: string) => {
      if (id === activeThreadId) return;
      hydratingRef.current = true;
      try {
        const full = await api.getChatThread(id);
        setActiveThreadId(full.id);
        setMessages(full.messages.length ? full.messages.map(toChatMessage) : [welcomeMessage()]);
      } catch {
        /* ignore */
      } finally {
        setTimeout(() => {
          hydratingRef.current = false;
        }, 0);
      }
    },
    [activeThreadId],
  );

  const newThread = useCallback(async () => {
    if (!currentProjectId) return;
    hydratingRef.current = true;
    try {
      const created = await api.createChatThread(currentProjectId, "New chat");
      setActiveThreadId(created.id);
      setMessages([welcomeMessage()]);
      qc.invalidateQueries({ queryKey: ["chat-threads", currentProjectId] });
    } catch {
      /* ignore */
    } finally {
      setTimeout(() => {
        hydratingRef.current = false;
      }, 0);
    }
  }, [currentProjectId, qc]);

  const deleteThread = useCallback(
    async (id: string) => {
      try {
        await api.deleteChatThread(id);
      } catch {
        /* ignore */
      }
      const remaining = chatThreads.filter((t) => t.id !== id);
      qc.invalidateQueries({ queryKey: ["chat-threads", currentProjectId] });
      if (id === activeThreadId) {
        if (remaining.length) selectThread(remaining[0].id);
        else newThread();
      }
    },
    [chatThreads, activeThreadId, currentProjectId, qc, selectThread, newThread],
  );

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, pendingQuestion]);

  // ⌘K / Ctrl-K toggles the spotlight search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSpotlightOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Jump to a test's card from the spotlight: scroll it into view and flash it.
  const pickTest = (id: string) => {
    setSpotlightOpen(false);
    setHighlightId(id);
    requestAnimationFrame(() =>
      document
        .getElementById(`test-card-${id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" }),
    );
    window.setTimeout(() => setHighlightId((cur) => (cur === id ? null : cur)), 2500);
  };

  useEffect(() => {
    if (environments.length > 0) {
      const activeEnv = environments.find((e) => e.active);
      if (activeEnv && !selectedEnvironmentId) {
        setSelectedEnvironmentId(activeEnv.id);
      }
    }
  }, [environments, selectedEnvironmentId]);

  useEffect(() => {
    testsRef.current = tests;
  }, [tests]);

  const pushMsg = (m: Omit<ChatMessage, "id" | "ts">) =>
    setMessages((prev) => [...prev, { ...m, id: uid(), ts: Date.now() }]);
  const updateMsg = (id: string, content: string) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content } : m)));
  const patchMsg = (id: string, patch: Partial<ChatMessage>) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  // Live step timeline: map "${testId}:${index}" → chat message id, so a step's
  // bubble updates in place (running → pass/fail) instead of stacking new lines.
  const stepMsgRef = useRef<Record<string, string>>({});
  const upsertStep = (opts: {
    testId: string;
    index: number;
    testCode?: string;
    label: string;
    status: "running" | "pass" | "fail";
    detail?: string;
  }) => {
    const key = `${opts.testId}:${opts.index}`;
    const existing = stepMsgRef.current[key];
    const fields: Partial<ChatMessage> = {
      content: opts.label,
      stepStatus: opts.status,
      detail: opts.detail,
      testCode: opts.testCode,
    };
    if (existing) {
      patchMsg(existing, fields);
    } else {
      const id = uid();
      stepMsgRef.current[key] = id;
      setMessages((prev) => [
        ...prev,
        {
          id,
          ts: Date.now(),
          role: "agent",
          kind: "step",
          stepNo: opts.index + 1,
          ...fields,
        } as ChatMessage,
      ]);
    }
  };

  const testsKey = useMemo(() => ["tests", currentProjectId] as const, [currentProjectId]);
  const patchTest = useCallback(
    (id: string, patch: Partial<TestCase>) =>
      qc.setQueryData<TestCase[]>(testsKey, (old) =>
        (old ?? []).map((t) => (t.id === id ? { ...t, ...patch } : t)),
      ),
    [qc, testsKey],
  );
  const refetchTests = useCallback(
    () => qc.invalidateQueries({ queryKey: testsKey }),
    [qc, testsKey],
  );
  const refetchColumns = useCallback(
    () => qc.invalidateQueries({ queryKey: ["columns", currentProjectId] }),
    [qc, currentProjectId],
  );
  const refetchCategories = useCallback(
    () => qc.invalidateQueries({ queryKey: ["categories", currentProjectId] }),
    [qc, currentProjectId],
  );

  const toggleCategoryCollapsed = (key: string) =>
    setCollapsedCats((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const systemColId = useCallback(
    (key: ColumnSystemKey | TestStatus) => {
      // Blocked tests never ran; they live in the Failed column (no dedicated
      // Blocked column) but keep their distinct "blocked" status for styling.
      const colKey = key === "blocked" ? "failed" : key;
      return columns.find((c) => c.systemKey === colKey)?.id;
    },
    [columns],
  );

  const counts = useMemo(() => {
    const c: Record<TestStatus, number> = {
      queued: 0,
      running: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
    };
    for (const t of tests) c[t.status]++;
    return c;
  }, [tests]);

  // Average of real recorded durations — used as the estimate for tests that
  // haven't run yet (instead of the static heuristic).
  const avgDurationMs = useMemo(() => {
    const ran = tests.filter((t) => Number.isFinite(t.durationMs) && (t.durationMs ?? 0) > 0);
    if (!ran.length) return 0;
    return Math.round(ran.reduce((s, t) => s + (t.durationMs as number), 0) / ran.length);
  }, [tests]);

  // Board filtering + multi-select for bulk operations.
  const allTags = useMemo(
    () => Array.from(new Set(tests.flatMap((t) => t.tags ?? []))).sort(),
    [tests],
  );
  const filteredTests = useMemo(
    () => tests.filter((t) => matchesFilters(t, filters)),
    [tests, filters],
  );
  const filteredIdSet = useMemo(() => new Set(filteredTests.map((t) => t.id)), [filteredTests]);
  // Only act on selections that are currently visible under the active filter.
  const visibleSelectedIds = useMemo(
    () => [...selectedIds].filter((id) => filteredIdSet.has(id)),
    [selectedIds, filteredIdSet],
  );

  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const clearSelection = () => setSelectedIds(new Set());
  // Master checkbox for a column: select all its tests, or deselect them if all
  // are already selected.
  const toggleSelectAll = (ids: string[]) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = ids.length > 0 && ids.every((id) => next.has(id));
      ids.forEach((id) => (allSelected ? next.delete(id) : next.add(id)));
      return next;
    });

  async function runBulk(data: Parameters<typeof api.bulkTests>[0]) {
    try {
      await api.bulkTests(data);
      clearSelection();
      refetchTests();
    } catch (e) {
      pushMsg({ role: "system", content: `Bulk action failed: ${(e as Error).message}` });
    }
  }

  // The agent's live status: working while a run/chat is in flight, waiting while
  // paused on a question, otherwise idle. Drives the header indicator.
  const agentStatus: "idle" | "working" | "waiting" = pendingQuestion
    ? "waiting"
    : running || chatBusy || activeId !== null
      ? "working"
      : "idle";

  const createMutation = useMutation({
    mutationFn: (input: Parameters<typeof api.createTest>[0]) => api.createTest(input),
    onSuccess: (created) => {
      refetchTests();
      pushMsg({
        role: "system",
        content: `Added **${created.code} · ${created.title}** to the queue.`,
      });
    },
    onError: (e: Error) => pushMsg({ role: "system", content: `Could not add test: ${e.message}` }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<TestCase> }) => api.updateTest(id, data),
    onSuccess: (updated) => {
      refetchTests();
      pushMsg({ role: "system", content: `Saved changes to **${updated.code}**.` });
    },
    onError: (e: Error) =>
      pushMsg({ role: "system", content: `Could not save test: ${e.message}` }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteTest(id),
    onMutate: (id: string) =>
      qc.setQueryData<TestCase[]>(testsKey, (old) => (old ?? []).filter((t) => t.id !== id)),
    onSettled: () => refetchTests(),
  });

  const createColumnMutation = useMutation({
    mutationFn: (title: string) => api.createColumn(currentProjectId!, title),
    onSuccess: () => {
      refetchColumns();
      setAddingColumn(false);
      setNewColumnName("");
    },
  });
  const renameColumnMutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.updateColumn(id, { title }),
    onSuccess: () => {
      refetchColumns();
      setRenamingCol(null);
    },
  });
  const deleteColumnMutation = useMutation({
    mutationFn: (id: string) => api.deleteColumn(id),
    onSuccess: () => {
      refetchColumns();
      refetchTests();
      setConfirmColumn(null);
    },
  });

  useEffect(() => {
    if (!currentProjectId) return;
    const controller = new AbortController();

    void streamSSEGet<RunEvent>(
      `/api/runs/stream?projectId=${encodeURIComponent(currentProjectId)}`,
      (ev) => {
        const current = testsRef.current;
        const currentTest =
          "testId" in ev && ev.testId ? current.find((t) => t.id === ev.testId) : null;
        const testCode = currentTest?.code;

        if (ev.type === "state") {
          setRunning(ev.running && ev.kind === "all");
          setActiveId(ev.activeTestId ?? null);
          return;
        }

        if (ev.type === "queue_started") {
          if (ev.kind === "all") setRunning(true);
          if (ev.testId) setActiveId(ev.testId);
          setProgress(0);
          setLiveTokens(0);
          return;
        }

        if (ev.type === "queue_progress") {
          setActiveId(ev.testId);
          setProgress(0);
          stepCountsRef.current[ev.testId] = 0;
          return;
        }

        if (ev.type === "queue_complete") {
          setRunning(false);
          setActiveId(null);
          setProgress(0);
          setPendingQuestion(null);
          refetchTests();
          pushMsg({
            role: "agent",
            kind: "thought",
            content: ev.stopped ? "Run stopped by user." : "Run complete.",
          });
          return;
        }

        if (ev.type === "queue_stopping") {
          pushMsg({ role: "system", content: "Stopping the active run…" });
          return;
        }

        if (ev.type === "status") {
          setActiveId(ev.testId);
          patchTest(ev.testId, { status: ev.status, columnId: systemColId(ev.status) });
          return;
        }

        if (ev.type === "attempt") {
          // A new attempt restarts step indices — drop this test's step-message
          // map so its bubbles don't collide with the previous attempt/run.
          for (const k of Object.keys(stepMsgRef.current)) {
            if (k.startsWith(`${ev.testId}:`)) delete stepMsgRef.current[k];
          }
          // Only surface the attempt line when retries are in play (else it's noise).
          if (testCode && (ev.maxAttempts > 1 || ev.attempt > 1)) {
            pushMsg({
              role: "agent",
              kind: "thought",
              testCode,
              content: `Attempt ${ev.attempt}/${ev.maxAttempts}`,
            });
          }
          return;
        }

        if (ev.type === "retry") {
          if (testCode) {
            pushMsg({
              role: "agent",
              kind: "thought",
              testCode,
              content: `Retrying (${ev.attempt}/${ev.maxAttempts})${ev.failureReason ? ` after \`${ev.failureReason}\`` : ""}.`,
            });
          }
          return;
        }

        if (ev.type === "screenshot") {
          pushMsg({ role: "agent", kind: "screenshot", content: ev.dataUrl });
          return;
        }

        if (ev.type === "question") {
          pushMsg({
            role: "agent",
            kind: "thought",
            testCode: ev.testCode ?? testCode,
            content: `❓ ${ev.question}`,
          });
          setPendingQuestion({ questionId: ev.questionId, question: ev.question });
          return;
        }

        if (ev.type === "usage") {
          setLiveTokens((n) => n + ev.responseTokens);
          return;
        }

        if (ev.type === "step") {
          if (currentTest) qc.invalidateQueries({ queryKey: ["run", currentTest.id] });
          // Advance the card progress bar as steps complete.
          if (ev.status !== "running") {
            const nextCount = (stepCountsRef.current[currentTest?.id || ""] ?? 0) + 1;
            if (currentTest?.id) stepCountsRef.current[currentTest.id] = nextCount;
            setProgress((prev) => Math.min(0.95, Math.max(prev, 1 - 1 / (nextCount + 1))));
          }
          // Live play-by-play: each step shows its action + what actually happened,
          // updating in place from running → pass/fail.
          if (ev.testId) {
            upsertStep({
              testId: ev.testId,
              index: ev.index,
              testCode,
              label: ev.label,
              status: ev.status,
              detail: ev.detail,
            });
          }
          return;
        }

        if (ev.type === "result") {
          setPendingQuestion(null);
          patchTest(ev.testId, {
            status: ev.status,
            columnId: systemColId(ev.status) ?? currentTest?.columnId,
            durationMs: ev.durationMs,
            failureReason: ev.failureReason,
          });
          qc.invalidateQueries({ queryKey: ["run", ev.testId] });
          if (testCode) {
            const blocked = ev.status === "blocked";
            pushMsg({
              role: "agent",
              kind: ev.status === "passed" ? "result-pass" : "result-fail",
              testCode,
              content: blocked
                ? `⊘ **${testCode}** blocked — ${ev.failureReason ?? "a dependency did not pass"}`
                : ev.status === "passed"
                  ? `✓ **${testCode}** passed in ${((ev.durationMs ?? 0) / 1000).toFixed(2)}s on attempt ${ev.attempt ?? 1}/${ev.maxAttempts ?? 1}.`
                  : `✗ **${testCode}** failed after ${((ev.durationMs ?? 0) / 1000).toFixed(2)}s on attempt ${ev.attempt ?? 1}/${ev.maxAttempts ?? 1}.\n\n\`${ev.failureReason ?? "Unknown error"}\``,
            });
          }
          stepCountsRef.current[ev.testId] = 0;
          return;
        }

        if (ev.type === "error") {
          pushMsg({ role: "system", content: `Run error: ${ev.message}` });
        }
      },
      controller.signal,
    ).catch((err) => {
      if (!controller.signal.aborted) {
        pushMsg({ role: "system", content: `Live run stream disconnected: ${err.message}` });
      }
    });

    return () => controller.abort();
  }, [currentProjectId, patchTest, qc, refetchTests, systemColId]);

  const openAdd = () => {
    setEditing(null);
    setModalOpen(true);
  };
  const openEdit = (t: TestCase) => {
    setEditing(t);
    setModalOpen(true);
  };
  const closeModal = () => {
    setModalOpen(false);
    setEditing(null);
  };

  async function importCSV(file: File) {
    try {
      const text = await file.text();
      const lines = text.split("\n").filter((line) => line.trim());
      if (lines.length < 2) {
        alert("CSV file must have at least a header and one data row");
        return;
      }

      const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
      const pageIdx = headers.findIndex((h) => h.includes("page"));
      const bugsIdx = headers.findIndex((h) => h.includes("bugs"));
      const stepsIdx = headers.findIndex((h) => h.includes("steps"));
      const expectedIdx = headers.findIndex((h) => h.includes("expected"));
      const slIdx = headers.findIndex((h) => h.includes("sl.") || h.includes("sl"));

      for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(",").map((v) => v.trim());
        if (values.every((v) => !v)) continue;

        const slNo = slIdx >= 0 ? values[slIdx] : `T${i}`;
        const page = pageIdx >= 0 ? values[pageIdx] : "General";
        const bugs = bugsIdx >= 0 ? values[bugsIdx] : "";
        const steps = stepsIdx >= 0 ? values[stepsIdx] : "";
        const expected = expectedIdx >= 0 ? values[expectedIdx] : "";

        const newTest = {
          title: bugs || "Test Case",
          suite: page,
          description: expected || "No description",
          steps: steps ? [steps] : [],
          priority: "medium" as const,
          projectId: currentProjectId!,
        };

        await new Promise((resolve) => setTimeout(resolve, 100));
        createMutation.mutate(newTest);
      }
    } catch (error) {
      console.error("Error parsing CSV:", error);
      alert("Error parsing CSV file. Please ensure it's properly formatted.");
    }
  }

  const handleCSVImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      importCSV(file);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  async function runTest(test: TestCase) {
    if (executionBusy) return;
    setActiveId(test.id);
    setProgress(0);
    setLiveTokens(0);
    stepCountsRef.current[test.id] = 0;
    patchTest(test.id, {
      status: "running",
      columnId: systemColId("running") ?? test.columnId,
      durationMs: undefined,
      failureReason: undefined,
    });
    pushMsg({
      role: "agent",
      kind: "action",
      testCode: test.code,
      content:
        test.mode === "api"
          ? `Starting **${test.code} · ${test.title}** — sending API assertions in the background.`
          : `Starting **${test.code} · ${test.title}** — launching Chromium in the background.`,
    });

    try {
      await api.startRun(test.id, selectedEnvironmentId);
    } catch (e) {
      const msg = (e as Error).message;
      pushMsg({ role: "system", content: `Run failed to start: ${msg}` });
      patchTest(test.id, { status: "failed", failureReason: msg });
      setActiveId(null);
      setProgress(0);
    }
  }

  async function runAll() {
    if (executionBusy || !currentProjectId) return;
    setRunning(true);
    const queue = tests.filter((t) => t.status === "queued");
    pushMsg({
      role: "system",
      content: `Run started — ${queue.length} test${queue.length === 1 ? "" : "s"} in queue.`,
    });
    try {
      await api.startAllRuns(currentProjectId, selectedEnvironmentId);
    } catch (e) {
      const msg = (e as Error).message;
      setRunning(false);
      pushMsg({ role: "system", content: `Run failed to start: ${msg}` });
    }
  }

  // Single-key board shortcuts: n = new test, g = generate suite, r = run all.
  // Ignored while typing or when a modal/spotlight is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable))
        return;
      if (spotlightOpen || modalOpen || genSuiteOpen || !currentProjectId) return;
      const key = e.key.toLowerCase();
      if (key === "n") {
        e.preventDefault();
        openAdd();
      } else if (key === "g") {
        e.preventDefault();
        setGenSuiteOpen(true);
      } else if (key === "r" && !executionBusy && counts.queued > 0) {
        e.preventDefault();
        runAll();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotlightOpen, modalOpen, genSuiteOpen, currentProjectId, executionBusy, counts.queued]);

  async function stop() {
    if (!currentProjectId && !activeId) return;
    setPendingQuestion(null);
    pushMsg({ role: "system", content: "Stopping the active run…" });
    try {
      await api.stopRuns(currentProjectId, activeId);
    } catch (e) {
      pushMsg({ role: "system", content: `Could not stop run: ${(e as Error).message}` });
    }
  }

  // Compact the conversation since the last compaction point: summarize those
  // turns and append a timeline marker. The visible transcript is preserved —
  // only what we SEND to the model is reduced (see the boundary logic in sendChat).
  async function runCompaction(auto: boolean) {
    if (compacting || !currentProjectId) return;
    const lastIdx = messages.map((m) => m.kind).lastIndexOf("compaction");
    const prevSummary = lastIdx >= 0 ? messages[lastIdx].content : "";
    const live = (lastIdx >= 0 ? messages.slice(lastIdx + 1) : messages).filter(
      (m) => m.role === "user" || m.role === "agent",
    );
    if (live.length < 2) return;
    setCompacting(true);
    try {
      const convo: Array<{ role: string; content: string }> = [];
      if (prevSummary)
        convo.push({ role: "user", content: `Earlier summary so far:\n${prevSummary}` });
      convo.push(...live.map((m) => ({ role: m.role, content: m.content })));
      const { summary } = await api.summarizeChat(currentProjectId, convo);
      const finalSummary = summary?.trim() || prevSummary;
      const tokensBefore =
        estTokens(prevSummary) + live.reduce((s, m) => s + estTokens(m.content), 0);
      pushMsg({
        role: "system",
        kind: "compaction",
        content: finalSummary,
        meta: {
          summarizedCount: live.length,
          tokensBefore,
          tokensAfter: estTokens(finalSummary),
        },
      });
      setContext(null);
    } catch (e) {
      if (!auto) pushMsg({ role: "system", content: `Compact failed: ${(e as Error).message}` });
    } finally {
      setCompacting(false);
    }
  }

  // Auto-compact once the live conversation (since the last marker) approaches
  // the context window — runs when idle, and shows up as a timeline marker too.
  useEffect(() => {
    if (chatBusy || compacting || !currentProjectId) return;
    const lastIdx = messages.map((m) => m.kind).lastIndexOf("compaction");
    const summaryText = lastIdx >= 0 ? messages[lastIdx].content : "";
    const live = (lastIdx >= 0 ? messages.slice(lastIdx + 1) : messages).filter(
      (m) => m.role === "user" || m.role === "agent",
    );
    if (live.length < 4) return;
    const tokens = estTokens(summaryText) + live.reduce((s, m) => s + estTokens(m.content), 0);
    const windowSize = context?.window ?? 8000;
    if (tokens > windowSize * 0.6) void runCompaction(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, chatBusy, compacting, context, currentProjectId]);

  async function sendChat(text: string) {
    if (!text || chatBusy || !currentProjectId) return;
    pushMsg({ role: "user", kind: "user", content: text });
    setChatBusy(true);
    setLiveTokens(0);

    // Boundary-aware history: send the summary from the last compaction marker
    // plus only the live turns after it (the full transcript stays on screen).
    const lastIdx = messages.map((m) => m.kind).lastIndexOf("compaction");
    const summaryText = lastIdx >= 0 ? messages[lastIdx].content : "";
    const live = (lastIdx >= 0 ? messages.slice(lastIdx + 1) : messages)
      .filter((m) => m.role === "user" || m.role === "agent")
      .slice(-50)
      .map((m) => ({ role: m.role, content: m.content }));
    const history: Array<{ role: string; content: string }> = [];
    if (summaryText) {
      history.push({ role: "user", content: `Summary of earlier conversation:\n${summaryText}` });
    }
    history.push(...live);
    history.push({ role: "user", content: text });

    const agentId = uid();
    setMessages((prev) => [
      ...prev,
      { id: agentId, role: "agent", kind: "thought", ts: Date.now(), content: "" },
    ]);
    let acc = "";

    try {
      await streamSSE<ChatEvent>(
        "/api/chat",
        { messages: history, projectId: currentProjectId, environmentId: selectedEnvironmentId },
        (ev) => {
          switch (ev.type) {
            case "token":
              acc += ev.content;
              updateMsg(agentId, acc);
              setLiveTokens((n) => n + 1); // ~one chunk ≈ one token (live proxy)
              break;
            case "usage":
              // Update the context meter from the prompt size of the last turn.
              if (ev.contextWindow) {
                setContext({ used: ev.promptTokens, window: ev.contextWindow });
              }
              break;
            case "compacted":
              // Compaction is now frontend-driven (boundary-aware + timeline marker),
              // so the backend safety-net event needs no UI here.
              break;
            case "tool_call":
              pushMsg({ role: "agent", kind: "action", content: `Running \`${ev.name}\`…` });
              break;
            case "tool_result":
              pushMsg({ role: "system", content: ev.summary });
              break;
            case "question":
              pushMsg({
                role: "agent",
                kind: "thought",
                testCode: ev.testCode,
                content: `❓ ${ev.question}`,
              });
              setPendingQuestion({ questionId: ev.questionId, question: ev.question });
              break;
            case "screenshot":
              pushMsg({ role: "agent", kind: "screenshot", content: ev.dataUrl });
              break;
            case "status":
              patchTest(ev.testId, { status: ev.status, columnId: systemColId(ev.status) });
              break;
            case "step":
              if (ev.status === "running") {
                pushMsg({ role: "agent", kind: "thought", content: `→ ${ev.label}` });
              }
              break;
            case "result":
              setPendingQuestion(null);
              patchTest(ev.testId, {
                status: ev.status,
                columnId: systemColId(ev.status),
                durationMs: ev.durationMs,
                failureReason: ev.failureReason,
              });
              if (ev.status === "passed" || ev.status === "failed") {
                const t = tests.find((x) => x.id === ev.testId);
                const code = t?.code ?? "Test";
                toast.push(
                  ev.status === "passed" ? `${code} passed` : `${code} failed`,
                  ev.status === "passed" ? "success" : "error",
                );
              }
              break;
            case "mutation":
              refetchTests();
              break;
            case "error":
              setPendingQuestion(null);
              pushMsg({ role: "system", content: `Agent error: ${ev.message}` });
              break;
          }
        },
      );
    } catch (e) {
      pushMsg({ role: "system", content: `Chat failed: ${(e as Error).message}` });
    } finally {
      if (!acc.trim()) setMessages((prev) => prev.filter((m) => m.id !== agentId));
      setChatBusy(false);
      refetchTests();
    }
  }

  // Route a chat submission: if the agent is parked on a question (e.g. asking
  // for login instructions), deliver the reply to that run; otherwise it's a
  // normal chat turn.
  async function handleSend(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (pendingQuestion) {
      const { questionId } = pendingQuestion;
      setPendingQuestion(null);
      pushMsg({ role: "user", kind: "user", content: trimmed });
      try {
        await api.answerQuestion(questionId, trimmed);
        pushMsg({ role: "agent", kind: "thought", content: "▶ Got it — resuming the run." });
      } catch (e) {
        pushMsg({
          role: "system",
          content: `Couldn't deliver your reply: ${(e as Error).message}`,
        });
      }
      return;
    }
    await sendChat(trimmed);
  }

  // A stable wrapper so the (memoised) composer never re-renders just because the
  // parent did — the live handler is read from a ref each call, so no staleness.
  const sendRef = useRef(handleSend);
  sendRef.current = handleSend;
  const stableSend = useCallback((text: string) => sendRef.current(text), []);

  async function handleDrop(col: BoardColumn) {
    if (!draggingId) return;
    const id = draggingId;
    setDraggingId(null);
    setDragOverCol(null);
    const t = tests.find((x) => x.id === id);
    if (!t || t.columnId === col.id) return;
    if (executionBusy && (t.status === "running" || col.systemKey === "running")) return;

    if (col.systemKey) {
      patchTest(id, {
        status: col.systemKey,
        columnId: col.id,
        ...(col.systemKey === "queued" ? { durationMs: undefined, failureReason: undefined } : {}),
      });
      try {
        if (col.systemKey === "queued") await api.resetTest(id);
        else await api.updateTest(id, { status: col.systemKey, columnId: col.id });
      } catch {
        refetchTests();
      }
    } else {
      // Custom column: move the card, keep its execution status/result badge.
      patchTest(id, { columnId: col.id });
      try {
        await api.updateTest(id, { columnId: col.id });
      } catch {
        refetchTests();
      }
    }
  }

  // Drop a card onto a category section: assign that category (and move it to the
  // section's column/status if it came from a different column).
  async function handleDropOnCategory(col: BoardColumn, categoryId: string | null) {
    if (!draggingId) return;
    const id = draggingId;
    setDraggingId(null);
    setDragOverCol(null);
    setDragOverCat(null);
    const t = tests.find((x) => x.id === id);
    if (!t) return;
    if (executionBusy && (t.status === "running" || col.systemKey === "running")) return;
    if (t.columnId === col.id && (t.categoryId ?? null) === categoryId) return;

    const movingColumn = t.columnId !== col.id && !!col.systemKey;
    patchTest(id, {
      categoryId,
      ...(movingColumn
        ? {
            status: col.systemKey ?? undefined,
            columnId: col.id,
            ...(col.systemKey === "queued"
              ? { durationMs: undefined, failureReason: undefined }
              : {}),
          }
        : {}),
    });
    try {
      if (movingColumn && col.systemKey === "queued") await api.resetTest(id);
      await api.updateTest(id, {
        categoryId,
        ...(movingColumn ? { status: col.systemKey ?? undefined, columnId: col.id } : {}),
      });
    } catch {
      refetchTests();
    }
  }

  const createCategoryMutation = useMutation({
    mutationFn: (name: string) => api.createCategory(currentProjectId!, name),
    onSuccess: () => refetchCategories(),
    onError: (e: Error) =>
      pushMsg({ role: "system", content: `Could not create category: ${e.message}` }),
  });
  const renameCategoryMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renameCategory(id, name),
    onSuccess: () => refetchCategories(),
  });
  const deleteCategoryMutation = useMutation({
    mutationFn: (id: string) => api.deleteCategory(id),
    onSuccess: () => {
      refetchCategories();
      refetchTests();
    },
  });

  // ---- Empty / loading states (no project selected) ----
  if (!projectsLoading && !currentProjectId) {
    return (
      <div className="flex h-screen w-screen overflow-hidden text-foreground">
        <AppSidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((v) => !v)} />
        <MobileSidebar open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 sm:gap-3 md:px-6">
            <button
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open menu"
              className="shrink-0 rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground md:hidden"
            >
              <Menu className="h-5 w-5" />
            </button>
            <ProjectSwitcher />
            <div className="ml-auto">
              <ThemeToggle />
            </div>
          </header>
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="max-w-sm rounded-lg border border-dashed border-border bg-card p-8 text-center">
              <FolderPlus className="mx-auto mb-3 h-8 w-8 text-signal" />
              <h2 className="font-display text-lg font-semibold">Create your first project</h2>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Projects hold their own board, environments and reports. Use the project menu in the
                top-left to create one and start adding tests.
              </p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden text-foreground">
      <AppSidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((v) => !v)} />
      <MobileSidebar open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 sm:gap-3 md:px-6">
          <button
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open menu"
            className="shrink-0 rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground md:hidden"
          >
            <Menu className="h-5 w-5" />
          </button>
          <ProjectSwitcher />
          <div className="hidden items-center gap-3 md:flex">
            {environments.length > 0 ? (
              <EnvironmentPicker
                environments={environments}
                value={selectedEnvironmentId}
                onChange={setSelectedEnvironmentId}
                onManage={() => navigate({ to: "/environments" })}
              />
            ) : (
              <button
                onClick={() => navigate({ to: "/environments" })}
                title="No environments yet — add one"
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-dashed border-border bg-background px-2.5 text-sm text-muted-foreground transition hover:border-primary/50 hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                Add environment
              </button>
            )}
          </div>

          <div className="flex min-w-0 flex-1 items-center justify-center">
            <button
              onClick={() => setSpotlightOpen(true)}
              title="Search (Ctrl/⌘ + K)"
              className="inline-flex h-8 w-full max-w-80 items-center justify-between gap-2 rounded-md border border-border bg-background px-3.5 text-sm text-muted-foreground transition hover:border-primary/50 hover:text-foreground sm:w-80"
            >
              <Search className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden sm:inline">Search tests…</span>
              <kbd className="hidden rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] sm:inline">
                ⌘K
              </kbd>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-2 xl:flex">
              <StatPill icon={CircleDashed} label="Queued" value={counts.queued} />
              <StatPill icon={Loader2} label="Running" value={counts.running} accent="running" />
              <StatPill icon={CheckCircle2} label="Passed" value={counts.passed} accent="success" />
              <StatPill icon={XCircle} label="Failed" value={counts.failed} accent="destructive" />
            </div>

            <div className="mx-1 hidden h-6 w-px bg-border xl:block" />

            {executionBusy ? (
              <button
                onClick={stop}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-destructive px-3 text-sm font-medium text-destructive-foreground transition hover:opacity-90"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
                Stop
              </button>
            ) : (
              <motion.button
                onClick={runAll}
                disabled={isLoading || counts.queued === 0 || executionBusy}
                whileHover={
                  reducedMotion
                    ? undefined
                    : {
                        filter: "brightness(1.08)",
                        boxShadow: "0 2px 10px -2px var(--accent-signal)",
                      }
                }
                whileTap={reducedMotion ? undefined : { scale: 0.97 }}
                transition={SPRING_HOVER}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-signal px-3.5 text-sm font-semibold text-signal-foreground disabled:opacity-40"
              >
                <Play className="h-3.5 w-3.5 fill-current" />
                Run all
              </motion.button>
            )}
            <ThemeToggle />
            {chatCollapsed && (
              <button
                onClick={() => setChatCollapsed(false)}
                title={agentStatus === "idle" ? "Show ZeroBug" : "ZeroBug is active"}
                className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition hover:text-foreground"
              >
                <MessageSquare className="h-4 w-4" strokeWidth={2.75} />
                {agentStatus !== "idle" && (
                  <span
                    className={cn(
                      "absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-card breathe",
                      agentStatus === "waiting" ? "bg-warning" : "bg-success",
                    )}
                  />
                )}
              </button>
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <section className="flex min-w-0 flex-1 flex-col">
            {currentProjectId && !isError && (
              <BoardFilterBar
                allTags={allTags}
                filters={filters}
                onChange={setFilters}
                total={tests.length}
                shown={filteredTests.length}
                onDeleteTag={(tag) => {
                  const ids = tests.filter((t) => t.tags?.includes(tag)).map((t) => t.id);
                  if (ids.length) runBulk({ action: "removeTag", ids, tag });
                }}
              />
            )}
            <div className="flex flex-1 gap-4 overflow-x-auto scrollbar-thin p-4 md:p-6">
              {isError && (
                <div className="m-auto max-w-sm rounded-xl border border-destructive/40 bg-destructive/5 p-5 text-center text-sm text-destructive">
                  <AlertTriangle className="mx-auto mb-2 h-5 w-5" />
                  Couldn't reach the backend.
                  <div className="mt-1 font-mono text-[11px] opacity-80">
                    {(error as Error)?.message}
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    Start it with <code>cd backend &amp;&amp; npm run dev</code>.
                  </div>
                </div>
              )}
              {!isError &&
                columns.map((col) => {
                  let colTests = filteredTests.filter((t) => t.columnId === col.id);
                  const isQueued = col.systemKey === "queued";
                  if (isQueued) {
                    const ts = (t: TestCase) => new Date(t.createdAt ?? 0).getTime();
                    colTests = [...colTests].sort((a, b) =>
                      queuedSort === "newest" ? ts(b) - ts(a) : ts(a) - ts(b),
                    );
                  }
                  // Master-checkbox state for this column (used by Queued).
                  const colIds = colTests.map((t) => t.id);
                  const allSelected =
                    colIds.length > 0 && colIds.every((id) => selectedIds.has(id));
                  const someSelected = !allSelected && colIds.some((id) => selectedIds.has(id));
                  const isOver = dragOverCol === col.id;

                  // Group tests by category inside Queued / Passed / Failed. Only
                  // when at least one category exists — otherwise render flat.
                  const grouped =
                    (col.systemKey === "queued" ||
                      col.systemKey === "passed" ||
                      col.systemKey === "failed") &&
                    categories.length > 0;
                  const byCat = new Map<string | null, TestCase[]>();
                  for (const t of colTests) {
                    const k = t.categoryId ?? null;
                    if (!byCat.has(k)) byCat.set(k, []);
                    byCat.get(k)!.push(t);
                  }
                  const sections = grouped
                    ? [
                        // Queued shows every category (empty ones are drop targets);
                        // Passed/Failed show only categories that have tests here.
                        ...categories
                          .map((c) => ({ id: c.id, name: c.name, tests: byCat.get(c.id) ?? [] }))
                          .filter((s) => isQueued || s.tests.length > 0),
                        ...(() => {
                          const uncat = byCat.get(null) ?? [];
                          return uncat.length > 0
                            ? [{ id: null as string | null, name: "Uncategorized", tests: uncat }]
                            : [];
                        })(),
                      ]
                    : [];

                  const renderCard = (t: TestCase) => (
                    <TestCard
                      key={t.id}
                      test={t}
                      status={t.status}
                      active={activeId === t.id}
                      batchRunning={running}
                      avgMs={avgDurationMs}
                      highlighted={highlightId === t.id}
                      selected={selectedIds.has(t.id)}
                      onSelect={() => toggleSelect(t.id)}
                      progress={activeId === t.id ? progress : 0}
                      onRun={() => !executionBusy && runTest(t)}
                      onEdit={() => openEdit(t)}
                      onDelete={() => deleteMutation.mutate(t.id)}
                      onImageClick={setLightbox}
                      onStop={stop}
                      disabled={executionBusy}
                      dragging={draggingId === t.id}
                      onDragStart={() => setDraggingId(t.id)}
                      onDragEnd={() => {
                        setDraggingId(null);
                        setDragOverCol(null);
                        setDragOverCat(null);
                      }}
                    />
                  );

                  return (
                    <div key={col.id} className="flex min-w-[28rem] flex-1 flex-col">
                      <div className="group/col mb-3 flex items-center justify-between px-1">
                        {renamingCol === col.id ? (
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (renameColValue.trim())
                                renameColumnMutation.mutate({
                                  id: col.id,
                                  title: renameColValue.trim(),
                                });
                            }}
                            className="flex flex-1 items-center gap-1"
                          >
                            <input
                              autoFocus
                              value={renameColValue}
                              onChange={(e) => setRenameColValue(e.target.value)}
                              className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary/60"
                            />
                            <button
                              type="submit"
                              className="rounded p-1 text-success hover:bg-accent"
                            >
                              <Check className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setRenamingCol(null)}
                              className="rounded p-1 text-muted-foreground hover:bg-accent"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </form>
                        ) : (
                          <>
                            <div className="flex items-center gap-2">
                              {isQueued && colTests.length > 0 && (
                                <button
                                  onClick={() => toggleSelectAll(colIds)}
                                  title={allSelected ? "Deselect all queued" : "Select all queued"}
                                  aria-label={
                                    allSelected ? "Deselect all queued" : "Select all queued"
                                  }
                                  className={cn(
                                    "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition",
                                    allSelected || someSelected
                                      ? "border-primary bg-primary text-primary-foreground"
                                      : "border-border text-transparent hover:border-primary/60",
                                  )}
                                >
                                  {allSelected ? (
                                    <Check className="h-3 w-3" />
                                  ) : someSelected ? (
                                    <Minus className="h-3 w-3" />
                                  ) : null}
                                </button>
                              )}
                              <ColumnDot systemKey={col.systemKey} />
                              <h2 className="font-display text-sm font-semibold uppercase tracking-[0.04em]">
                                {col.title}
                              </h2>
                              <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                                {colTests.length}
                              </span>
                            </div>
                            <div className="flex items-center gap-0.5">
                              {!col.systemKey && (
                                <>
                                  <button
                                    onClick={() => {
                                      setRenamingCol(col.id);
                                      setRenameColValue(col.title);
                                    }}
                                    title="Rename column"
                                    className="rounded-md p-1 text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover/col:opacity-100"
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    onClick={() => setConfirmColumn(col)}
                                    title="Delete column (its tests return to Queued)"
                                    className="rounded-md p-1 text-muted-foreground opacity-0 transition hover:bg-destructive hover:text-destructive-foreground group-hover/col:opacity-100"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </>
                              )}
                              {col.systemKey === "queued" && (
                                <>
                                  <button
                                    onClick={() =>
                                      setQueuedSort((s) => (s === "newest" ? "oldest" : "newest"))
                                    }
                                    title={
                                      queuedSort === "newest"
                                        ? "Sorted newest → oldest (click for oldest first)"
                                        : "Sorted oldest → newest (click for newest first)"
                                    }
                                    className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                                  >
                                    {queuedSort === "newest" ? (
                                      <ArrowDownWideNarrow className="h-4 w-4" />
                                    ) : (
                                      <ArrowUpNarrowWide className="h-4 w-4" />
                                    )}
                                  </button>
                                  <button
                                    onClick={() => setCatManagerOpen(true)}
                                    title="Manage categories"
                                    className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                                  >
                                    <Layers className="h-4 w-4" />
                                  </button>
                                  <button
                                    onClick={() => setGenSuiteOpen(true)}
                                    title="Generate a test suite with AI"
                                    className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                                  >
                                    <Sparkles className="h-4 w-4" />
                                  </button>
                                  <button
                                    onClick={() => fileInputRef.current?.click()}
                                    title="Import tests from CSV"
                                    className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                                  >
                                    <FolderPlus className="h-4 w-4" />
                                  </button>
                                  <button
                                    onClick={openAdd}
                                    title="Add test case"
                                    className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                                  >
                                    <Plus className="h-4 w-4" />
                                  </button>
                                </>
                              )}
                            </div>
                          </>
                        )}
                      </div>

                      <div
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                          if (dragOverCol !== col.id) setDragOverCol(col.id);
                        }}
                        onDragLeave={(e) => {
                          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                          setDragOverCol(null);
                        }}
                        onDrop={() => handleDrop(col)}
                        className={cn(
                          "flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-xl border-2 border-dashed p-2 scrollbar-thin transition",
                          // Running column reads as an amber "in progress" tray.
                          col.systemKey === "running" && "border-warning/70 bg-warning/[0.07]",
                          col.systemKey === "passed" && "border-success/70 bg-success/5",
                          col.systemKey === "failed" && "border-destructive/70 bg-destructive/5",
                          (col.systemKey === "queued" || !col.systemKey) &&
                            "border-muted-foreground/55 bg-muted/10",
                          isOver && "drop-target-active",
                        )}
                      >
                        {isLoading && col.systemKey === "queued" && (
                          <div className="flex flex-1 items-center justify-center gap-2 px-3 py-10 text-center text-xs text-muted-foreground">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Loading tests…
                          </div>
                        )}

                        {/* Grouped (by category) or flat rendering */}
                        {!isLoading && grouped ? (
                          sections.length === 0 ? (
                            <div className="flex flex-1 items-center justify-center px-3 py-10 text-center text-xs text-muted-foreground">
                              {col.systemKey ? COLUMN_HINT[col.systemKey] : "Drag cards here"}
                            </div>
                          ) : (
                            sections.map((section) => {
                              const key = `${col.id}::${section.id ?? "none"}`;
                              return (
                                <CategorySection
                                  key={key}
                                  name={section.name}
                                  count={section.tests.length}
                                  collapsed={collapsedCats.has(key)}
                                  onToggle={() => toggleCategoryCollapsed(key)}
                                  isDropTarget={dragOverCat === key}
                                  onDragOver={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    e.dataTransfer.dropEffect = "move";
                                    if (dragOverCat !== key) setDragOverCat(key);
                                  }}
                                  onDragLeave={(e) => {
                                    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                                    setDragOverCat(null);
                                  }}
                                  onDrop={(e) => {
                                    e.stopPropagation();
                                    handleDropOnCategory(col, section.id);
                                  }}
                                  onManage={
                                    section.id !== null ? () => setCatManagerOpen(true) : undefined
                                  }
                                >
                                  {section.tests.map(renderCard)}
                                </CategorySection>
                              );
                            })
                          )
                        ) : (
                          <>
                            {!isLoading && colTests.length === 0 && (
                              <div className="flex flex-1 items-center justify-center px-3 py-10 text-center text-xs text-muted-foreground">
                                {col.systemKey ? COLUMN_HINT[col.systemKey] : "Drag cards here"}
                              </div>
                            )}
                            {colTests.map(renderCard)}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}

              {/* Add-column affordance */}
              {!isError && currentProjectId && (
                <div className="flex w-56 shrink-0 flex-col">
                  <div className="mb-3 h-7" />
                  {addingColumn ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (newColumnName.trim()) createColumnMutation.mutate(newColumnName.trim());
                      }}
                      className="rounded-xl border-2 border-dashed border-muted-foreground/55 bg-muted/10 p-2"
                    >
                      <input
                        autoFocus
                        value={newColumnName}
                        onChange={(e) => setNewColumnName(e.target.value)}
                        onBlur={() => !newColumnName.trim() && setAddingColumn(false)}
                        placeholder="Column name"
                        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary/60"
                      />
                      <div className="mt-2 flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setAddingColumn(false)}
                          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={!newColumnName.trim()}
                          className="rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-40"
                        >
                          Add
                        </button>
                      </div>
                    </form>
                  ) : (
                    <button
                      onClick={() => setAddingColumn(true)}
                      className="flex items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-muted-foreground/55 bg-muted/10 py-3 text-sm text-muted-foreground transition hover:border-signal/60 hover:text-foreground"
                    >
                      <Plus className="h-4 w-4" />
                      Add column
                    </button>
                  )}
                </div>
              )}
            </div>
          </section>

          <AgentChatPanel
            collapsed={chatCollapsed}
            onToggle={() => setChatCollapsed((v) => !v)}
            messages={messages}
            agentStatus={agentStatus}
            chatBusy={chatBusy}
            liveTokens={liveTokens}
            context={context}
            compacting={compacting}
            onCompact={() => runCompaction(false)}
            pendingQuestion={pendingQuestion}
            onSend={stableSend}
            chatRef={chatRef}
            onImageClick={setLightbox}
            threads={chatThreads}
            activeThreadId={activeThreadId}
            onSelectThread={selectThread}
            onNewThread={newThread}
            onDeleteThread={deleteThread}
          />
        </div>
      </main>

      <AddTestModal
        open={modalOpen}
        initial={editing}
        categories={categories}
        onClose={closeModal}
        onSubmit={(input) => {
          if (editing) updateMutation.mutate({ id: editing.id, data: input });
          else if (currentProjectId)
            createMutation.mutate({ ...input, projectId: currentProjectId });
          closeModal();
        }}
      />

      <input
        ref={fileInputRef}
        type="file"
        accept=".csv"
        onChange={handleCSVImport}
        className="hidden"
      />

      {genSuiteOpen && currentProjectId && (
        <GenerateSuiteModal
          projectId={currentProjectId}
          categories={categories}
          onClose={() => setGenSuiteOpen(false)}
          onDone={(count) => {
            setGenSuiteOpen(false);
            refetchTests();
            refetchCategories();
            pushMsg({
              role: "system",
              content: `Generated ${count} test${count === 1 ? "" : "s"}.`,
            });
          }}
        />
      )}

      {catManagerOpen && (
        <CategoryManagerModal
          categories={categories}
          onClose={() => setCatManagerOpen(false)}
          onCreate={(name) => createCategoryMutation.mutate(name)}
          onRename={(id, name) => renameCategoryMutation.mutate({ id, name })}
          onDelete={(id) => deleteCategoryMutation.mutate(id)}
          creating={createCategoryMutation.isPending}
        />
      )}

      <ConfirmDialog
        open={!!confirmColumn}
        title="Delete column?"
        description={
          <>
            The <span className="font-medium text-foreground">{confirmColumn?.title}</span> column
            will be removed. Any tests in it are moved back to{" "}
            <span className="font-medium text-foreground">Queued</span> (they aren't deleted).
          </>
        }
        confirmLabel="Delete column"
        pending={deleteColumnMutation.isPending}
        onCancel={() => !deleteColumnMutation.isPending && setConfirmColumn(null)}
        onConfirm={() => confirmColumn && deleteColumnMutation.mutate(confirmColumn.id)}
      />

      <Lightbox src={lightbox} onClose={() => setLightbox(null)} />

      {visibleSelectedIds.length > 0 && (
        <BulkToolbar
          count={visibleSelectedIds.length}
          categories={categories}
          onRequeue={() => runBulk({ action: "requeue", ids: visibleSelectedIds })}
          onDelete={() => runBulk({ action: "delete", ids: visibleSelectedIds })}
          onAddTag={(tag) => runBulk({ action: "addTag", ids: visibleSelectedIds, tag })}
          onSetPriority={(priority) =>
            runBulk({ action: "setPriority", ids: visibleSelectedIds, priority })
          }
          onSetCategory={(categoryId) =>
            runBulk({ action: "setCategory", ids: visibleSelectedIds, categoryId })
          }
          onClear={clearSelection}
        />
      )}

      {spotlightOpen && (
        <Spotlight
          tests={tests}
          onClose={() => setSpotlightOpen(false)}
          onPickTest={pickTest}
          onFilterBoard={(text) => {
            setFilters((f) => ({ ...f, text }));
            setSpotlightOpen(false);
          }}
          actions={[
            {
              id: "run-all",
              label: "Run all queued tests",
              hint: `${counts.queued} queued`,
              disabled: executionBusy || counts.queued === 0,
              run: () => {
                setSpotlightOpen(false);
                runAll();
              },
            },
            {
              id: "go-report",
              label: "Go to Test report",
              run: () => navigate({ to: "/generated-specs" }),
            },
            {
              id: "go-stats",
              label: "Go to Statistics",
              run: () => navigate({ to: "/stats" }),
            },
            {
              id: "go-envs",
              label: "Go to Environments",
              run: () => navigate({ to: "/environments" }),
            },
            // Switch the run-target environment without leaving the board.
            ...environments.map((env) => ({
              id: `env-${env.id}`,
              label: `Target environment: ${env.name}`,
              hint: env.id === selectedEnvironmentId ? "current" : env.url,
              run: () => {
                setSelectedEnvironmentId(env.id);
                setSpotlightOpen(false);
              },
            })),
          ]}
        />
      )}
    </div>
  );
}

function BoardFilterBar({
  allTags,
  filters,
  onChange,
  total,
  shown,
  onDeleteTag,
}: {
  allTags: string[];
  filters: TestFilters;
  onChange: (f: TestFilters) => void;
  total: number;
  shown: number;
  onDeleteTag: (tag: string) => void;
}) {
  const [confirmTag, setConfirmTag] = useState<string | null>(null);
  const active =
    filters.text.trim() !== "" || filters.tags.length > 0 || filters.priorities.length > 0;
  const toggleTag = (tag: string) =>
    onChange({
      ...filters,
      tags: filters.tags.includes(tag)
        ? filters.tags.filter((t) => t !== tag)
        : [...filters.tags, tag],
    });
  const togglePriority = (p: string) =>
    onChange({
      ...filters,
      priorities: filters.priorities.includes(p)
        ? filters.priorities.filter((x) => x !== p)
        : [...filters.priorities, p],
    });

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card/40 px-4 py-2 md:px-6">
      {/* Text search lives in the ⌘K spotlight; if it set a text filter, surface
          it here as a clearable chip. */}
      {filters.text.trim() && (
        <span className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">
          “{filters.text.trim()}”
          <button
            type="button"
            onClick={() => onChange({ ...filters, text: "" })}
            title="Clear text filter"
            className="rounded-sm hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      )}
      <div className="flex items-center gap-1">
        {PRIORITY_ORDER.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => togglePriority(p)}
            className={cn(
              "rounded-md border px-2 py-1 text-[11px] font-medium capitalize transition",
              filters.priorities.includes(p)
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {p}
          </button>
        ))}
      </div>
      {allTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {allTags.map((tag) =>
            confirmTag === tag ? (
              <span
                key={tag}
                className="inline-flex items-center gap-1 rounded-full border border-destructive/50 bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive"
              >
                Delete #{tag}?
                <button
                  type="button"
                  onClick={() => {
                    onDeleteTag(tag);
                    setConfirmTag(null);
                  }}
                  className="rounded-sm font-semibold hover:underline"
                >
                  Yes
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmTag(null)}
                  className="rounded-sm text-muted-foreground hover:text-foreground"
                >
                  No
                </button>
              </span>
            ) : (
              <span
                key={tag}
                className={cn(
                  "group/tag inline-flex items-center rounded-full border pl-2 text-[11px] font-medium transition",
                  filters.tags.includes(tag)
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                <button type="button" onClick={() => toggleTag(tag)} className="py-0.5">
                  #{tag}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmTag(tag)}
                  title={`Delete tag "${tag}" from all tests`}
                  className="ml-0.5 rounded-full px-1 py-0.5 text-muted-foreground opacity-0 transition hover:text-destructive group-hover/tag:opacity-100"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ),
          )}
        </div>
      )}
      <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
        {active && (
          <span>
            {shown} / {total} shown
          </span>
        )}
        {active && (
          <button
            type="button"
            onClick={() => onChange({ text: "", tags: [], priorities: [] })}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-accent hover:text-foreground"
          >
            <X className="h-3 w-3" /> Clear
          </button>
        )}
      </div>
    </div>
  );
}

function BulkToolbar({
  count,
  categories,
  onRequeue,
  onDelete,
  onAddTag,
  onSetPriority,
  onSetCategory,
  onClear,
}: {
  count: number;
  categories: Category[];
  onRequeue: () => void;
  onDelete: () => void;
  onAddTag: (tag: string) => void;
  onSetPriority: (priority: TestCase["priority"]) => void;
  onSetCategory: (categoryId: string | null) => void;
  onClear: () => void;
}) {
  const [tag, setTag] = useState("");
  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 shadow-2xl animate-fade-in">
      <span className="text-sm font-medium">{count} selected</span>
      <div className="mx-1 h-5 w-px bg-border" />
      <button
        onClick={onRequeue}
        className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium hover:bg-accent"
      >
        <RotateCcw className="h-3 w-3" /> Requeue
      </button>
      <StyledSelect
        align="top"
        resetOnSelect
        placeholder="Priority…"
        title="Set priority of selected tests"
        className="w-28"
        onChange={(v) => onSetPriority(v as TestCase["priority"])}
        options={PRIORITY_ORDER.map((p) => ({ value: p, label: p }))}
      />
      <StyledSelect
        align="top"
        resetOnSelect
        placeholder="Category…"
        title="Move selected tests to a category"
        className="w-36"
        onChange={(v) => onSetCategory(v === "__none__" ? null : v)}
        options={[
          { value: "__none__", label: "Uncategorized" },
          ...categories.map((c) => ({ value: c.id, label: c.name })),
        ]}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (tag.trim()) {
            onAddTag(tag.trim());
            setTag("");
          }
        }}
        className="flex items-center gap-1"
      >
        <input
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder="add tag"
          className="h-7 w-24 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary/60"
        />
        <button
          type="submit"
          disabled={!tag.trim()}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-40"
        >
          <Plus className="h-3 w-3" /> Tag
        </button>
      </form>
      <button
        onClick={onDelete}
        className="inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/20"
      >
        <Trash2 className="h-3 w-3" /> Delete
      </button>
      <button
        onClick={onClear}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <X className="h-3 w-3" /> Clear
      </button>
    </div>
  );
}

function EnvironmentPicker({
  environments,
  value,
  onChange,
  onManage,
}: {
  environments: Environment[];
  value: string | null;
  onChange: (id: string) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Fall back to the active environment so the picker always reflects what a run
  // will actually target.
  const selected =
    environments.find((e) => e.id === value) ?? environments.find((e) => e.active) ?? null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Target environment for runs"
        className="flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-sm outline-none transition hover:border-primary/50 focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
      >
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            selected?.health === "degraded" ? "bg-warning" : "bg-success",
          )}
        />
        <span className="max-w-[140px] truncate">{selected ? selected.name : "Environment"}</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="absolute left-0 z-50 mt-1 w-64 overflow-hidden rounded-lg border border-border bg-card p-1 shadow-xl animate-fade-in">
          <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Target environment
          </div>
          <div className="max-h-72 overflow-y-auto scrollbar-thin">
            {environments.map((env) => (
              <button
                key={env.id}
                type="button"
                onClick={() => {
                  onChange(env.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition",
                  env.id === selected?.id
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/60",
                )}
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    env.health === "degraded" ? "bg-warning" : "bg-success",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate">{env.name}</span>
                    <span className="rounded bg-muted px-1 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
                      {env.kind}
                    </span>
                  </span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">
                    {env.url}
                  </span>
                </span>
                {env.id === selected?.id && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
            className="mt-1 flex w-full items-center gap-2 border-t border-border px-2 py-1.5 text-left text-xs text-muted-foreground transition hover:text-foreground"
          >
            <Plus className="h-3 w-3" /> Manage environments
          </button>
        </div>
      )}
    </div>
  );
}

function GenerateSuiteModal({
  projectId,
  categories,
  onClose,
  onDone,
}: {
  projectId: string;
  categories: Category[];
  onClose: () => void;
  onDone: (count: number) => void;
}) {
  const [prompt, setPrompt] = useState("");
  // Default: file the generated tests under a brand-new category.
  const [catChoice, setCatChoice] = useState<string>("__new__");
  const [newCatName, setNewCatName] = useState("Generated suite");
  const [explore, setExplore] = useState(false);
  const [images, setImages] = useState<string[]>([]);
  const [imgError, setImgError] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const [activity, setActivity] = useState<Array<{ id: number; event: GenerateSuiteEvent }>>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const activityRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const eventIdRef = useRef(0);
  const MAX_IMAGES = 5;
  const MAX_MB = 4;

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    activityRef.current?.scrollTo({
      top: activityRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [activity]);

  function closeModal() {
    abortRef.current?.abort();
    onClose();
  }

  async function generate() {
    if (generating) return;
    const cat =
      catChoice === "__new__"
        ? { categoryName: newCatName.trim() || "Generated suite" }
        : catChoice === "__none__"
          ? {}
          : { categoryId: catChoice };
    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setGenerationError("");
    setActivity([]);
    eventIdRef.current = 0;
    let created: number | null = null;

    try {
      await api.generateSuite(
        projectId,
        prompt.trim(),
        { ...cat, explore, images: images.length ? images : undefined },
        (event) => {
          setActivity((prev) => [...prev, { id: eventIdRef.current++, event }]);
          if (event.type === "done") created = event.created;
          if (event.type === "error") setGenerationError(event.message);
        },
        controller.signal,
      );
      if (created !== null) onDone(created);
    } catch (error) {
      if (!controller.signal.aborted) setGenerationError((error as Error).message);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setGenerating(false);
    }
  }

  async function addImages(files: FileList | File[]) {
    setImgError("");
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
    const room = MAX_IMAGES - images.length;
    const picked = arr.slice(0, Math.max(0, room));
    const tooBig = picked.filter((f) => f.size > MAX_MB * 1024 * 1024);
    if (tooBig.length) setImgError(`Some images exceed ${MAX_MB} MB and were skipped.`);
    const ok = picked.filter((f) => f.size <= MAX_MB * 1024 * 1024);
    const urls = await Promise.all(
      ok.map(
        (f) =>
          new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result as string);
            r.onerror = reject;
            r.readAsDataURL(f);
          }),
      ),
    );
    setImages((prev) => [...prev, ...urls].slice(0, MAX_IMAGES));
  }

  // With exploration or images, a prompt is optional.
  const canGenerate = Boolean(prompt.trim() || explore || images.length > 0) && !generating;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      <div className="absolute inset-0 bg-background/70 backdrop-blur-sm" onClick={closeModal} />
      <div className="relative max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-2xl animate-scale-in scrollbar-thin">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
              <Sparkles className="h-4 w-4 text-primary" /> Generate test suite
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Describe the app, attach reference screenshots, and/or let ZeroBug explore the live
              app first — then it proposes a detailed suite of UI tests.
            </p>
          </div>
          <button
            onClick={closeModal}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <textarea
          autoFocus
          rows={4}
          disabled={generating}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. A CRM at https://app.example.com — cover login, leads, reports, and settings. (Optional if exploring or attaching images.)"
          className="mt-4 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
        />

        {/* Explore the live app first */}
        <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-background/50 p-2.5">
          <input
            type="checkbox"
            checked={explore}
            disabled={generating}
            onChange={(e) => setExplore(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
          />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <Bot className="h-3.5 w-3.5 text-primary" />
              Explore the live app first
            </span>
            <span className="mt-0.5 block text-[11px] text-muted-foreground">
              ZeroBug opens the active environment, logs in (using its saved login), and looks
              through the pages/sections before writing page-specific tests. Slower, but far more
              accurate.
            </span>
          </span>
        </label>

        {/* Reference images */}
        <div className="mt-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              Reference images
              <span className="ml-1 font-normal opacity-60">
                (optional · {images.length}/{MAX_IMAGES})
              </span>
            </span>
            {images.length < MAX_IMAGES && (
              <button
                type="button"
                disabled={generating}
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
              >
                <ImagePlus className="h-3.5 w-3.5" /> Add image
              </button>
            )}
          </div>
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {images.map((src, i) => (
                <div
                  key={i}
                  className="group relative h-16 w-16 overflow-hidden rounded-lg border border-border"
                >
                  <img
                    src={src}
                    alt={`Reference ${i + 1}`}
                    className="h-full w-full object-cover"
                  />
                  <button
                    type="button"
                    disabled={generating}
                    onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                    className="absolute inset-0 flex items-center justify-center bg-background/70 opacity-0 transition group-hover:opacity-100"
                  >
                    <X className="h-4 w-4 text-destructive" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {imgError && <p className="mt-1 text-[11px] text-destructive">{imgError}</p>}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addImages(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        <div className="mt-3">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Category</span>
          <div className="flex items-center gap-2">
            <StyledSelect
              value={catChoice}
              onChange={setCatChoice}
              disabled={generating}
              className="w-48"
              options={[
                { value: "__new__", label: "＋ New category" },
                { value: "__none__", label: "Uncategorized" },
                ...categories.map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
            {catChoice === "__new__" && (
              <input
                value={newCatName}
                disabled={generating}
                onChange={(e) => setNewCatName(e.target.value)}
                placeholder="Category name"
                className="h-8 flex-1 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus:border-primary/60"
              />
            )}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            The generated tests are grouped under this category.
          </p>
        </div>

        {(generating || activity.length > 0) && (
          <div className="mt-4 overflow-hidden rounded-xl border border-border bg-background/70">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="flex items-center gap-1.5 text-xs font-medium">
                <Terminal className="h-3.5 w-3.5 text-primary" /> Live activity
              </span>
              {generating && (
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> ZeroBug is working
                </span>
              )}
            </div>
            <div
              ref={activityRef}
              className="max-h-72 space-y-2 overflow-y-auto p-3 scrollbar-thin"
            >
              {activity.length === 0 && (
                <p className="text-xs text-muted-foreground">Starting the agent…</p>
              )}
              {activity.map(({ id, event }) => {
                if (event.type === "screenshot") {
                  return (
                    <div
                      key={id}
                      className="overflow-hidden rounded-lg border border-border bg-card"
                    >
                      <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5 text-[11px] text-muted-foreground">
                        <Monitor className="h-3 w-3" /> Current browser view
                      </div>
                      <img
                        src={event.dataUrl}
                        alt="Live browser screenshot"
                        className="max-h-56 w-full object-contain"
                      />
                    </div>
                  );
                }
                if (event.type === "done") {
                  return (
                    <p key={id} className="flex items-center gap-2 text-xs text-success">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> Generated {event.created}{" "}
                      test{event.created === 1 ? "" : "s"}.
                    </p>
                  );
                }
                if (event.type === "error") {
                  return (
                    <p key={id} className="flex items-start gap-2 text-xs text-destructive">
                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {event.message}
                    </p>
                  );
                }
                return (
                  <p key={id} className="flex items-start gap-2 text-xs text-muted-foreground">
                    {event.type === "progress" ? (
                      <CircleDashed className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                    ) : (
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
                    )}
                    <span>{event.message}</span>
                  </p>
                );
              })}
            </div>
          </div>
        )}

        {generationError && <p className="mt-2 text-xs text-destructive">{generationError}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={closeModal}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-40"
          >
            {generating ? "Stop" : "Cancel"}
          </button>
          <button
            onClick={() => canGenerate && void generate()}
            disabled={!canGenerate}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
          >
            {generating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {generating ? (explore ? "Exploring & generating…" : "Generating…") : "Generate"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Create / rename / delete categories in one place (no inline inputs on the
// board — that was confusing when it appeared to leak into other columns).
function CategoryManagerModal({
  categories,
  onClose,
  onCreate,
  onRename,
  onDelete,
  creating,
}: {
  categories: Category[];
  onClose: () => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  creating: boolean;
}) {
  const [name, setName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      <div className="absolute inset-0 bg-background/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-2xl animate-scale-in">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
              <Layers className="h-4 w-4 text-primary" /> Categories
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Group tests into categories. Tests keep their category when they pass or fail.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) {
              onCreate(name.trim());
              setName("");
            }
          }}
          className="mt-4 flex items-center gap-2"
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New category name (e.g. Login flow)"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
          />
          <button
            type="submit"
            disabled={!name.trim() || creating}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </form>

        <div className="mt-4 max-h-72 space-y-1 overflow-y-auto scrollbar-thin">
          {categories.length === 0 && (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">
              No categories yet. Add one above.
            </p>
          )}
          {categories.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-2 py-1.5"
            >
              {renamingId === c.id ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (renameValue.trim()) {
                      onRename(c.id, renameValue.trim());
                      setRenamingId(null);
                    }
                  }}
                  className="flex flex-1 items-center gap-1"
                >
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => e.key === "Escape" && setRenamingId(null)}
                    className="w-full rounded border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary/60"
                  />
                  <button type="submit" className="rounded p-1 text-success hover:bg-accent">
                    <Check className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setRenamingId(null)}
                    className="rounded p-1 text-muted-foreground hover:bg-accent"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </form>
              ) : confirmDeleteId === c.id ? (
                <>
                  <span className="flex-1 truncate text-sm text-muted-foreground">
                    Delete “{c.name}”? Its tests become Uncategorized.
                  </span>
                  <button
                    onClick={() => {
                      onDelete(c.id);
                      setConfirmDeleteId(null);
                    }}
                    className="rounded-md bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground hover:opacity-90"
                  >
                    Delete
                  </button>
                  <button
                    onClick={() => setConfirmDeleteId(null)}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate text-sm text-foreground">{c.name}</span>
                  <button
                    onClick={() => {
                      setRenamingId(c.id);
                      setRenameValue(c.name);
                    }}
                    title="Rename"
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => setConfirmDeleteId(c.id)}
                    title="Delete category"
                    className="rounded p-1 text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatPill({
  label,
  value,
  accent,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  accent?: "success" | "destructive" | "running";
}) {
  // Flat readout: a small solid signal dot + label + mono numeral. No badge glow.
  const dot =
    accent === "success"
      ? "bg-success"
      : accent === "destructive"
        ? "bg-destructive"
        : accent === "running"
          ? "bg-running breathe"
          : "bg-warning";
  return (
    <div className="hidden h-9 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs md:inline-flex">
      {accent === "running" ? (
        <RunningPulse className="shrink-0" />
      ) : (
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
      )}
      <span className="text-muted-foreground">{label}</span>
      <CounterValue value={value} className="font-mono tabular-nums text-foreground" />
    </div>
  );
}

function ColumnDot({ systemKey }: { systemKey: ColumnSystemKey }) {
  if (systemKey === "running") return <RunningPulse className="shrink-0" />;
  const map: Record<string, string> = {
    queued: "bg-warning",
    passed: "bg-success",
    failed: "bg-destructive",
  };
  return (
    <span
      className={cn(
        "h-2 w-2 shrink-0 rounded-full",
        systemKey ? map[systemKey] : "bg-muted-foreground/60",
      )}
    />
  );
}

function TestCard({
  test,
  status,
  active,
  batchRunning,
  avgMs,
  highlighted,
  selected,
  onSelect,
  progress,
  onRun,
  onEdit,
  onDelete,
  onImageClick,
  onStop,
  disabled,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  test: TestCase;
  status: TestStatus;
  active: boolean;
  batchRunning: boolean;
  avgMs: number;
  highlighted: boolean;
  selected: boolean;
  onSelect: () => void;
  progress: number;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onImageClick: (src: string) => void;
  onStop: () => void;
  disabled: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  // "Running now" = this client is driving it (active), OR a batch is in progress
  // and this card is in the running state (parallel runs → many at once).
  // A "running" status with no live run AND no active batch is stale/orphaned
  // (e.g. the backend restarted mid-run) — keep it interactive so it's recoverable.
  const isRunning = active || (status === "running" && batchRunning);
  const stale = status === "running" && !active && !batchRunning;
  const isPassed = status === "passed";
  const isFailed = status === "failed";
  const isBlocked = status === "blocked";
  const isQueued = status === "queued";
  // Blocked tests never ran, so there's no Run to fetch — but they do carry a
  // failureReason ("Blocked: depends on …"), shown via the reason strip below.
  const hasRun = isPassed || isFailed;

  const [showResults, setShowResults] = useState(false);
  const { data: run, isLoading: runLoading } = useQuery({
    queryKey: ["run", test.id],
    queryFn: () => api.getLatestRun(test.id),
    enabled: showResults && hasRun,
  });
  const resetBaseline = useMutation({ mutationFn: () => api.resetBaseline(test.id) });

  // Cards are intentionally static (no Framer motion) — the status left-rail and a
  // simple hover border shift carry the state. Keeps the dense board calm.
  return (
    <div
      id={`test-card-${test.id}`}
      draggable={!isRunning}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", test.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={cn(
        // Flat panel, 1px hairline border, 3px status left-rail (the signal lamp).
        "group status-rail relative shrink-0 overflow-hidden rounded-md border border-border bg-card p-3 transition-[border-color,transform]",
        isRunning
          ? "rail-running"
          : isPassed
            ? "rail-passed"
            : isFailed
              ? "rail-failed"
              : isBlocked
                ? "rail-blocked"
                : "rail-queued",
        !isRunning && "cursor-grab active:cursor-grabbing",
        "hover:border-muted-foreground/40",
        // Drag lift: border-color shift + 2px translateY, no shadow blur.
        dragging && "-translate-y-0.5 border-signal opacity-90",
        selected && "ring-1 ring-signal",
        highlighted && "ring-1 ring-signal ring-offset-2 ring-offset-background",
      )}
    >
      {isRunning && (
        <div className="absolute inset-x-0 top-0 h-0.5 bg-muted">
          <div
            className="h-full bg-running transition-[width] duration-150 ease-linear"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      )}

      {stale && (
        <div className="mb-1.5 flex items-center gap-1 text-[10px] font-medium text-warning">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          Interrupted — re-run to recover
        </div>
      )}

      {isBlocked && (
        <div className="mb-1.5 flex items-center gap-1 text-[10px] font-medium text-warning">
          <Ban className="h-3 w-3 shrink-0" />
          Blocked — a dependency didn’t pass
        </div>
      )}

      <div className="mb-1.5 flex items-center gap-2">
        <button
          type="button"
          onClick={onSelect}
          title={selected ? "Deselect" : "Select for bulk action"}
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition",
            selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border text-transparent opacity-0 hover:text-muted-foreground group-hover:opacity-100",
          )}
        >
          <Check className="h-3 w-3" />
        </button>
        {isRunning && <span className="h-2 w-2 shrink-0 rounded-full bg-running" />}
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {test.code}
        </span>
        <span
          className={cn(
            "rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
            PRIORITY_STYLES[test.priority],
          )}
        >
          {test.priority}
        </span>
        {isFailed && (
          <span
            title={
              failureKind(test) === "Agent Bug"
                ? "Automation, agent, model, or runner-side failure"
                : "Likely product/application bug"
            }
            className={cn(
              "rounded-sm border px-1.5 py-0.5 text-[10px] font-medium",
              failureKind(test) === "Agent Bug"
                ? "border-warning/30 bg-warning/15 text-warning"
                : "border-destructive/30 bg-destructive/15 text-destructive",
            )}
          >
            {failureKind(test)}
          </span>
        )}
        {test.viewport === "mobile" && (
          <Smartphone className="h-3 w-3 text-muted-foreground" aria-label="Mobile viewport" />
        )}
        {test.viewport === "tablet" && (
          <Tablet className="h-3 w-3 text-muted-foreground" aria-label="Tablet viewport" />
        )}
        <div className="ml-auto flex items-center gap-1">
          {isQueued && (
            <button
              onClick={onEdit}
              disabled={disabled}
              title="Edit test"
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-30"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {!isRunning && (
            <button
              onClick={onDelete}
              disabled={disabled}
              title="Delete test"
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition hover:bg-destructive hover:text-destructive-foreground disabled:opacity-30"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={isRunning ? onStop : onRun}
            disabled={disabled && !isRunning}
            className={cn(
              "inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition",
              "hover:bg-primary hover:text-primary-foreground disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
              isRunning &&
                "bg-destructive/15 text-destructive hover:bg-destructive hover:text-destructive-foreground",
              stale && "bg-warning/15 text-warning",
              isPassed && "bg-success/15 text-success",
              isFailed && "bg-destructive/15 text-destructive",
            )}
            title={
              isRunning ? "Stop this run" : stale ? "Stuck — click to re-run" : "Run this test"
            }
          >
            {isRunning ? (
              <Square className="h-3.5 w-3.5 fill-current" />
            ) : stale ? (
              <RotateCcw className="h-3.5 w-3.5" />
            ) : isPassed ? (
              <Check className="h-3.5 w-3.5" />
            ) : isFailed ? (
              <X className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3 w-3 fill-current" />
            )}
          </button>
        </div>
      </div>

      <h3 className="text-sm font-medium leading-snug text-foreground">{test.title}</h3>
      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{test.description}</p>

      <div className="mt-2.5 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Hash className="h-3 w-3" />
          {test.suite}
        </span>
        <span className="inline-flex items-center gap-1 font-mono">
          <Clock className="h-3 w-3" />
          {test.durationMs
            ? `${(test.durationMs / 1000).toFixed(2)}s`
            : `~${(((avgMs || test.estMs) ?? 0) / 1000).toFixed(1)}s`}
        </span>
        <span className="inline-flex items-center gap-1">
          <RotateCcw className="h-3 w-3" />
          {test.maxRetries} retr{test.maxRetries === 1 ? "y" : "ies"}
        </span>
        {(() => {
          // Show the most relevant timestamp: when it ran (passed/failed) or was
          // added/started otherwise. Full created + updated times in the tooltip.
          const stamp = test.updatedAt || test.createdAt;
          const formatted = formatDateTime(stamp);
          if (!formatted) return null;
          const label = hasRun ? "Ran" : isRunning ? "Started" : "Added";
          return (
            <span
              className="inline-flex items-center gap-1"
              title={`Created: ${formatDateTimeFull(test.createdAt)}\nUpdated: ${formatDateTimeFull(test.updatedAt)}`}
            >
              <CalendarClock className="h-3 w-3" />
              {label} {formatted}
            </span>
          );
        })()}
        <span className="rounded bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {test.mode}
        </span>
        {test.dataRows && test.dataRows.length > 0 && (
          <span
            title={`Data-driven — runs ${test.dataRows.length} rows`}
            className="rounded bg-primary/10 px-1 py-0.5 text-[10px] font-medium text-primary"
          >
            data ×{test.dataRows.length}
          </span>
        )}
        {test.dependsOn && test.dependsOn.length > 0 && (
          <span
            title={`Runs after: ${test.dependsOn.join(", ")}`}
            className="rounded bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground"
          >
            ↳ {test.dependsOn.join(", ")}
          </span>
        )}
        {test.flaky && (
          <span
            title="Recent runs mix pass & fail"
            className="rounded bg-warning/15 px-1 py-0.5 text-[10px] font-medium text-warning"
          >
            flaky
          </span>
        )}
        {!!test.budgetMs &&
          test.budgetMs > 0 &&
          !!test.durationMs &&
          test.durationMs > test.budgetMs && (
            <span
              title={`Over budget: ${(test.durationMs / 1000).toFixed(1)}s > ${(test.budgetMs / 1000).toFixed(1)}s`}
              className="rounded bg-destructive/15 px-1 py-0.5 text-[10px] font-medium text-destructive"
            >
              over budget
            </span>
          )}
      </div>

      {test.tags && test.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {test.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}

      {isFailed && test.failureReason && (
        <div className="mt-2 flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-[11px] text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="font-mono leading-relaxed">{test.failureReason}</span>
        </div>
      )}

      {hasRun && (
        <div className="mt-2">
          <button
            onClick={() => setShowResults((v) => !v)}
            className="flex w-full items-center gap-1.5 rounded-md border border-border bg-background/60 px-2 py-1 text-[11px] font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <ListChecks className="h-3.5 w-3.5" />
            Results
            <ChevronDown
              className={cn(
                "ml-auto h-3.5 w-3.5 transition-transform",
                showResults && "rotate-180",
              )}
            />
          </button>

          {showResults && (
            <div className="mt-2 animate-fade-in space-y-2">
              {runLoading && (
                <div className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading results…
                </div>
              )}

              {!runLoading && !run && (
                <div className="px-1 text-[11px] text-muted-foreground">No results captured.</div>
              )}

              {!runLoading && run && (
                <>
                  <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background/60 px-2 py-1.5 text-[11px] text-muted-foreground">
                    <span>
                      Attempts used:{" "}
                      <span className="font-medium text-foreground">
                        {run.attempt}/{run.maxAttempts}
                      </span>
                    </span>
                    {run.output?.statusCode != null && (
                      <span>
                        HTTP{" "}
                        <span className="font-medium text-foreground">{run.output.statusCode}</span>
                      </span>
                    )}
                  </div>
                  <ul className="space-y-1">
                    {run.steps.map((s) => (
                      <li key={s.index} className="flex items-start gap-1.5 text-[11px]">
                        {s.status === "pass" ? (
                          <Check className="mt-0.5 h-3 w-3 shrink-0 text-success" />
                        ) : s.status === "fail" ? (
                          <X className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
                        ) : (
                          <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-running" />
                        )}
                        <span className="min-w-0">
                          <span className="text-foreground">{s.label}</span>
                          {s.detail && (
                            <span className="block break-words font-mono text-muted-foreground">
                              {s.detail}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>

                  {run.output?.result && (
                    <div className="rounded-md border border-success/40 bg-success/5 p-2">
                      <div className="text-[10px] font-medium uppercase tracking-wide text-success">
                        Result
                      </div>
                      <div className="mt-0.5 whitespace-pre-wrap break-words text-[12px] text-foreground">
                        {run.output.result}
                      </div>
                    </div>
                  )}

                  {run.output && (run.output.title || run.output.url || run.output.text) && (
                    <div className="rounded-md border border-border bg-background/60 p-2">
                      {run.output.title && (
                        <div className="text-[11px] font-medium text-foreground">
                          {run.output.title}
                        </div>
                      )}
                      {run.output.url && (
                        <a
                          href={run.output.url}
                          target="_blank"
                          rel="noreferrer"
                          className="block truncate font-mono text-[10px] text-primary hover:underline"
                        >
                          {run.output.url}
                        </a>
                      )}
                      {run.output.text && (
                        <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 font-mono text-[10px] leading-relaxed text-foreground scrollbar-thin">
                          {run.output.text}
                        </pre>
                      )}
                    </div>
                  )}

                  {run.output?.screenshot && (
                    <button
                      onClick={() => onImageClick(assetUrl(run.output!.screenshot!))}
                      title="Click to expand"
                      className="group relative block overflow-hidden rounded-md border border-border transition hover:border-primary/50"
                    >
                      <img
                        src={assetUrl(run.output.screenshot)}
                        alt="Final screenshot"
                        className="block w-full"
                      />
                      <span className="absolute inset-x-0 bottom-0 bg-background/70 px-2 py-0.5 text-center text-[10px] text-muted-foreground opacity-0 transition group-hover:opacity-100">
                        Final screenshot — click to expand
                      </span>
                    </button>
                  )}

                  {run.artifacts.length > 0 && (
                    <div className="rounded-md border border-border bg-background/60 p-2">
                      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Artifacts
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2">
                        {run.artifacts.map((artifact) => {
                          // A Playwright trace opens in the official viewer (scrub
                          // without downloading) instead of downloading the .zip.
                          const href =
                            artifact.kind === "trace"
                              ? `https://trace.playwright.dev/?trace=${encodeURIComponent(assetUrl(artifact.url))}`
                              : assetUrl(artifact.url);
                          return (
                            <a
                              key={artifact.url}
                              href={href}
                              target="_blank"
                              rel="noreferrer"
                              title={
                                artifact.kind === "trace"
                                  ? "Open in the Playwright Trace Viewer"
                                  : undefined
                              }
                              className="rounded-md border border-border px-2 py-1 text-[11px] text-primary transition hover:bg-accent"
                            >
                              {artifact.kind === "trace" ? `${artifact.label} ↗` : artifact.label}
                            </a>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {isFailed && <FailureForensics run={run} />}
                  {isFailed && <ExplainFailure test={test} />}

                  {test.assertionTypes?.includes("visual") && (
                    <button
                      type="button"
                      onClick={() => resetBaseline.mutate()}
                      disabled={resetBaseline.isPending || resetBaseline.isSuccess}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-60"
                    >
                      <RotateCcw className="h-3 w-3" />
                      {resetBaseline.isSuccess
                        ? "Baseline reset — recaptured next run"
                        : "Reset visual baseline"}
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Inline failure forensics: browser console errors + failed network requests +
// a link to the DOM-at-failure snapshot. Surfaces what used to be buried in
// downloadable artifacts so triage happens in the app.
function FailureForensics({ run }: { run: RunRecord }) {
  const consoleErrors = run.forensics?.console ?? [];
  const network = run.forensics?.network ?? [];
  const domUrl = run.forensics?.domSnapshotUrl;
  const [open, setOpen] = useState(false);

  if (!consoleErrors.length && !network.length && !domUrl) return null;

  return (
    <div className="rounded-md border border-border bg-background/60 p-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground transition hover:text-foreground"
      >
        <Terminal className="h-3 w-3" />
        Forensics
        <span className="font-normal normal-case">
          {consoleErrors.length} console · {network.length} network
        </span>
        <ChevronDown
          className={cn("ml-auto h-3.5 w-3.5 transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          {consoleErrors.length > 0 && (
            <div>
              <div className="mb-0.5 text-[10px] font-medium text-muted-foreground">
                Console errors
              </div>
              <ul className="space-y-0.5">
                {consoleErrors.map((c, i) => (
                  <li
                    key={i}
                    className="break-words rounded bg-destructive/10 px-1.5 py-1 font-mono text-[10px] text-destructive"
                  >
                    <span className="uppercase opacity-70">{c.type}</span> {c.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {network.length > 0 && (
            <div>
              <div className="mb-0.5 text-[10px] font-medium text-muted-foreground">
                Failed requests
              </div>
              <ul className="space-y-0.5">
                {network.map((n, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-1.5 break-all rounded bg-muted/50 px-1.5 py-1 font-mono text-[10px] text-foreground"
                  >
                    <span className="shrink-0 font-semibold text-destructive">
                      {n.status ?? n.failure ?? "ERR"}
                    </span>
                    <span className="shrink-0 text-muted-foreground">{n.method ?? "GET"}</span>
                    <span className="min-w-0 truncate">{n.url}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {domUrl && (
            <a
              href={assetUrl(domUrl)}
              target="_blank"
              rel="noreferrer"
              className="inline-block rounded-md border border-border px-2 py-1 text-[11px] text-primary transition hover:bg-accent"
            >
              View DOM snapshot ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// AI failure triage: one click asks the model for a plain-English root cause +
// a concrete fix, and (when the fix is a step change) offers to apply it.
function ExplainFailure({ test }: { test: TestCase }) {
  const queryClient = useQueryClient();
  const explain = useMutation({ mutationFn: () => api.explainFailure(test.id) });
  const applySteps = useMutation({
    mutationFn: (steps: string[]) => api.updateTest(test.id, { steps }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tests", test.projectId] }),
  });
  const result = explain.data;

  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-2">
      <button
        onClick={() => explain.mutate()}
        disabled={explain.isPending}
        className="flex w-full items-center gap-1.5 text-[11px] font-medium text-primary transition hover:text-primary/80 disabled:opacity-60"
      >
        {explain.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Wand2 className="h-3.5 w-3.5" />
        )}
        {explain.isPending ? "Analyzing failure…" : "Explain this failure"}
      </button>

      {explain.isError && (
        <p className="mt-1.5 text-[11px] text-destructive">
          Couldn't analyze — is the model reachable? {(explain.error as Error)?.message}
        </p>
      )}

      {result && (
        <div className="mt-2 space-y-2 text-[11px]">
          <div>
            <div className="font-medium text-foreground">Root cause</div>
            <p className="mt-0.5 leading-relaxed text-muted-foreground">{result.rootCause}</p>
          </div>
          <div>
            <div className="font-medium text-foreground">Suggested fix</div>
            <p className="mt-0.5 leading-relaxed text-muted-foreground">{result.suggestion}</p>
          </div>
          {result.proposedSteps.length > 0 && (
            <div className="rounded-md border border-border bg-background/60 p-2">
              <div className="font-medium text-foreground">Proposed steps</div>
              <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-muted-foreground">
                {result.proposedSteps.map((s, i) => (
                  <li key={i} className="break-words">
                    {s}
                  </li>
                ))}
              </ol>
              <button
                onClick={() => applySteps.mutate(result.proposedSteps)}
                disabled={applySteps.isPending || applySteps.isSuccess}
                className="mt-2 inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
              >
                {applySteps.isSuccess ? "Steps applied ✓" : "Apply these steps"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// A collapsible category group inside a board column. Also a drop target: a card
// dropped here is assigned to this category.
function CategorySection({
  name,
  count,
  collapsed,
  onToggle,
  isDropTarget,
  onDragOver,
  onDragLeave,
  onDrop,
  onManage,
  children,
}: {
  name: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  isDropTarget: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onManage?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        "rounded-lg border transition",
        isDropTarget
          ? "border-primary/60 bg-primary/10 drop-target-active"
          : "border-border/60 bg-background/30",
      )}
    >
      <div className="group/cat flex items-center gap-1 px-1.5 py-1.5">
        <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
              collapsed && "-rotate-90",
            )}
          />
          <span className="truncate text-xs font-semibold text-foreground">{name}</span>
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {count}
          </span>
        </button>
        {onManage && (
          <button
            onClick={onManage}
            title="Manage categories"
            className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover/cat:opacity-100"
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="flex flex-col gap-2 p-1.5 pt-0">
          {count === 0 ? (
            <div className="rounded-md border-2 border-dashed border-muted-foreground/50 px-2 py-3 text-center text-[10px] text-muted-foreground">
              Drop tests here
            </div>
          ) : (
            children
          )}
        </div>
      )}
    </div>
  );
}

type SpotlightAction = {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  run: () => void;
};

const STATUS_DOT: Record<TestStatus, string> = {
  queued: "bg-muted-foreground/40",
  running: "bg-running",
  passed: "bg-success",
  failed: "bg-destructive",
  blocked: "bg-warning",
};

// ⌘K command palette: fuzzy-search tests + quick actions, keyboard-driven.
function Spotlight({
  tests,
  actions,
  onPickTest,
  onFilterBoard,
  onClose,
}: {
  tests: TestCase[];
  actions: SpotlightAction[];
  onPickTest: (id: string) => void;
  onFilterBoard: (query: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const q = query.trim().toLowerCase();

  const items = useMemo(() => {
    const list: (
      | { type: "filter"; query: string; matches: number }
      | { type: "action"; action: SpotlightAction }
      | { type: "test"; test: TestCase }
    )[] = [];
    const matchedTests = tests.filter((t) =>
      q
        ? [t.code, t.title, t.suite, ...(t.tags ?? [])].some((f) =>
            String(f).toLowerCase().includes(q),
          )
        : true,
    );
    // First result: narrow the whole board to the query (what the old filter bar did).
    if (q) list.push({ type: "filter", query: query.trim(), matches: matchedTests.length });
    const matchedActions = q ? actions.filter((a) => a.label.toLowerCase().includes(q)) : actions;
    list.push(...matchedActions.map((action) => ({ type: "action" as const, action })));
    list.push(...matchedTests.slice(0, 50).map((test) => ({ type: "test" as const, test })));
    return list;
  }, [q, query, actions, tests]);

  useEffect(() => setActiveIndex(0), [q]);

  const choose = (item: (typeof items)[number]) => {
    if (item.type === "filter") onFilterBoard(item.query);
    else if (item.type === "action") {
      if (!item.action.disabled) item.action.run();
    } else {
      onPickTest(item.test.id);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh] animate-fade-in"
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, items.length - 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
        } else if (e.key === "Enter") {
          e.preventDefault();
          const it = items[activeIndex];
          if (it) choose(it);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="absolute inset-0 bg-background/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl animate-scale-in">
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tests, filter the board, or run an action…"
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            esc
          </kbd>
        </div>

        <div className="max-h-[50vh] overflow-y-auto scrollbar-thin p-1.5">
          {items.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">No matches.</div>
          )}
          {items.map((item, i) => {
            const isActive = i === activeIndex;
            const key =
              item.type === "filter"
                ? "filter"
                : item.type === "action"
                  ? `a-${item.action.id}`
                  : `t-${item.test.id}`;
            return (
              <button
                key={key}
                type="button"
                onMouseMove={() => setActiveIndex(i)}
                onClick={() => choose(item)}
                disabled={item.type === "action" && item.action.disabled}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition disabled:opacity-40",
                  isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                )}
              >
                {item.type === "filter" ? (
                  <>
                    <Search className="h-3.5 w-3.5 shrink-0 text-primary" />
                    <span className="flex-1">
                      Filter board to “<span className="font-medium">{item.query}</span>”
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {item.matches} match{item.matches === 1 ? "" : "es"}
                    </span>
                  </>
                ) : item.type === "action" ? (
                  <>
                    <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
                    <span className="flex-1">{item.action.label}</span>
                    {item.action.hint && (
                      <span className="text-[11px] text-muted-foreground">{item.action.hint}</span>
                    )}
                  </>
                ) : (
                  <>
                    <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      {item.test.code}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{item.test.title}</span>
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        STATUS_DOT[item.test.status],
                      )}
                    />
                    <span className="w-14 text-right text-[10px] uppercase text-muted-foreground">
                      {item.test.status}
                    </span>
                  </>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
