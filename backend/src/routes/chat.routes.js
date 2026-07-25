import { Router } from "express";
import mongoose from "mongoose";
import { Test } from "../models/test.model.js";
import { ChatThread } from "../models/chat-thread.model.js";
import { openSse, sendEvent, closeSse } from "../lib/sse.js";
import { resolveAvailableModel, streamChat, effectiveContextWindow } from "../services/ollama.js";
import { toolDefinitions, executeTool } from "../services/agent-tools.js";
import { recordTokens, recordToolCall } from "../services/usage-service.js";
import { compactMessages, summarizeConversation } from "../services/chat-context.js";
import { config } from "../config.js";

export const chatRouter = Router();

// ── Persistent chat threads ───────────────────────────────────────────────────
// Conversations survive navigation/reloads and auto-clear 10 days after their
// last activity (TTL index on the model). Screenshots aren't persisted.

const MAX_THREAD_MESSAGES = 400;

// Coerce a client message into the stored shape, dropping heavy screenshot blobs.
function sanitizeMessages(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((m) => m && m.kind !== "screenshot")
    .slice(-MAX_THREAD_MESSAGES)
    .map((m) => ({
      mid: String(m.id ?? m.mid ?? ""),
      role: ["user", "agent", "system"].includes(m.role) ? m.role : "system",
      content: String(m.content ?? ""),
      kind: m.kind || undefined,
      ts: Number.isFinite(m.ts) ? m.ts : undefined,
      testCode: m.testCode || undefined,
      detail: m.detail || undefined,
      stepNo: Number.isFinite(m.stepNo) ? m.stepNo : undefined,
      stepStatus: m.stepStatus || undefined,
      meta: m.meta || undefined,
    }));
}

// List a project's threads (metadata only — no message bodies).
chatRouter.get("/threads", async (req, res, next) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: "projectId is required" });
    const threads = await ChatThread.aggregate([
      { $match: { projectId: new mongoose.Types.ObjectId(String(projectId)) } },
      { $sort: { updatedAt: -1 } },
      {
        $project: {
          title: 1,
          updatedAt: 1,
          createdAt: 1,
          messageCount: { $size: { $ifNull: ["$messages", []] } },
        },
      },
    ]);
    res.json(threads.map((t) => ({ ...t, id: String(t._id), _id: undefined })));
  } catch (err) {
    next(err);
  }
});

// Create a new (empty) thread.
chatRouter.post("/threads", async (req, res, next) => {
  try {
    const { projectId, title } = req.body ?? {};
    if (!projectId) return res.status(400).json({ error: "projectId is required" });
    const thread = await ChatThread.create({
      projectId,
      title: String(title ?? "New chat").slice(0, 120),
      messages: sanitizeMessages(req.body?.messages),
    });
    res.status(201).json(thread.toJSON());
  } catch (err) {
    next(err);
  }
});

// Full thread with messages.
chatRouter.get("/threads/:id", async (req, res, next) => {
  try {
    const thread = await ChatThread.findById(req.params.id);
    if (!thread) return res.status(404).json({ error: "Thread not found" });
    res.json(thread.toJSON());
  } catch (err) {
    next(err);
  }
});

// Save a thread's messages (and optionally rename it).
chatRouter.put("/threads/:id", async (req, res, next) => {
  try {
    const update = {};
    if ("messages" in (req.body ?? {})) update.messages = sanitizeMessages(req.body.messages);
    if (typeof req.body?.title === "string") update.title = req.body.title.slice(0, 120);
    const thread = await ChatThread.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!thread) return res.status(404).json({ error: "Thread not found" });
    res.json(thread.toJSON());
  } catch (err) {
    next(err);
  }
});

