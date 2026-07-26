import { config } from "../config.js";

// Thin wrapper over the Ollama REST API (native fetch, Node 18+).
// Docs: https://github.com/ollama/ollama/blob/main/docs/api.md

function stripCodeFences(content) {
  return String(content ?? "")
    .replace(/```[a-z]*\n?/gi, "") // strip fences anywhere, not just the ends
    .trim();
}

// Extract the first balanced {...} object. If the model truncated the output
// (unclosed string/braces), close them so it can still be parsed.
function extractJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return text;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // Truncated \u2014 repair by closing the dangling string and braces.
  let tail = text.slice(start);
  if (inString) tail += '"';
  if (depth > 0) tail += "}".repeat(depth);
  return tail;
}

// Escape raw newlines/tabs/carriage-returns that appear INSIDE JSON string
// values \u2014 a very common reason small models produce unparseable JSON (e.g. a
// multi-line "thought").
function escapeControlCharsInStrings(text) {
  let out = "";
  let inString = false;
  let escape = false;
  for (const ch of text) {
    if (inString) {
      if (escape) {
        out += ch;
        escape = false;
      } else if (ch === "\\") {
        out += ch;
        escape = true;
      } else if (ch === '"') {
        out += ch;
        inString = false;
      } else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

function repairJson(text) {
  return text
    .replace(/\/\/[^\n]*/g, "") // line comments
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/[\u201C\u201D]/g, '"') // smart double quotes
    .replace(/[\u2018\u2019]/g, "'") // smart single quotes
    .replace(/,\s*([}\]])/g, "$1") // trailing commas
    .trim();
}

// Quote bare object keys: {action: "click"} -> {"action": "click"}.
function quoteKeys(text) {
  return text.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
}

export function parseJsonLoose(content) {
  const cleaned = stripCodeFences(content);
  const obj = extractJsonObject(cleaned);
  // Progressively more aggressive repairs \u2014 first one that parses wins.
  const candidates = [
    cleaned,
    obj,
    repairJson(obj),
    escapeControlCharsInStrings(repairJson(obj)),
    quoteKeys(escapeControlCharsInStrings(repairJson(obj))),
    // Last resort: collapse all newlines (fixes stray unescaped ones in strings).
    quoteKeys(repairJson(obj)).replace(/[\r\n]+/g, " "),
  ]
    .map((candidate) => candidate.trim())
    .filter(Boolean);

  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      return JSON.parse(candidate);
    } catch {
      // keep trying repaired candidates
    }
  }
  throw new Error("Could not repair model JSON.");
}

export async function listOllamaModels() {
  try {
    const res = await fetch(`${config.ollamaBaseUrl}/api/tags`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json.models)
      ? json.models.map((model) => ({
          name: model.name,
          size: model.size,
          modifiedAt: model.modified_at,
        }))
      : [];
  } catch {
    return [];
  }
}

const FALLBACK_ANTHROPIC_MODELS = [
  { name: "claude-3-5-haiku-latest" },
  { name: "claude-3-5-sonnet-latest" },
  { name: "claude-3-7-sonnet-latest" },
  { name: "claude-sonnet-4-5" },
];

function anthropicHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    "x-api-key": config.anthropicApiKey,
    "anthropic-version": config.anthropicVersion,
    ...extra,
  };
}

function anthropicEndpoint(path) {
  return `${config.anthropicBaseUrl}${path}`;
}

function defaultChatModel() {
  return config.modelProvider === "anthropic" ? config.anthropicChatModel : config.ollamaChatModel;
}

function defaultCodeModel() {
  return config.modelProvider === "anthropic" ? config.anthropicCodeModel : config.ollamaCodeModel;
}

// The usable context window (tokens) for the active provider — drives the chat
// token meter and the auto-compaction threshold. Claude models have a large
// (~200k) window, so reporting Ollama's num_ctx there would compact far too soon.
export function effectiveContextWindow() {
  return config.modelProvider === "anthropic" ? 200000 : config.ollamaNumCtx;
}

// Split a `data:<mime>;base64,<data>` URL (or bare base64) into its parts.
function parseDataUrl(src) {
  const m = /^data:([^;,]+)(?:;[^,]*)?,(.*)$/s.exec(String(src || ""));
  if (m) return { media: m[1] || "image/jpeg", data: m[2] };
  return { media: "image/jpeg", data: String(src || "") };
}

// Ollama's /api/chat wants bare base64 in `images`; strip any data: prefix.
function stripImagesForOllama(messages) {
  return (messages || []).map((msg) => {
    if (!msg.images || !msg.images.length) return msg;
    return {
      ...msg,
      images: msg.images.map((src) => {
        const m = /^data:[^,]+,(.*)$/s.exec(String(src || ""));
        return m ? m[1] : String(src || "");
      }),
    };
  });
}

// Convert our internal messages (system + user/assistant, optional `images`) into
// Anthropic's shape: a top-level `system` string + a messages array whose content
// is text OR an array of text/image blocks (so screenshots reach Claude too).
function splitSystem(messages = []) {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .filter(Boolean)
    .join("\n\n");
  const rest = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const text =
      message.role === "tool"
        ? `Tool result: ${String(message.content ?? "")}`
        : String(message.content ?? "");
    const images = Array.isArray(message.images) ? message.images : [];

    let content;
    if (images.length) {
      content = [];
      if (text) content.push({ type: "text", text });
      for (const src of images) {
        const { media, data } = parseDataUrl(src);
        content.push({ type: "image", source: { type: "base64", media_type: media, data } });
      }
    } else {
      content = text;
    }

    const prev = rest[rest.length - 1];
    // Only merge plain-text turns of the same role; never merge image content.
    if (
      prev &&
      prev.role === role &&
      typeof prev.content === "string" &&
      typeof content === "string"
    ) {
      prev.content += `\n\n${content}`;
    } else {
      rest.push({ role, content });
    }
  }
  return { system, messages: rest.length ? rest : [{ role: "user", content: "" }] };
}

function toAnthropicTools(tools) {
  return (tools || []).map((tool) => ({
    name: tool.function?.name,
    description: tool.function?.description,
    input_schema: tool.function?.parameters ?? { type: "object", properties: {} },
  }));
}

export async function listAnthropicModels() {
  if (!config.anthropicApiKey) return FALLBACK_ANTHROPIC_MODELS;
  try {
    const res = await fetch(anthropicEndpoint("/v1/models"), {
      headers: {
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": config.anthropicVersion,
      },
      signal: AbortSignal.timeout(3500),
    });
    if (!res.ok) return FALLBACK_ANTHROPIC_MODELS;
    const json = await res.json();
    return Array.isArray(json.data)
      ? json.data.map((model) => ({
          name: model.id,
          modifiedAt: model.created_at,
        }))
      : FALLBACK_ANTHROPIC_MODELS;
  } catch {
    return FALLBACK_ANTHROPIC_MODELS;
  }
}

export async function listModels() {
  return config.modelProvider === "anthropic" ? listAnthropicModels() : listOllamaModels();
}

export async function anthropicReachable() {
  if (!config.anthropicApiKey) return false;
  try {
    const res = await fetch(anthropicEndpoint("/v1/models"), {
      headers: {
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": config.anthropicVersion,
      },
      signal: AbortSignal.timeout(3500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ollamaReachable() {
  if (config.modelProvider === "anthropic") return anthropicReachable();
  return (await listOllamaModels()).length > 0;
}

export async function resolveAvailableModel(preferred, fallback = config.ollamaCodeModel) {
  if (config.modelProvider === "anthropic") {
    const requested = String(preferred ?? "").trim();
    const anthropicFallback =
      !fallback || fallback === config.ollamaCodeModel ? config.anthropicCodeModel : fallback;
    const models = await listAnthropicModels();
    const names = new Set(models.map((model) => model.name));
    if (requested && names.has(requested)) return requested;
    if (anthropicFallback && names.has(anthropicFallback)) return anthropicFallback;
    return requested || anthropicFallback || models[0]?.name || "claude-3-5-sonnet-latest";
  }
  const requested = String(preferred ?? "").trim();
  fallback =
    !fallback || fallback === config.anthropicCodeModel ? config.ollamaCodeModel : fallback;
  const models = await listOllamaModels();
  if (!models.length) return requested || fallback;
  const names = new Set(models.map((model) => model.name));
  if (requested && names.has(requested)) return requested;
  if (fallback && names.has(fallback)) return fallback;
  return models[0].name;
}

/**
 * Stream a chat completion. Yields incremental events:
 *   { type: "token", content }       - assistant text delta
 *   { type: "tool_call", name, args } - a tool the model wants to call
 *   { type: "done", message }         - final assistant message object
 *
 * `tools` is an optional array of Ollama tool definitions.
 */
export async function* streamChat({ messages, tools, model }) {
  if (config.modelProvider === "anthropic") {
    if (!config.anthropicApiKey) throw new Error("Anthropic API key is not configured.");
    const { system, messages: anthropicMessages } = splitSystem(messages);
    const res = await fetch(anthropicEndpoint("/v1/messages"), {
      method: "POST",
      headers: anthropicHeaders(),
      body: JSON.stringify({
        model: model || defaultChatModel(),
        system: system || undefined,
        messages: anthropicMessages,
        tools: tools && tools.length ? toAnthropicTools(tools) : undefined,
        max_tokens: 2048,
        stream: true,
      }),
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`Anthropic chat failed (${res.status}): ${text}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentTool = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
        if (!dataLine) continue;
        const jsonText = dataLine.slice(5).trim();
        if (!jsonText || jsonText === "[DONE]") continue;
        let ev;
        try {
          ev = JSON.parse(jsonText);
        } catch {
          continue;
        }
        if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
          currentTool = { name: ev.content_block.name, argsText: "" };
        } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          yield { type: "token", content: ev.delta.text || "" };
        } else if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") {
          if (currentTool) currentTool.argsText += ev.delta.partial_json || "";
        } else if (ev.type === "content_block_stop" && currentTool) {
          let args = {};
          try {
            args = currentTool.argsText ? JSON.parse(currentTool.argsText) : {};
          } catch {
            args = {};
          }
          yield { type: "tool_call", name: currentTool.name, args };
          currentTool = null;
        } else if (ev.type === "message_delta" && ev.usage) {
          yield {
            type: "usage",
            promptTokens: ev.usage.input_tokens ?? 0,
            responseTokens: ev.usage.output_tokens ?? 0,
            contextWindow: effectiveContextWindow(),
          };
        }
      }
    }
    return;
  }

  const res = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model || config.ollamaChatModel,
      messages: stripImagesForOllama(messages),
      tools: tools && tools.length ? tools : undefined,
      stream: true,
      options: { num_ctx: config.ollamaNumCtx },
      // Disable hidden "thinking" traces (qwen3/gemma): far faster, leaner streams.
      think: false,
    }),
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama chat failed (${res.status}): ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalMessage = { role: "assistant", content: "" };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let json;
      try {
        json = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (json.message?.content) {
        finalMessage.content += json.message.content;
        yield { type: "token", content: json.message.content };
      }
      if (json.message?.tool_calls?.length) {
        for (const call of json.message.tool_calls) {
          yield {
            type: "tool_call",
            name: call.function?.name,
            args: call.function?.arguments ?? {},
          };
        }
      }
      if (json.done) {
        yield {
          type: "usage",
          promptTokens: json.prompt_eval_count ?? 0,
          responseTokens: json.eval_count ?? 0,
          contextWindow: config.ollamaNumCtx,
        };
        yield { type: "done", message: finalMessage };
      }
    }
  }
}

