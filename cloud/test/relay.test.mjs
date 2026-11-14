import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { createRelay } from "../relay/relay.mjs";
import { startRelayLink } from "../src/relay-link.mjs";

const token = "relay-test-token-abc123";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function startLocal(t, handler) {
  const server = createServer(handler);
  const port = await listen(server);
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return { server, port };
}

async function startRelay(t) {
  const relay = createRelay({ log: () => {} });
  const server = createServer(relay.handleRequest);
  server.on("upgrade", relay.handleUpgrade);
  const port = await listen(server);
  t.after(() => { relay.close(); server.closeAllConnections?.(); server.close(); });
  return { relay, server, port, url: `http://127.0.0.1:${port}` };
}

async function startLink(t, { relayUrl, localPort, token: tok = token }) {
  let resolveUp;
  const up = new Promise((resolve) => (resolveUp = resolve));
  const link = startRelayLink({ relayUrl, token: tok, localPort, onState: (s) => s.state === "up" && resolveUp(), log: () => {} });
  t.after(() => link.stop());
  await up;
  return link;
}

const bearer = (tok = token) => ({ Authorization: `Bearer ${tok}` });

test("forwards /mcp to the local endpoint with method, path, auth and body intact", async (t) => {
  const seen = [];
  const local = await startLocal(t, async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, echo: Buffer.concat(chunks).toString() }));
  });
  const relay = await startRelay(t);
  await startLink(t, { relayUrl: relay.url, localPort: local.port });

  const res = await fetch(`${relay.url}/mcp`, { method: "POST", headers: { ...bearer(), "Content-Type": "application/json" }, body: JSON.stringify({ hello: "world" }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, echo: JSON.stringify({ hello: "world" }) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "/mcp");
  assert.equal(seen[0].auth, `Bearer ${token}`);
});

test("rejects /mcp with an unknown or missing token with 401", async (t) => {
  const local = await startLocal(t, (req, res) => res.end("should not reach"));
  const relay = await startRelay(t);
  await startLink(t, { relayUrl: relay.url, localPort: local.port });

  const wrong = await fetch(`${relay.url}/mcp`, { method: "POST", headers: bearer("some-other-token") });
  assert.equal(wrong.status, 401);
  const none = await fetch(`${relay.url}/mcp`, { method: "POST" });
  assert.equal(none.status, 401);
});

test("GET / answers relay health without a token and forwards to the bridge with one", async (t) => {
  const local = await startLocal(t, (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ service: "cursor-cloud-bridge", instance: "pc-1" }));
  });
  const relay = await startRelay(t);
  await startLink(t, { relayUrl: relay.url, localPort: local.port });

  assert.equal((await (await fetch(`${relay.url}/`)).json()).service, "cursor-bridge-relay");
  const forwarded = await (await fetch(`${relay.url}/`, { headers: bearer() })).json();
  assert.deepEqual(forwarded, { service: "cursor-cloud-bridge", instance: "pc-1" });
});

test("a request whose bearer matches no link is not forwarded, whatever the path", async (t) => {
  const local = await startLocal(t, (req, res) => res.end("should not reach"));
  const relay = await startRelay(t);
  await startLink(t, { relayUrl: relay.url, localPort: local.port });

  for (const path of ["/", "/wait/abcd1234"]) {
    const res = await fetch(`${relay.url}${path}`, { headers: bearer("some-other-token") });
    assert.equal(res.status, 503, path);
    assert.deepEqual(await res.json(), { error: "no bridge connected" });
  }
});

test("streams response chunks as the bridge produces them instead of buffering until the end", async (t) => {
  const local = await startLocal(t, async (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("event: a\n\n");
    await sleep(400);
    res.write("event: b\n\n");
    await sleep(400);
    res.end("event: c\n\n");
  });
  const relay = await startRelay(t);
  await startLink(t, { relayUrl: relay.url, localPort: local.port });

  const start = Date.now();
  const res = await fetch(`${relay.url}/mcp`, { method: "POST", headers: bearer() });
  const reader = res.body.getReader();
  const arrivals = [];
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    arrivals.push({ at: Date.now() - start, chunk: Buffer.from(value).toString() });
    text += Buffer.from(value).toString();
  }
  assert.match(text, /event: a/);
  assert.match(text, /event: b/);
  assert.match(text, /event: c/);
  const firstA = arrivals.find((a) => a.chunk.includes("event: a"));
  const firstB = arrivals.find((a) => a.chunk.includes("event: b"));
  assert.ok(firstA.at < 300, `first chunk should arrive promptly, got ${firstA.at}ms`);
  assert.ok(firstB.at - firstA.at > 250, `chunks should arrive spread out, got gap ${firstB.at - firstA.at}ms`);
});

test("serves concurrent requests; a long hold does not block a fast one", async (t) => {
  const local = await startLocal(t, async (req, res) => {
    if (req.url.includes("slow")) { await sleep(700); res.end("slow"); return; }
    res.end("fast");
  });
  const relay = await startRelay(t);
  await startLink(t, { relayUrl: relay.url, localPort: local.port });

  const slow = fetch(`${relay.url}/mcp?mode=slow`, { method: "POST", headers: bearer() }).then((r) => r.text());
  await sleep(60);
  const fastStart = Date.now();
  const fast = await (await fetch(`${relay.url}/mcp?mode=fast`, { method: "POST", headers: bearer() })).text();
  const fastMs = Date.now() - fastStart;
  assert.equal(fast, "fast");
  assert.ok(fastMs < 400, `fast request was blocked by the slow one: ${fastMs}ms`);
  assert.equal(await slow, "slow");
});

test("reconnects after the link drops and serves again", async (t) => {
  const local = await startLocal(t, (req, res) => res.end("alive"));
  const relay = await startRelay(t);
  await startLink(t, { relayUrl: relay.url, localPort: local.port });

  assert.equal(await (await fetch(`${relay.url}/mcp`, { method: "POST", headers: bearer() })).text(), "alive");
  assert.equal(relay.relay.linkCount, 1);

  relay.relay.close(); // simulate a relay restart dropping every link
  await sleep(1600); // plugin backoff is ~1s for the first retry

  const res = await fetch(`${relay.url}/mcp`, { method: "POST", headers: bearer() });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "alive");
  assert.equal(relay.relay.linkCount, 1);
});
