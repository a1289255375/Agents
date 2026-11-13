import { randomUUID } from "node:crypto";

const legacyWakePrefix = "[网页会话唤醒] 网页有待处理的用户任务。";
const heartbeatMs = 15_000;

export function createWebSessions({ origin, inConnectedWindow, readSessionStatuses }) {
  const entries = new Map();

  return {
    add(session, window, { relay = false, dispatchParent = false } = {}) {
      const { id, name, createdAt, workspace, parentId } = session;
      const entry = entries.get(id) ?? { id, messages: [], inbox: [], online: false };
      Object.assign(entry, { name, workspace: workspace ?? entry.workspace, parentId, window: window.title, windowId: window.id });
      entry.createdAt ??= createdAt;
      if (dispatchParent) entry.dispatchParent = true;
      if (relay) {
        if (entry.online && entry.generationId !== session.generationId) markOffline(entry);
        entry.online = true;
        entry.generationId = session.generationId;
        entry.awaitingConnection = false;
        entry.dispatchError = undefined;
      }
      entries.set(id, entry);
      return session;
    },

    addDispatchResult(child, parentId, window) {
      const id = child.id ?? randomUUID();
      if (entries.get(id)?.online) return;
      this.add({ ...child, id, parentId, createdAt: child.createdAt ?? new Date().toISOString() }, window);
      const entry = entries.get(id);
      entry.withoutConversation = !child.id;
      entry.awaitingConnection = !child.error;
      entry.dispatchError = child.error;
    },

    async list() {
      const snapshot = [...entries.values()].reverse();
      if (!snapshot.length) return [];
      const idsByWindow = new Map();
      for (const { id, windowId, withoutConversation } of snapshot) {
        if (withoutConversation) continue;
        if (!idsByWindow.has(windowId)) idsByWindow.set(windowId, []);
        idsByWindow.get(windowId).push(id);
      }
      const statuses = idsByWindow.size ? await readSessionStatuses(idsByWindow).catch(() => ({})) : {};
      return snapshot.filter((entry) => entries.has(entry.id)).map((entry) => {
        const { id, name, createdAt, workspace, window, parentId, withoutConversation } = entry;
        const native = statuses[id];
        const webStatus = refreshState(entry, native);
        return { id, name, createdAt, workspace, window, parentId, status: native?.status, webStatus, hasCursorSession: !withoutConversation,
          submitError: webStatus === "failed" ? entry.dispatchError ?? native?.submitError : undefined };
      });
    },

    get: (id) => entries.get(id),

    async remove(entry, deleteCursor) {
      if (deleteCursor && !entry.withoutConversation) {
        await inConnectedWindow(entry.windowId, (bridge) => bridge.call("deleteSession", { id: entry.id }));
      }
      markOffline(entry);
      entries.delete(entry.id);
      return { id: entry.id, deleted: true };
    },

    async read(entry) {
      if (entry.withoutConversation) {
        return { id: entry.id, name: entry.name, parentId: entry.parentId, createdAt: entry.createdAt,
          messages: [], webStatus: "failed", submitError: entry.dispatchError };
      }
      const native = await inConnectedWindow(entry.windowId, (bridge) =>
        bridge.call("read", { id: entry.id, last: 100, maxChars: 12000 }));
      if (entry.dispatchParent && native.status === "aborted" && native.abortReason === "error") {
        const lastError = native.messages.findLast((message) => message.error)?.error;
        entry.dispatchError = native.submitError ?? lastError?.message ?? lastError?.title;
      }
      const webStatus = refreshState(entry, native);
      if (native.name) entry.name = native.name;
      entry.createdAt ??= native.createdAt;
      native.messages = native.messages.filter((message) =>
        message.role !== "user" || !message.text?.startsWith(legacyWakePrefix));
      const messages = entry.messages.length || entry.inbox.length
        ? [...native.messages, ...entry.messages, ...entry.inbox.map((message) => ({ ...message, pending: true }))]
          .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "")).slice(-100)
        : native.messages;
      return { ...native, messages, webStatus, submitError: entry.dispatchError ?? native.submitError };
    },

    async send(entry, text) {
      if (!entry.online) return { id: entry.id, webStatus: "offline" };
      const { id, windowId } = entry;
      const statuses = await readSessionStatuses(new Map([[windowId, [id]]]));
      const webStatus = refreshState(entry, statuses[id]);
      if (webStatus === "failed") return { id, webStatus: "offline" };
      if (webStatus === "offline" || webStatus === "unavailable") return { id, webStatus };
      entry.inbox.push(webMessage("user", text));
      if (entry.waiter) entry.waiter("message", entry.inbox.shift());
      return { id, webStatus: entry.inbox.length ? "queued" : "responding" };
    },

    async wait(id, { signal, _meta, sendNotification }) {
      signal.throwIfAborted();
      const entry = requireOnlineEntry(id);
      const metadata = { id, webUrl: origin };
      if (entry.waiter) throw new Error("这个会话已经有一个正在等待的调用");
      const progressToken = _meta?.progressToken;
      const queued = entry.inbox.shift();
      const { event, message } = queued ? { event: "message", message: queued } : await waitForMessage(entry, signal, progressToken === undefined
        ? undefined
        : (progress) => sendNotification({ method: "notifications/progress", params: { progressToken, progress } }));
      if (event !== "message") return { ...metadata, event };

      entry.messages.push(message);
      return { ...metadata, event, message: message.text };
    },

    reply(id, text) {
      const entry = requireOnlineEntry(id);
      entry.messages.push(webMessage("assistant", text));
      return { id, sent: true };
    },

    disconnect(id) {
      markOffline(requireEntry(id));
      return { id, disconnected: true };
    },
  };

  function requireEntry(id) {
    const entry = entries.get(id);
    if (!entry) throw new Error("会话尚未接入网页，请调用 connect_session");
    return entry;
  }

  function requireOnlineEntry(id) {
    const entry = requireEntry(id);
    if (!entry.online) throw new Error("会话已离线，请在 Cursor 中重新调用 connect_session");
    return entry;
  }
}

