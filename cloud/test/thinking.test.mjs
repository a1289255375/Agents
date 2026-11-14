// The console's thinking comes from Cursor's stream of the cloud agent, not from the agent itself.
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createHub } from "../src/hub.mjs";
import { createThinkingRelay } from "../src/thinking.mjs";
import { fakeCursorApi, sse, until } from "./helpers.mjs";

const agent = "bc-00000000-0000-0000-0000-000000000001";
const thinkingOf = (hub, id) => hub.detail(id).timeline.filter(({ role }) => role === "thinking").map(({ text }) => text);
const streamHead = (res) => res.writeHead(200, { "Content-Type": "text/event-stream" });

function setup(t, api) {
  const hub = createHub();
  const { id } = hub.connect({});
  const relay = createThinkingRelay({ hub, apiKey: "key_test", apiBase: api.base, retryMs: 20 });
  t.after(() => relay.stop());
  return { hub, id, relay };
}

test("thinking deltas become one block each, and a dropped stream resumes after the last event", async (t) => {
  let live;
  const api = await fakeCursorApi(t, [
    (req, res) => {
      streamHead(res);
      res.write(`event: status\ndata: {"agentId":"${agent}","status":"RUNNING"}\n\n`);
      res.write(sse("thinking", { text: "先看" }, "1"));
      // One event split over two chunks, with CRLF line ends.
      res.write("id: 2\r\nevent: thinking\r\nda");
      res.write('ta: {"text":" auth.js"}\r\n\r\n');
      res.write(sse("tool_call", { callId: "c1", name: "mcp", status: "running" }, "3"));
      res.end(sse("thinking", { text: "问题在" }, "4"));
    },
    (req, res) => {
      live = res;
      streamHead(res);
      res.write(`event: status\ndata: {"agentId":"${agent}","status":"RUNNING"}\n\n`);
      res.write(sse("thinking", { text: "过期判断" }, "5"));
      res.write(sse("heartbeat", {}));
      res.write(sse("interaction_update", { type: "step-started" }, "6"));
      res.write(sse("assistant", { text: "改好了" }, "7"));
      res.write(sse("thinking", { text: "再跑测试" }, "8"));
    },
  ]);
  const { hub, id, relay } = setup(t, api);
  relay.follow(id, agent);
  // Every shell poll names the agent again; that must not open a second stream.
  relay.follow(id, agent);

  await until(() => thinkingOf(hub, id).length === 3, "three thinking blocks");
  assert.deepEqual(thinkingOf(hub, id), ["先看 auth.js", "问题在过期判断", "再跑测试"]);
  assert.equal(api.requests.length, 2);
  const [first, second] = api.requests;
  assert.equal(first.url, `/v1/agents/${agent}/stream`);
  assert.deepEqual([first.headers.authorization, first.headers.accept, first.headers["last-event-id"]], ["Bearer key_test", "text/event-stream", undefined]);
  assert.equal(second.headers["last-event-id"], "4");

  // After the session is closed, the next event ends the stream instead of growing the timeline.
  hub.disconnect(id, "user");
  live.write(sse("thinking", { text: "太晚了" }, "9"));
  await second.closed;
  assert.deepEqual(thinkingOf(hub, id), ["先看 auth.js", "问题在过期判断", "再跑测试"]);
});

test("an expired resume point starts over and a server error is retried", async (t) => {
  const api = await fakeCursorApi(t, [
    (req, res) => {
      streamHead(res);
      res.end(sse("thinking", { text: "第一段" }, "9"));
    },
    (req, res) => res.writeHead(410).end('{"code":"stream_expired"}'),
    (req, res) => res.writeHead(503).end(),
    (req, res) => {
      streamHead(res);
      res.write(sse("thinking", { text: "从最新一轮重来" }, "1"));
    },
  ]);
  const { hub, id, relay } = setup(t, api);
  relay.follow(id, agent);
  await until(() => thinkingOf(hub, id).length === 2, "thinking after the restart");
  assert.deepEqual(thinkingOf(hub, id), ["第一段", "从最新一轮重来"]);
  assert.deepEqual(api.requests.map(({ headers }) => headers["last-event-id"]), [undefined, "9", undefined, undefined]);
  assert.equal(hub.detail(id).timeline.filter(({ role }) => role === "note").length, 1);
});

test("a key Cursor refuses leaves one note in the session and is not asked again", async (t) => {
  const api = await fakeCursorApi(t, [
    (req, res) => res.writeHead(401, { "Content-Type": "application/json" }).end('{"error":"invalid api key"}'),
  ]);
  const { hub, id, relay } = setup(t, api);
  relay.follow(id, agent);
  const note = await until(() => hub.detail(id).timeline.find(({ role, text }) => role === "note" && text.includes("HTTP")), "the note");
  assert.equal(note.text, '读不到这个云端 Agent 的思考：Cursor API 返回 HTTP 401（{"error":"invalid api key"}）');
  relay.follow(id, agent);
  await sleep(100);
  assert.equal(api.requests.length, 1);
});
