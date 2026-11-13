// In-memory state shared by the MCP endpoint and the web console: sessions with their message
// queues, the activity feed, and a revision counter the console long-polls on.
//
// Delivery is at-least-once. A message stays in the inbox until the agent replies, so a wait whose
// response got lost on the way (timeout, dropped tunnel) simply receives it again on the next wait.
import { randomBytes } from "node:crypto";

export const sessionIdPattern = /^[0-9a-f]{8}$/;
const graceMs = 15_000;
const maxActivity = 300;
const maxTimeline = 500;

export class SessionError extends Error {}

export function createHub({ now = Date.now } = {}) {
  const sessions = new Map();
  // Ids the user or the agent closed. A loop that is still running must stop, not be re-adopted.
  const closedIds = new Set();
  const activity = [];
  const watchers = new Set();
  let revision = 0;
  let sessionCount = 0;
  let activityCount = 0;

  function changed() {
    revision++;
    for (const wake of [...watchers]) wake();
    return revision;
  }

  function touch(session) {
    session.lastSeenAt = now();
    // Status turns "offline" by the passing of time alone, so the console needs a nudge to re-read it.
    clearTimeout(session.offlineTimer);
    session.offlineTimer = setTimeout(changed, graceMs + 100).unref();
  }

  function addToTimeline(session, role, text, extra) {
    session.timeline.push({ n: ++session.items, role, text, at: now(), ...extra });
    if (session.timeline.length > maxTimeline) session.timeline.shift();
  }

  function create(id, name, note) {
    const session = {
      id, name: name || `云端会话 ${++sessionCount}`, createdAt: now(), lastSeenAt: now(),
      seq: 0, delivered: 0, acked: 0, inbox: [], timeline: [], items: 0,
    };
    sessions.set(id, session);
    addToTimeline(session, "note", note);
    return session;
  }

  // The session an agent call refers to. An unknown id is adopted: after a restart of this service
  // the agent's loop still carries its old id, and it should keep working without a new prompt.
  function forAgent(id) {
    if (closedIds.has(id)) return undefined;
    const session = sessions.get(id) ?? create(id, undefined, "服务重启后，云端 Agent 带着原会话 id 重新接入");
    touch(session);
    return session;
  }

  function deliver(session, message) {
    const redelivered = message.seq <= session.delivered;
    session.delivered = Math.max(session.delivered, message.seq);
    return { event: "message", seq: message.seq, message: message.text, redelivered, queued: session.inbox.length - 1 };
  }

  function statusOf(session) {
    if (session.closed) return "disconnected";
    if (session.waiter) return "waiting";
    if (session.delivered > session.acked) return "working";
    return now() - session.lastSeenAt < graceMs ? "active" : "offline";
  }

  function summaryOf(session) {
    const { id, name, createdAt, lastSeenAt, hint, closed } = session;
    const last = session.timeline.findLast((item) => item.role !== "note");
    return {
      id, name, createdAt, lastSeenAt, hint, closed,
      status: statusOf(session),
      queued: session.inbox.filter((message) => message.seq > session.delivered).length,
      waiting: session.waiter && { via: session.waiter.via, since: session.waiter.startedAt, holdMs: session.waiter.holdMs },
      preview: last?.text.slice(0, 80),
    };
  }

  return {
    get revision() { return revision; },

    // For state the console shows but the hub does not own (command policy, public address).
    notify: changed,

    connect({ id, name }) {
      let session = id && sessions.get(id);
      if (session) {
        if (name) session.name = name;
        addToTimeline(session, "note", "云端 Agent 重新接入");
      } else {
        session = create(id ?? randomBytes(4).toString("hex"), name, "云端 Agent 已接入");
      }
      closedIds.delete(session.id);
      session.closed = undefined;
      touch(session);
      changed();
      return session;
    },

    // Resolves with the next message, or with idle / superseded / aborted / disconnected.
    wait(id, { signal, holdMs, via }) {
      const session = forAgent(id);
      if (!session) return { event: "disconnected" };
      if (signal?.aborted) return { event: "aborted" };
      if (session.waiter) {
        // The client gave up on its previous call without closing it; only the newest wait is live.
        const { startedAt, holdMs: previousHold, via: previousVia } = session.waiter;
        session.hint = { via: previousVia, afterMs: now() - startedAt, holdMs: previousHold, at: now() };
        session.waiter.finish({ event: "superseded" });
      }
      if (session.inbox.length) {
        changed();
        return deliver(session, session.inbox[0]);
      }
      return new Promise((resolve) => {
        const waiter = { via, holdMs, startedAt: now() };
        const timer = setTimeout(() => {
          // A wait that ran its full length shows the earlier cut-off is no longer happening.
          if (session.hint?.via === via) session.hint = undefined;
          waiter.finish({ event: "idle" });
        }, holdMs);
        const abort = () => {
          session.hint = { via, afterMs: now() - waiter.startedAt, holdMs, at: now() };
          waiter.finish({ event: "aborted" });
        };
        waiter.finish = (result) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (session.waiter === waiter) session.waiter = undefined;
          touch(session);
          changed();
          resolve(result);
        };
        session.waiter = waiter;
        signal?.addEventListener("abort", abort, { once: true });
        changed();
      });
    },

    reply(id, text) {
      const session = forAgent(id);
      if (!session) return { event: "disconnected" };
      // A retried call must not show the same answer twice.
      const duplicate = session.lastReply?.text === text && session.lastReply.delivered === session.delivered;
      if (!duplicate) addToTimeline(session, "assistant", text);
      session.lastReply = { text, delivered: session.delivered };
      session.acked = session.delivered;
      session.inbox = session.inbox.filter((message) => message.seq > session.acked);
      changed();
      return { event: "replied", queued: session.inbox.length };
    },

    progress(id, text) {
      const session = forAgent(id);
      if (!session) return { event: "disconnected" };
      addToTimeline(session, "progress", text);
      changed();
      return { event: "progress", queued: session.inbox.filter((message) => message.seq > session.delivered).length };
    },

    disconnect(id, by) {
      closedIds.add(id);
      const session = sessions.get(id);
      if (!session || session.closed) return;
      session.closed = by;
      addToTimeline(session, "note", by === "user" ? "已在网页上断开这个会话" : "云端 Agent 结束了这个会话");
      if (session.waiter) session.waiter.finish({ event: "disconnected" });
      else changed();
    },

    remove(id) {
      this.disconnect(id, "user");
      clearTimeout(sessions.get(id).offlineTimer);
      sessions.delete(id);
      changed();
    },

    send(id, text) {
      const session = sessions.get(id);
      if (!session) throw new SessionError("会话不存在");
      if (session.closed) throw new SessionError("会话已断开，不能再发送消息");
      const message = { seq: ++session.seq, text };
      session.inbox.push(message);
      addToTimeline(session, "user", text, { seq: message.seq });
      // A pending wait means the inbox was empty, so this message is the next one to deliver.
      if (session.waiter) session.waiter.finish(deliver(session, message));
      else changed();
    },

    // Which session a project tool call belongs to: the one the agent named, else the only open one.
    attribute(id) {
      if (id && sessions.has(id)) return id;
      const open = [...sessions.values()].filter((session) => !session.closed);
      return open.length === 1 ? open[0].id : undefined;
    },

    record(entry) {
      const session = sessions.get(entry.session);
      if (session) touch(session);
      const item = { n: ++activityCount, at: now(), ...entry };
      activity.push(item);
      if (activity.length > maxActivity) activity.shift();
      item.rev = changed();
      return item;
    },

    // One activity entry per command job, updated in place as the job produces output and ends.
    recordJob(job) {
      const item = activity.findLast((entry) => entry.job?.id === job.id);
      if (!item) return this.record({ session: job.session, tool: "run_command", target: job.command, job });
      item.job = job;
      item.rev = changed();
      return item;
    },

    summaries: () => [...sessions.values()].map(summaryOf).reverse(),

    detail(id) {
      const session = sessions.get(id);
      if (!session) return undefined;
      const timeline = session.timeline.map((item) => {
        if (item.role !== "user") return item;
        const state = item.seq <= session.acked ? "done"
          : item.seq <= session.delivered ? "delivered"
            : session.closed ? "undelivered" : "queued";
        return { ...item, state };
      });
      return { ...summaryOf(session), timeline };
    },

    activitySince: (since) => activity.filter((item) => item.rev > since),

    // Resolves once the state has moved past `since`, or after `ms`.
    watch(since, ms, signal) {
      if (revision > since || signal?.aborted) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          watchers.delete(done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener("abort", done, { once: true });
        watchers.add(done);
      });
    },
  };
}