/**
 * Non-streaming chat, returns the full assistant text.
 * `onUsage` (optional) is called with this call's token counts.
 */
export async function chatOnce({ messages, model, format, onUsage, temperature, signal }) {
  if (config.modelProvider === "anthropic") {
    if (!config.anthropicApiKey) throw new Error("Anthropic API key is not configured.");
    const { system, messages: anthropicMessages } = splitSystem(messages);
    const wantsJson = Boolean(format);
    const finalMessages = wantsJson
      ? [
          ...anthropicMessages,
          {
            role: "user",
            content:
              "Respond with only valid JSON. Do not include markdown, code fences, or commentary.",
          },
        ]
      : anthropicMessages;
    const res = await fetch(anthropicEndpoint("/v1/messages"), {
      method: "POST",
      headers: anthropicHeaders(),
      signal,
      body: JSON.stringify({
        model: model || defaultChatModel(),
        system: system || undefined,
        messages: finalMessages,
        max_tokens: 8192,
        temperature,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Anthropic chat failed (${res.status}): ${text}`);
    }
    const json = await res.json();
    onUsage?.({
      promptTokens: json.usage?.input_tokens ?? 0,
      responseTokens: json.usage?.output_tokens ?? 0,
    });
    return (json.content || [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();
  }

  const res = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Pass the abort signal so a Stop cancels the in-flight request immediately
    // instead of waiting for the (possibly slow) model to finish.
    signal,
    body: JSON.stringify({
      model: model || config.ollamaChatModel,
      messages: stripImagesForOllama(messages),
      stream: false,
      format,
      think: false,
      // Low temperature for the agent's step decisions → far more consistent,
      // less erratic next-action choices. Omitted → Ollama's default.
      ...(temperature != null ? { options: { temperature } } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama chat failed (${res.status}): ${text}`);
  }
  const json = await res.json();
  onUsage?.({ promptTokens: json.prompt_eval_count ?? 0, responseTokens: json.eval_count ?? 0 });
  return json.message?.content ?? "";
}

// ---- Agentic, DOM-aware execution ------------------------------------------
// Instead of guessing selectors up front, the runner observes the LIVE page each
// step (interactive elements tagged with [ref] numbers + visible text) and asks
// the model for the single next action. This is robust on real apps.

const AGENT_SYSTEM = `You are ZeroBug, a meticulous web-automation agent driving a real browser.

Each turn you receive the TASK and a snapshot of the current page: its URL, a numbered list of
interactive ELEMENTS (each with a [ref]), the visible TEXT, and sometimes a SCREENSHOT image.
Decide the SINGLE next action, always choosing elements by a [ref] from the ELEMENTS list.
The ELEMENTS list includes each control's text, placeholder, aria-label or title — use those
to identify the right one (e.g. an item whose title is "Pre-Sales").

Respond with ONLY a JSON object: { "thought": "...", "action": "<name>", ...params }
Actions and their params:
- navigate  { "url": "absolute https url" }      open a page
- type      { "ref": <number>, "text": "value" } type into an input/textarea (clears first)
- click     { "ref": <number> }                  click a button/link/element
- clickText { "text": "Sign in" }                click a visible element by its TEXT/label
                                                  (fallback when the right [ref] isn't listed)
- press     { "key": "Enter", "ref": <number?> } press a key (optionally focusing a ref first)
- select    { "ref": <number>, "value": "..." }  choose a <select> option
- hover      { "ref": <number> }                 move the mouse over an element to
                                                  reveal fly-out / collapsed menus
- uploadFile { "ref": <number>, "fixture": "pdf"|"png"|"csv"|"txt" }
                                                  attach a sample file to a file input or an
                                                  "Upload"/"Choose file" control (ref = the input
                                                  or the upload button). Pick the fixture type the
                                                  task implies (a document -> pdf, an image -> png,
                                                  a data import -> csv).
- expectDownload { "ref": <number>, "expectFilename": "*.pdf" (optional) }
                                                  click a download/export control AND capture the
                                                  downloaded file. Use this INSTEAD of "click" when
                                                  the task is to download or export a file.
- wait      { "ms": <number up to 8000> }        pause for content to load/settle
- scroll    { "direction": "down" | "up" }       reveal more of the page
- ask       { "question": "..." }                pause and ask the user when you are
                                                  genuinely unsure or blocked
- finish    { "success": true|false, "result": "the value/summary the task asked for" }

Strict rules:
- URLs: NEVER invent, guess, or use placeholder domains (never example.com/.org/.net). Use the
  exact "Base URL" given in the TASK. For a page within the app, navigate to the Base URL plus a
  relative path (e.g. Base "https://app.acme.io" + "/login" -> "https://app.acme.io/login").
- The browser usually STARTS already loaded on the app's base URL (check the history and the
  current URL). If you're already on the right page, do NOT navigate again — act on it directly.
- Blocking overlays FIRST: if a modal, dialog, cookie/consent banner, onboarding tour/wizard, or
  any overlay is covering the page (look for words like "Skip", "Skip tour", "Get started",
  "Next", "Got it", "Dismiss", "No thanks", "Close", "Maybe later", or an "×"/"✕" close control in
  ELEMENTS), dismiss it BEFORE anything else — usually by clicking "Skip"/"Close"/"×". Only once it
  is gone should you continue the task. If clicks on the real page do nothing or an unexpected panel
  is present, assume an overlay is blocking and dismiss it. If an onboarding wizard has no skip and
  blocks you, complete its steps ("Next"/"Continue"/"Finish") until it closes.
- Use "ask" WHENEVER you have a real doubt that you cannot resolve from the page itself:
  missing credentials, ambiguous instructions, multiple plausible elements, or you don't know which
  value to enter. Phrase a clear, specific question. The run pauses and the user's reply is added to
  your context — then continue. Don't ask about things you can see on the page (e.g. a dismissible
  overlay — just dismiss it); only ask when genuinely stuck or ambiguous.
- For type/click/select/hover you MUST put the element's number in the "ref" field
  (e.g. {"action":"click","ref":7}). Don't mention it only in "thought".
- Use ONLY [ref] numbers that appear in the CURRENT ELEMENTS list; they change every step. If the
  thing you want to click is clearly on the page (you can see its label in TEXT) but isn't in the
  ELEMENTS list, use "clickText" with its visible label instead of guessing a [ref].
- To log in, do it in ONE uninterrupted sequence: (1) type the username/workspace field,
  (2) type the password field, (3) CLICK the submit/sign-in button, (4) WAIT for the app to load.
  Read field labels/placeholders to pick the right fields. CRITICAL: after typing the credentials
  you MUST click the submit button — do NOT navigate to another URL or a protected page before the
  login has succeeded, or you'll be bounced back to the login page and loop. A URL containing
  "session_expired", "returnUrl", or landing back on the login page just means you are NOT logged in
  yet — simply complete the login form on the current page; it is not an error or a dead end. If a
  submit doesn't work, re-type the fields and submit again; only conclude failure if the app clearly
  rejects the credentials.
- After clicking something that loads a new page/view, the next snapshot reflects it —
  don't repeat the click.
- NEVER repeat an action that didn't work. The Actions-so-far history marks when the page did
  NOT change ("NO visible change") or when you're STUCK. If you see those, do NOT retry the same
  thing — change strategy: pick a DIFFERENT element, scroll to reveal off-screen controls, wait
  for content, dismiss a blocking overlay, try a different path, or ask/finish. Repeating a failed
  action wastes the whole run.
- When the task asks you to GET or READ a value (a number, a label, etc.), find it in TEXT
  and return it verbatim in finish.result. NEVER finish with success=true for a "get/read"
  task unless finish.result contains the actual value — keep navigating/waiting until you
  see it, or finish with success=false if it truly isn't reachable.
- To reach a section/tab, prefer clicking its link/tab in the ELEMENTS list (match by its
  text or title, e.g. "Pre-Sales"). If a sidebar looks collapsed and the item isn't listed,
  hover or click the sidebar/menu toggle to reveal it, or navigate to a likely path
  (e.g. "/presales"). Don't keep repeating the same click that isn't working.
- Popups/modals/dialogs: if the task is to OPEN or VERIFY a popup/modal/dialog and one is now
  open — the snapshot shows "OPEN POPUP/DIALOG", or you can see a titled panel/overlay with a
  close/× button that appeared after your click — then the GOAL IS MET. Immediately call
  finish with success=true and name what opened in "result" (e.g. "The 'Lead Source Ledger' popup
  opened."). Do NOT click again, do NOT try to close it, and do NOT keep interacting.
- Recognise success: the moment the page visibly shows what the task asked for (a popup appeared,
  a value is present, a message is shown, the expected page loaded), STOP and call finish
  success=true. Continuing past a satisfied goal wastes the run and often breaks it.
- Be patient with async UIs: after a click/navigation, if the expected result isn't visible YET,
  use "wait" (a couple of seconds) or "scroll" before concluding anything failed — content and
  toasts often load asynchronously. Confirm the expected outcome is actually on the page before you
  finish with success=true.
- One thing at a time: complete the current step and confirm its effect before moving on. Don't fire
  a different action while a page is still loading.
- Call finish as soon as the goal is met (success=true), or if it's truly impossible
  (success=false, explain why in result). Do not loop pointlessly or claim false success.
- Exactly one action per response.`;

const DECISION_SCHEMA = {
  type: "object",
  properties: {
    thought: { type: "string" },
    action: {
      type: "string",
      enum: [
        "navigate",
        "type",
        "click",
        "clickText",
        "press",
        "select",
        "hover",
        "uploadFile",
        "expectDownload",
        "wait",
        "scroll",
        "ask",
        "finish",
      ],
    },
    ref: { type: "number" },
    url: { type: "string" },
    text: { type: "string" },
    key: { type: "string" },
    value: { type: "string" },
    ms: { type: "number" },
    direction: { type: "string" },
    question: { type: "string" },
    success: { type: "boolean" },
    result: { type: "string" },
    fixture: { type: "string" },
    expectFilename: { type: "string" },
  },
  required: ["action"],
};

const DECISION_ACTIONS = [
  "navigate",
  "type",
  "click",
  "clickText",
  "press",
  "select",
  "hover",
  "uploadFile",
  "expectDownload",
  "wait",
  "scroll",
  "ask",
  "finish",
];

// Last-resort salvage: if JSON parsing fails entirely, pull the decision fields
// out of the raw text with regexes. As long as we can recover a valid action
// (and its key params), the run keeps going instead of wasting the step.
export function salvageDecision(content) {
  const s = String(content ?? "");
  const str = (k) => {
    const m = s.match(new RegExp(`["']?${k}["']?\\s*:\\s*["']([^"']*)["']`, "i"));
    return m ? m[1] : undefined;
  };
  const num = (k) => {
    const m = s.match(new RegExp(`["']?${k}["']?\\s*:\\s*(-?\\d+)`, "i"));
    return m ? Number(m[1]) : undefined;
  };

  let action = str("action");
  if (!action || !DECISION_ACTIONS.includes(action)) {
    // No explicit action field — infer from the first action word mentioned.
    action = DECISION_ACTIONS.find((a) => new RegExp(`\\b${a}\\b`, "i").test(s));
  }
  if (!action || !DECISION_ACTIONS.includes(action)) return null;

  const d = { action };
  const thought = str("thought");
  if (thought) d.thought = thought;
  const ref = num("ref");
  if (ref != null) d.ref = ref;
  const url = str("url");
  if (url) d.url = url;
  const text = str("text");
  if (text != null) d.text = text;
  const key = str("key");
  if (key) d.key = key;
  const value = str("value");
  if (value != null) d.value = value;
  const ms = num("ms");
  if (ms != null) d.ms = ms;
  const direction = str("direction");
  if (direction) d.direction = direction;
  const question = str("question");
  if (question) d.question = question;
  const result = str("result");
  if (result) d.result = result;
  const success = s.match(/["']?success["']?\s*:\s*(true|false)/i);
  if (success) d.success = /true/i.test(success[1]);
  return d;
}

/**
 * Decide the next browser action given the task and a live page observation.
 * @returns parsed decision object (throws if the model returns nothing usable).
 */
export async function decideAction({
  task,
  hints,
  url,
  elements,
  text,
  dialog,
  history,
  stepNo,
  maxSteps,
  imageBase64,
  contextImages,
  onUsage,
  model,
  signal,
}) {
  const elementLines =
    elements.length > 0
      ? elements.map((e) => `[${e.ref}] ${e.descriptor}`).join("\n")
      : "(no interactive elements detected)";
  const historyLines = history.length ? history.slice(-8).join("\n") : "(none yet)";
  const dialogLine = dialog?.open
    ? `\nOPEN POPUP/DIALOG: "${dialog.heading || "a modal is open"}" — a popup is currently open on the page.`
    : "";

  const hintsBlock = hints && String(hints).trim() ? `\n\n${String(hints).trim()}` : "";

  const user = `TASK: ${task}${hintsBlock}

STEP ${stepNo}/${maxSteps}. Actions so far:
${historyLines}

CURRENT PAGE
URL: ${url || "(blank)"}${dialogLine}
ELEMENTS:
${elementLines}

TEXT:
${text || "(empty)"}`;

  const userMessage = { role: "user", content: user };
  const allImages = [
    ...(contextImages?.length && stepNo === 1 ? contextImages : []),
    ...(imageBase64 ? [imageBase64] : []),
  ];
  if (allImages.length) userMessage.images = allImages;

  const messages = [{ role: "system", content: AGENT_SYSTEM }, userMessage];
  const modelsToTry = [...new Set([model, defaultCodeModel()].filter(Boolean))];

  // A blunt reminder appended on retries when the model returned unusable JSON.
  const JSON_REMINDER = {
    role: "user",
    content:
      "Your previous reply was not valid JSON. Respond with ONE minified JSON object ONLY — " +
      'no prose, no markdown, no code fences. Example: {"thought":"click login","action":"click","ref":3}',
  };

  let lastErr;
  let lastContent = "";
  for (const candidateModel of modelsToTry) {
    for (let attempt = 0; attempt < 3; attempt++) {
      // Bail out the moment a Stop is requested — don't burn more retries.
      if (signal?.aborted) throw new Error("Stopped by user.");
      const format = attempt === 0 ? DECISION_SCHEMA : "json";
      // After the first miss, add the corrective reminder to nudge clean JSON.
      const attemptMessages = attempt === 0 ? messages : [...messages, JSON_REMINDER];
      let content = "";
      try {
        content = await chatOnce({
          model: candidateModel,
          format,
          messages: attemptMessages,
          onUsage,
          temperature: 0.1,
          signal,
        });
      } catch (err) {
        // An aborted fetch means the user pressed Stop — surface that, don't retry.
        if (signal?.aborted || err?.name === "AbortError") throw new Error("Stopped by user.");
        lastErr = err;
        continue;
      }
      lastContent = content;
      try {
        const obj = parseJsonLoose(content);
        if (obj && typeof obj.action === "string") return obj;
        // Parsed, but no usable action — try to salvage fields from the raw text.
        const salvaged = salvageDecision(content);
        if (salvaged) return salvaged;
        lastErr = new Error("Decision had no action.");
      } catch (err) {
        // JSON is unrepairable — attempt a regex salvage before giving up.
        const salvaged = salvageDecision(content);
        if (salvaged) return salvaged;
        lastErr = new Error(`Model did not return a valid decision: ${err.message}`);
      }
    }
  }
  // Final salvage attempt across the last raw content we saw.
  const salvaged = salvageDecision(lastContent);
  if (salvaged) return salvaged;
  throw lastErr ?? new Error("Could not decide next action.");
}

const SPEC_SYSTEM = `You are a senior QA engineer. Given a plain-English testing prompt,
write a single self-contained Playwright test in TypeScript using @playwright/test.
Respond with ONLY the code, no markdown fences, no commentary.`;

/** Generate a Playwright spec (code string) from a natural-language prompt. */
export async function generateSpec(prompt, suite, model) {
  const code = await chatOnce({
    model: model || defaultCodeModel(),
    messages: [
      { role: "system", content: SPEC_SYSTEM },
      {
        role: "user",
        content: `Suite: ${suite || "General"}\nPrompt: ${prompt}`,
      },
    ],
  });
  return code
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/```$/i, "")
    .trim();
}

const SUITE_SYSTEM = `You are a principal QA engineer designing a professional, end-to-end UI test suite.
Respond with ONLY a JSON object (no markdown, no commentary):
{"tests":[{"title":"...","suite":"...","priority":"low|medium|high|critical","steps":["...","..."]}]}

GOAL: production-grade, "picture-perfect" test cases an automation agent can execute with zero
guessing. Quality over quantity — write 8-15 tests that are precise, self-contained, and grounded
in the REAL app (use the observed pages, sections, field labels, buttons and headings when given;
never invent UI that wasn't described).

COVERAGE — deliberately span these categories (label them via the "suite" field, matching the
app's real sections e.g. "Auth", "Leads", "Reports", "Settings"):
- Happy paths for each core flow and primary feature.
- Form validation: required fields, invalid formats, boundary values.
- Negative / error handling: wrong credentials, forbidden actions, not-found.
- Edge & empty states: no results, empty lists, long input, special characters.
- Navigation & deep-linking between the app's real sections.
- Data integrity where relevant (create → verify it appears → persists after reload).
Give each test a "priority": critical for auth/checkout/data-loss-risk flows, high for core
features, medium for secondary flows, low for cosmetic checks.

TITLE: a clear, specific outcome (e.g. "Login fails with an invalid password", not "Test login").

STEPS — an ordered list where EACH entry is exactly ONE concrete, unambiguous action or assertion:
- Start from a known state: the first step navigates somewhere (e.g. "Go to /login").
- Use the REAL visible labels for fields and buttons ("Type 'qa@acme.test' into the Email field",
  "Click the 'Sign in' button"). One interaction per step — never chain with "and".
- Prefer realistic, concrete test data over placeholders.
- Avoid brittle instructions: don't reference pixel positions, CSS selectors, or fixed sleeps —
  describe what the user sees and does.
- End EVERY test with at least one explicit assertion. Write assertions as:
  Assert "<visible text or outcome>"   or   Expect the URL to contain "/path".
  Assert the actual success signal (a toast, a redirect, a new row), not just "page loads".

EXAMPLE:
{"title":"User signs in with valid credentials","suite":"Auth","priority":"critical","steps":[
 "Go to /login",
 "Type 'qa@acme.test' into the Email field",
 "Type 'Passw0rd!' into the Password field",
 "Click the 'Sign in' button",
 "Expect the URL to contain \\"/dashboard\\"",
 "Assert \\"Welcome back\\" is visible"]}

JSON only.`;

/**
 * Generate a suite of UI test specs. Optionally grounded in an observed page map
 * (from exploring the real app) and reference images. Returns [] if the model is
 * unreachable or returns nothing usable.
 */
export async function generateTestSuite({ prompt, model, pageContext, images }) {
  let content = "";
  const userParts = [`Testing goal / app description:\n${String(prompt || "").trim() || "(none)"}`];
  if (pageContext) {
    userParts.push(
      `\nOBSERVED APP (explored live). Use these REAL pages, sections, headings, form fields and buttons to write accurate, page-specific tests — reference the exact field/button labels shown here and cover the sections that actually exist:\n${pageContext}`,
    );
  }
  if (images?.length) {
    userParts.push(
      `\n${images.length} reference screenshot(s) are attached — use them to understand the UI and cover what they show.`,
    );
  }
  const userMessage = { role: "user", content: userParts.join("\n") };
  // Keep full data URLs — the provider layer sends them to Claude as image blocks
  // (with the right media type) and strips the prefix for Ollama.
  if (images?.length) userMessage.images = images.filter(Boolean);

  try {
    content = await chatOnce({
      model: model || defaultCodeModel(),
      format: "json",
      messages: [{ role: "system", content: SUITE_SYSTEM }, userMessage],
    });
  } catch {
    return [];
  }

  let parsed;
  try {
    parsed = parseJsonLoose(content);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tests) ? parsed.tests : [];
  const PRIORITIES = ["low", "medium", "high", "critical"];
  return list
    .filter((t) => t && typeof t.title === "string" && t.title.trim())
    .slice(0, 20)
    .map((t) => ({
      title: String(t.title).trim().slice(0, 120),
      suite: String(t.suite || "Generated")
        .trim()
        .slice(0, 60),
      steps: Array.isArray(t.steps)
        ? t.steps
            .map((s) => String(s).trim())
            .filter(Boolean)
            .slice(0, 20)
        : [],
      priority: PRIORITIES.includes(t.priority) ? t.priority : "medium",
    }));
}

const EXPLAIN_SCHEMA = {
  type: "object",
  properties: {
    rootCause: { type: "string" },
    suggestion: { type: "string" },
    proposedSteps: { type: "array", items: { type: "string" } },
  },
  required: ["rootCause", "suggestion"],
};

const EXPLAIN_SYSTEM = `You are a senior QA engineer debugging a FAILED automated browser test.
You are given the test's goal, its execution steps (the failing step is marked ❌), the failure
reason, browser console errors, and failed network requests.

Respond with ONLY a JSON object:
{
  "rootCause": "2-4 plain-English sentences naming the most likely root cause",
  "suggestion": "a concrete, specific fix the user should make",
  "proposedSteps": ["full revised step list", "..."]
}
Rules:
- Ground your analysis in the evidence (a 401/403 → auth/session; a failed selector → the element
  moved or needs a wait; a 500 → a backend bug, not a test bug).
- Only fill "proposedSteps" when the fix is a change to the TEST's steps; give the COMPLETE revised
  list (not a diff). If the failure is an app/backend bug, leave "proposedSteps" empty.
- Be concise and actionable. No markdown, no commentary outside the JSON.`;

/**
 * Explain why a run failed and propose a fix. Returns
 * { rootCause, suggestion, proposedSteps[] }. Throws if the model is unreachable.
 */
export async function explainFailure({ test, run, model }) {
  const steps = (run.steps || [])
    .map((s, i) => {
      const detail = s.detail && s.detail !== s.label ? ` — ${s.detail}` : "";
      const mark = s.status === "fail" ? " ❌" : "";
      return `${i + 1}. ${s.label}${detail}${mark}`;
    })
    .join("\n");
  const consoleLines =
    (run.forensics?.console || []).map((c) => `- ${c.type}: ${c.text}`).join("\n") || "(none)";
  const networkLines =
    (run.forensics?.network || [])
      .map((n) => `- ${n.method || "GET"} ${n.url} → ${n.status || n.failure || "failed"}`)
      .join("\n") || "(none)";

  const user = `TEST GOAL: ${test.title}${test.description && test.description !== "No description provided." ? `\n${test.description}` : ""}
${test.steps?.length ? `\nIntended steps:\n${test.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : ""}

FAILURE REASON: ${run.failureReason || "(none recorded)"}

EXECUTION STEPS:
${steps || "(none)"}

CONSOLE ERRORS:
${consoleLines}

FAILED NETWORK REQUESTS:
${networkLines}`;

  const content = await chatOnce({
    model: model || defaultChatModel(),
    format: EXPLAIN_SCHEMA,
    messages: [
      { role: "system", content: EXPLAIN_SYSTEM },
      { role: "user", content: user },
    ],
  });
  const parsed = parseJsonLoose(content);
  return {
    rootCause: String(parsed.rootCause || "").trim(),
    suggestion: String(parsed.suggestion || "").trim(),
    proposedSteps: Array.isArray(parsed.proposedSteps)
      ? parsed.proposedSteps
          .map((s) => String(s).trim())
          .filter(Boolean)
          .slice(0, 30)
      : [],
  };
}

/**
 * Summarise a list of run steps into a proper human-readable paragraph
 * for the "Steps to Reproduce" field in a test report.
 * Returns an empty string if the input is empty or the model is unreachable.
 */
export async function summarizeReproduce(steps, testTitle) {
  if (!steps || !steps.length) return "";

  // Include all steps (not just first 40) and include detail for failed steps
  // so the model has full context about where things broke.
  const numbered = steps
    .map((s, i) => {
      const detail = s.detail && s.detail !== s.label ? ` → ${s.detail}` : "";
      const mark = s.status === "fail" ? " ❌" : "";
      return `${i + 1}. ${s.label}${detail}${mark}`;
    })
    .join("\n");

  try {
    const summary = await chatOnce({
      model: defaultChatModel(),
      messages: [
        {
          role: "system",
          content:
            "You are a QA report writer. Based on the agent's execution steps below, write a clear human-readable paragraph (2–5 sentences) describing what the test did and exactly where/why it failed. Write it as a proper narrative — do NOT copy the step text verbatim, do NOT use bullet points or numbered lists, do NOT use markdown. Start directly with the description.",
        },
        {
          role: "user",
          content: `Test: ${testTitle || "unknown"}\n\nExecution steps:\n${numbered}`,
        },
      ],
    });
    return summary.trim();
  } catch {
    // If the model is unavailable, fall back to the failed steps only.
    return (
      steps
        .filter((s) => s.status === "fail")
        .map((s) => s.label + (s.detail ? `: ${s.detail}` : ""))
        .join(". ") ||
      steps
        .slice(0, 3)
        .map((s) => s.label)
        .join("; ")
    );
  }
}

/**
 * Generate a concise bug-description cell for the test report.
 * Returns a deterministic fallback if the model is unavailable.
 */
export async function summarizeBugDescription({ test, run }) {
  if (test?.status !== "failed") return "";
  const reason = String(test?.failureReason || run?.failureReason || "").trim();
  const fallback = reason || String(test?.title || "Test failed").trim();
  const steps = Array.isArray(run?.steps)
    ? run.steps
        .map((s, i) => {
          const detail = s.detail && s.detail !== s.label ? ` -> ${s.detail}` : "";
          const mark = s.status === "fail" ? " FAILED" : "";
          return `${i + 1}. ${s.label}${detail}${mark}`;
        })
        .join("\n")
    : "";

  try {
    const summary = await chatOnce({
      model: defaultChatModel(),
      messages: [
        {
          role: "system",
          content:
            "You are a QA report writer. Write one short bug-description sentence for a spreadsheet cell. State what failed from the user's/product perspective. Do not mention artifacts, traces, screenshots, automation internals, markdown, or bullet points.",
        },
        {
          role: "user",
          content: `Test title: ${test?.title || "unknown"}
Expected result: ${test?.description || "(none)"}
Failure reason: ${reason || "(none)"}
Execution steps:
${steps || "(none)"}`,
        },
      ],
    });
    return summary.trim() || fallback;
  } catch {
    return fallback;
  }
}