// Delete a thread.
chatRouter.delete("/threads/:id", async (req, res, next) => {
  try {
    const result = await ChatThread.deleteOne({ _id: req.params.id });
    if (!result.deletedCount) return res.status(404).json({ error: "Thread not found" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Manual "compact now": summarise a conversation transcript into bullets.
chatRouter.post("/summarize", async (req, res, next) => {
  try {
    const msgs = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const model = await resolveAvailableModel();
    res.json({ summary: await summarizeConversation(msgs, model) });
  } catch (err) {
    next(err);
  }
});

const MAX_TOOL_ROUNDS = 4;

// Only inline a bounded sample of tests in the system prompt — listing every
// test (projects can have hundreds) would blow the context window on every turn.
const MAX_LISTED_TESTS = 40;
const STATUS_RANK = { failed: 0, running: 1, queued: 2, passed: 3 };

async function buildContext(projectId) {
  const tests = await Test.find({ projectId }).sort({ createdAt: 1 }).lean();
  const counts = { queued: 0, running: 0, passed: 0, failed: 0 };
  for (const t of tests) counts[t.status] = (counts[t.status] ?? 0) + 1;

  // Surface the most actionable tests first (failed → running → queued → passed).
  const shown = [...tests]
    .sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9))
    .slice(0, MAX_LISTED_TESTS);
  const lines = shown
    .map(
      (t) =>
        `- ${t.code} [${t.status}] "${t.title}" (suite: ${t.suite}, priority: ${t.priority})` +
        (t.failureReason ? ` — failed: ${t.failureReason}` : ""),
    )
    .join("\n");
  const more =
    tests.length > MAX_LISTED_TESTS
      ? `\n…and ${tests.length - MAX_LISTED_TESTS} more (ask or use the board to see them).`
      : "";

  return `You are ZeroBug, an AI testing agent embedded in a Playwright test runner.
You help the user manage and run end-to-end tests. Be concise and friendly.
You can call tools to create, queue, and run tests. When the user asks to run
something, use the tools rather than describing the steps.

Current board (${counts.queued} queued, ${counts.running} running, ${counts.passed} passed, ${counts.failed} failed)${
    tests.length > MAX_LISTED_TESTS ? ` — showing ${MAX_LISTED_TESTS} most actionable` : ""
  }:
${lines || "(no tests yet)"}${more}`;
}

chatRouter.post("/", async (req, res) => {
  openSse(res);
  let aborted = false;
  const abort = new AbortController();
  // NB: listen on `res`, not `req` — the request's "close" fires as soon as the
  // body is read, which would suppress the whole stream.
  res.on("close", () => {
    aborted = true;
    abort.abort(); // unblock any question the agent is parked on
  });
  const emit = (event) => {
    if (!aborted) sendEvent(res, event.type, event);
  };

  try {
    const projectId = req.body?.projectId;
    if (!projectId) {
      emit({ type: "error", message: "projectId is required" });
      closeSse(res);
      return;
    }
    const history = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const system = await buildContext(projectId);
    const model = await resolveAvailableModel();
    let messages = [
      { role: "system", content: system },
      ...history.map((m) => ({
        role: m.role === "agent" ? "assistant" : m.role,
        content: m.content,
      })),
    ];

    // Auto-compact: if the conversation is large, summarise older turns so the
    // context stays within the window (memory preserved, tokens bounded).
    const compaction = await compactMessages({
      messages,
      model,
      maxTokens: Math.round(effectiveContextWindow() * 0.6),
      keepRecent: 8,
    });
    messages = compaction.messages;
    if (compaction.compacted) {
      emit({
        type: "compacted",
        summarizedCount: compaction.summarizedCount,
        tokensBefore: compaction.tokensBefore,
        tokensAfter: compaction.tokensAfter,
      });
    }

    for (let round = 0; round < MAX_TOOL_ROUNDS && !aborted; round++) {
      const toolCalls = [];
      let assistantText = "";

      for await (const ev of streamChat({ messages, tools: toolDefinitions, model })) {
        if (aborted) break;
        if (ev.type === "token") {
          assistantText += ev.content;
          emit({ type: "token", content: ev.content });
        } else if (ev.type === "tool_call") {
          toolCalls.push({ name: ev.name, args: ev.args });
        } else if (ev.type === "usage") {
          recordTokens(projectId, ev);
          emit({
            type: "usage",
            promptTokens: ev.promptTokens,
            responseTokens: ev.responseTokens,
            contextWindow: ev.contextWindow,
          });
        }
      }

      if (!toolCalls.length) break; // model produced a normal answer; we're done

      // Record the assistant's tool-call turn, then execute each tool.
      messages.push({
        role: "assistant",
        content: assistantText,
        tool_calls: toolCalls.map((c) => ({
          function: { name: c.name, arguments: c.args },
        })),
      });

      for (const call of toolCalls) {
        if (aborted) break;
        recordToolCall(projectId, call.name);
        emit({ type: "tool_call", name: call.name, args: call.args });
        let summary;
        try {
          summary = await executeTool(call.name, call.args, projectId, emit, abort.signal);
        } catch (err) {
          summary = `Tool ${call.name} failed: ${err.message}`;
        }
        emit({ type: "tool_result", name: call.name, summary });
        messages.push({ role: "tool", content: summary });
      }
    }
  } catch (err) {
    emit({ type: "error", message: err.message });
  } finally {
    closeSse(res);
  }
});