function waitForMessage(entry, signal, heartbeat) {
  return new Promise((resolve, reject) => {
    const finish = (event, message) => {
      clearInterval(timer);
      signal.removeEventListener("abort", abort);
      entry.waiter = undefined;
      if (event === "cancelled") reject(signal.reason);
      else resolve({ event, message });
    };
    const abort = () => {
      finish("cancelled");
      markOffline(entry);
    };
    let progress = 0;
    const timer = heartbeat && setInterval(() => {
      void heartbeat(++progress).catch(() => {});
    }, heartbeatMs).unref();
    entry.waiter = finish;
    signal.addEventListener("abort", abort, { once: true });
  });
}

function webMessage(role, text) {
  return { id: randomUUID(), role, text, createdAt: new Date().toISOString() };
}

function refreshState(entry, native) {
  if (entry.dispatchError) return "failed";
  const status = native?.status;
  const ended = status === "completed" || status === "aborted" || status === "cancelled";
  if (native?.submitError && (ended || !entry.online)) {
    markOffline(entry);
    return "failed";
  }
  if (!entry.online) {
    if (entry.dispatchParent && status === "generating") return "dispatching";
    if (!entry.awaitingConnection) return "offline";
    if (native === undefined) return "unavailable";
    if (status === "generating" || (!ended && native?.generationId)) return "connecting";
    entry.awaitingConnection = false;
    return "offline";
  }
  if (native === undefined) return "unavailable";
  const replaced = status === "generating" && native.generationId !== entry.generationId;
  // Subagents often stay at status "none" for a whole live turn. Only a finished
  // turn, or a newer generation, means this web wait is no longer the active one.
  if (ended || replaced) {
    markOffline(entry);
    return "offline";
  }
  if (entry.waiter) return "waiting";
  if (entry.inbox.length) return "queued";
  if (status !== "generating") return "offline";
  return "responding";
}

function markOffline(entry) {
  entry.online = false;
  entry.awaitingConnection = false;
  entry.waiter?.("disconnected");
  for (const message of entry.inbox.splice(0)) entry.messages.push({ ...message, undelivered: true });
}
