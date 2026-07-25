import { chatOnce } from "./ollama.js";

// Rough token estimate (no tokenizer dependency): ~4 chars/token + per-message
// overhead. Good enough to decide when to compact.
export function estimateTokens(messages) {
  let total = 0;
  for (const m of messages) {
    total += Math.ceil(String(m.content ?? "").length / 4) + 4;
  }
  return total;
}

/** Summarise a raw conversation transcript into terse bullets (for manual compaction). */
export async function summarizeConversation(messages, model) {
  const transcript = messages
    .map((m) => `${m.role}: ${String(m.content ?? "")}`)
    .join("\n")
    .slice(0, 16000);
  if (!transcript.trim()) return "";
  try {
    const summary = await chatOnce({
      model,
      messages: [
        {
          role: "system",
          content:
            "Summarise this conversation between a user and an AI testing agent into terse bullet points capturing decisions, tests created/queued/run, results, and any open threads. No preamble, no markdown headings.",
        },
        { role: "user", content: transcript },
      ],
    });
    return String(summary).trim();
  } catch {
    return "";
  }
}

/**
 * Auto-compact a chat history when it grows large: keep the system message and
 * the most recent turns verbatim, and replace the older middle with a concise
 * model-written summary. Returns the (possibly) compacted messages + metadata.
 *
 * @param {object} opts
 * @param {Array} opts.messages   full message list (system first)
 * @param {string} opts.model     model to summarise with
 * @param {number} opts.maxTokens compact when the estimate exceeds this
 * @param {number} [opts.keepRecent] recent messages kept verbatim
 */
export async function compactMessages({ messages, model, maxTokens, keepRecent = 8 }) {
  const tokensBefore = estimateTokens(messages);
  if (tokensBefore <= maxTokens) return { messages, compacted: false, tokensBefore };

  const hasSystem = messages[0]?.role === "system";
  const system = hasSystem ? messages[0] : null;
  const body = hasSystem ? messages.slice(1) : messages;
  if (body.length <= keepRecent) return { messages, compacted: false, tokensBefore };

  const recent = body.slice(-keepRecent);
  const older = body.slice(0, -keepRecent);
  const transcript = older
    .map((m) => `${m.role}: ${String(m.content ?? "")}`)
    .join("\n")
    .slice(0, 12000);

  let summary = "";
  try {
    summary = await chatOnce({
      model,
      messages: [
        {
          role: "system",
          content:
            "Summarise this conversation between a user and an AI testing agent into terse bullet points capturing decisions, tests created/queued/run, results, and any open threads. No preamble, no markdown headings.",
        },
        { role: "user", content: transcript },
      ],
    });
  } catch {
    // If summarisation fails, leave the history untouched rather than dropping it.
    return { messages, compacted: false, tokensBefore };
  }

  const summaryMsg = {
    role: "system",
    content: `Summary of earlier conversation:\n${String(summary).trim()}`,
  };
  const compactedMessages = [...(system ? [system] : []), summaryMsg, ...recent];
  return {
    messages: compactedMessages,
    compacted: true,
    summarizedCount: older.length,
    tokensBefore,
    tokensAfter: estimateTokens(compactedMessages),
  };
}
