// Minimal Server-Sent-Events helpers. The frontend consumes these via
// fetch + ReadableStream (see src/lib/api.ts streamSSE), not EventSource,
// so POST bodies work fine.

export function openSse(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

export function sendEvent(res, event, data) {
  // `event` is informational; the payload carries its own `type` too.
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function closeSse(res) {
  res.write("event: done\ndata: {}\n\n");
  res.end();
}
