const listenersByProject = new Map();

export function publishProjectEvent(projectId, event) {
  const key = String(projectId ?? "");
  const listeners = listenersByProject.get(key);
  if (!listeners?.size) return;
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // ignore broken listeners
    }
  }
}

export function subscribeProjectEvents(projectId, listener) {
  const key = String(projectId ?? "");
  const listeners = listenersByProject.get(key) ?? new Set();
  listeners.add(listener);
  listenersByProject.set(key, listeners);
  return () => {
    const current = listenersByProject.get(key);
    if (!current) return;
    current.delete(listener);
    if (!current.size) listenersByProject.delete(key);
  };
}
