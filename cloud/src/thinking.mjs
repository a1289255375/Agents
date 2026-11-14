// Shows a Cloud Agent's thinking in its console session. Cursor hands out the thinking its chat shows
// through the Cloud Agents API stream of the agent (`thinking` events with text deltas), so the agent
// itself is never asked to report it. Reading the stream takes the user's Cursor API key.
import { setTimeout as sleep } from "node:timers/promises";

export function createThinkingRelay({ hub, apiKey, apiBase = "https://api.cursor.com", retryMs = 5000 }) {
  const followed = new Map();
  const stopped = new AbortController();

  async function relay(session, agent) {
    let lastEventId;
    // Text or a tool call between two thinking deltas ends the block they belong to. Status,
    // heartbeat and interaction_update events (the latter mirror the others) do not.
    let block = 0;
    while (!stopped.signal.aborted && hub.isOpen(session)) {
      try {
        const response = await fetch(`${apiBase}/v1/agents/${agent}/stream`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "text/event-stream", ...(lastEventId && { "Last-Event-ID": lastEventId }) },
          signal: stopped.signal,
        });
        if (response.status === 410) {
          // The resume point is past Cursor's retention window; start again from the agent's newest run.
          lastEventId = undefined;
          block++;
        } else if (!response.ok) {
          // A wrong key, an agent the key cannot see or an archived agent: asking again changes nothing.
          if (response.status < 500 && response.status !== 429) {
            hub.note(session, `读不到这个云端 Agent 的思考：Cursor API 返回 HTTP ${response.status}（${(await response.text()).slice(0, 300)}）`);
            return;
          }
        } else {
          for await (const event of serverEvents(response.body)) {
            if (!hub.isOpen(session)) return;
            if (event.id) lastEventId = event.id;
            if (event.event === "assistant" || event.event === "tool_call") block++;
            const text = event.event === "thinking" && thinkingText(event.data);
            if (text) hub.think(session, text, block);
          }
        }
      } catch {
        // A dropped stream is picked up again below, from the last event received.
      }
      await sleep(retryMs, undefined, { signal: stopped.signal }).catch(() => {});
    }
  }

  return {
    // Called on every connect_session that names the agent; only the first call for a session opens the stream.
    follow(session, agent) {
      if (followed.get(session) === agent) return;
      followed.set(session, agent);
      void relay(session, agent).finally(() => {
        if (!hub.isOpen(session) && followed.get(session) === agent) followed.delete(session);
      });
    },
    stop: () => stopped.abort(),
  };
}

function thinkingText(data) {
  try {
    const { text } = JSON.parse(data);
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}

async function* serverEvents(body) {
  let buffer = "";
  let event = {};
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    const lines = (buffer + chunk).split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      if (!line) {
        if (event.data !== undefined) yield event;
        event = {};
        continue;
      }
      const colon = line.indexOf(":");
      if (colon === 0) continue;
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "data") event.data = event.data === undefined ? value : `${event.data}\n${value}`;
      else if (field === "event" || field === "id") event[field] = value;
    }
  }
}
