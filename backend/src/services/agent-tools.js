import { Test } from "../models/test.model.js";
import { executeTestRun } from "./run-service.js";
import { systemColumn } from "./project-service.js";

// Ollama tool definitions handed to the chat model.
export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "create_test",
      description: "Create a new end-to-end test case and add it to the queue.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short test title" },
          suite: { type: "string", description: "Suite/category name" },
          priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
          description: { type: "string" },
          steps: { type: "array", items: { type: "string" } },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "queue_test",
      description: "Move a test back to the queued column by its code (e.g. AUTH-01) or title.",
      parameters: {
        type: "object",
        properties: { code: { type: "string" }, title: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_test",
      description: "Run a single test with Playwright by its code or title.",
      parameters: {
        type: "object",
        properties: { code: { type: "string" }, title: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_all",
      description: "Run every queued test with Playwright, one after another.",
      parameters: { type: "object", properties: {} },
    },
  },
];

async function findTest(projectId, { code, title }) {
  if (code) {
    const byCode = await Test.findOne({ projectId, code: new RegExp(`^${escapeRegex(code)}$`, "i") });
    if (byCode) return byCode;
  }
  if (title) {
    return Test.findOne({ projectId, title: new RegExp(escapeRegex(title), "i") });
  }
  return null;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function genCode(suite) {
  const prefix = (suite || "TEST").slice(0, 4).toUpperCase();
  return `${prefix}-${Math.floor(Math.random() * 90 + 10)}`;
}

/**
 * Execute a tool call. `emit` streams run events (step/status/result) to the client.
 * Returns a short text summary used as the tool message content for the next turn.
 */
export async function executeTool(name, args = {}, projectId, emit = () => {}, signal) {
  switch (name) {
    case "create_test": {
      const steps = Array.isArray(args.steps) ? args.steps.filter(Boolean) : undefined;
      const queued = await systemColumn(projectId, "queued");
      const test = await Test.create({
        projectId,
        columnId: queued?._id,
        code: genCode(args.suite),
        title: args.title,
        description: args.description || "Created by ZeroBug agent.",
        suite: args.suite || "General",
        priority: args.priority || "medium",
        estMs: 1800 + (steps?.length ?? 0) * 400,
        steps: steps && steps.length ? steps : undefined,
        status: "queued",
      });
      emit({ type: "mutation", entity: "test" });
      return `Created ${test.code} "${test.title}" and queued it.`;
    }
    case "queue_test": {
      const test = await findTest(projectId, args);
      if (!test) return `No matching test found.`;
      const queued = await systemColumn(projectId, "queued");
      test.status = "queued";
      test.columnId = queued?._id;
      test.durationMs = undefined;
      test.failureReason = undefined;
      await test.save();
      emit({ type: "mutation", entity: "test" });
      return `Queued ${test.code} "${test.title}".`;
    }
    case "run_test": {
      const test = await findTest(projectId, args);
      if (!test) return `No matching test found.`;
      const { result } = await executeTestRun({ testId: test.id, onEvent: emit, signal });
      return `${test.code} ${result.status}${result.failureReason ? `: ${result.failureReason}` : ""}.`;
    }
    case "run_all": {
      const queued = await Test.find({ projectId, status: "queued" }).sort({ createdAt: 1 });
      if (!queued.length) return `No queued tests to run.`;
      const outcomes = [];
      for (const t of queued) {
        const { result } = await executeTestRun({ testId: t.id, onEvent: emit, signal });
        outcomes.push(`${t.code}: ${result.status}`);
      }
      return `Ran ${queued.length} tests — ${outcomes.join(", ")}.`;
    }
    default:
      return `Unknown tool "${name}".`;
  }
}
