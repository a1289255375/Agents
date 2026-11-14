// End to end through the relay: a real MCP client plays the cloud agent and talks only to the relay's
// /mcp, the bridge dials the relay from the "plugin" side, and the console API plays the user. This is
// the whole chain the public server runs, exercised in-process over plain HTTP (TLS is orthogonal).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import nodePath from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createRelay } from "../relay/relay.mjs";
import { startBridge } from "../src/main.mjs";
import { tempDir, writeTree } from "./helpers.mjs";

const token = "relay-e2e-token-0123456789-abcdefghij";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

async function until(check, message) {
  for (let attempt = 0; attempt < 240; attempt++) {
    const value = await check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`timed out waiting for: ${message}`);
}

async function setup(t, overrides = {}) {
  const root = await tempDir(t);
  await writeTree(root, {
    "src/app.js": "const greeting = 'hello';\r\nconsole.log(greeting);\r\n",
    "say.js": "console.log('said ' + process.argv[2]);\r\nconsole.error('warn ' + process.argv[2]);\r\n",
  });
  const relay = createRelay({ log: () => {} });
  const relayServer = createServer(relay.handleRequest);
  relayServer.on("upgrade", relay.handleUpgrade);
  const relayPort = await listen(relayServer);
  t.after(() => { relay.close(); relayServer.closeAllConnections?.(); relayServer.close(); });
  const relayUrl = `http://127.0.0.1:${relayPort}`;

  const bridge = await startBridge({
    root, token, port: 0, mcpPort: 0, policy: "allow", waitMs: 1500, shellWaitMs: 0,
    legacyEncoding: "gbk", consoleEncoding: "gbk", relayUrl, ...overrides,
  });
  t.after(() => bridge.stop());
  await until(() => relay.linkCount === 1, "the plugin link to register with the relay");

  const web = async (path, { method = "GET", body } = {}) => {
    const response = await fetch(new URL(path, bridge.consoleUrl), {
      method, headers: body ? { "Content-Type": "application/json" } : {}, body: body && JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const state = async (session) => (await web(`/api/state?now=1${session ? `&session=${session}` : ""}`)).data;
  return { root, bridge, relay, relayUrl, web, state };
}

async function agent(t, url, bearer = token) {
  const client = new Client({ name: "relay-e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  t.after(() => client.close());
  const call = async (name, args = {}, options) => {
    const result = await client.callTool({ name, arguments: args }, undefined, options);
    const { text } = result.content[0];
    return { text, isError: result.isError === true, data: text.startsWith("{") ? JSON.parse(text) : undefined };
  };
  return { client, call };
}

test("relay e2e: the agent drives the bridge entirely through the relay's /mcp", async (t) => {
  const { root, relayUrl, web, state } = await setup(t);
  const { client, call } = await agent(t, `${relayUrl}/mcp`);

  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ["connect_session", "wait_message", "report_thinking", "edit_file", "run_command", "command_status"]) {
    assert.ok(tools.includes(name), `tools should include ${name}`);
  }

  const bind = (await call("connect_session", { name: "中继演练" })).data;
  assert.equal(bind.event, "bind");

  // Nothing queued yet: the held wait times out as idle and tells the agent to wait again.
  const idle = (await call("wait_message", { id: bind.id })).data;
  assert.equal(idle.event, "idle");

  // A wait held open while the user types in the console; the held response carries the message back.
  const waiting = call("wait_message", { id: bind.id });
  await until(async () => (await state()).sessions[0].status === "waiting", "the session to be waiting");
  await web(`/api/sessions/${bind.id}/messages`, { method: "POST", body: { text: "把 greeting 改成 你好" } });
  const task = (await waiting).data;
  assert.equal(task.message, "把 greeting 改成 你好");

  // report_thinking reaches the console timeline.
  assert.equal((await call("report_thinking", { id: bind.id, text: "开始改文件" })).data.event, "thinking");

  // A file edit lands on disk.
  assert.match((await call("edit_file", { path: "src/app.js", old_string: "'hello'", new_string: "'你好'", session: bind.id })).text, /替换 1 处/);
  assert.equal(await fs.readFile(nodePath.join(root, "src/app.js"), "utf8"), "const greeting = '你好';\r\nconsole.log(greeting);\r\n");

  // A command runs with stdout, stderr and an exit code.
  let output = (await call("run_command", { command: "node say.js hi", session: bind.id })).text;
  while (output.includes("仍在运行")) output = (await call("command_status", { jobId: "c1", session: bind.id })).text;
  assert.match(output, /\[c1\] 已结束，退出码 0，/);
  assert.match(output, /said hi/);
  assert.match(output, /warn hi/);

  assert.equal((await call("reply_message", { id: bind.id, text: "改好了" })).data.event, "replied");
  const view = await state(bind.id);
  assert.deepEqual(view.session.timeline.map(({ role }) => role), ["note", "user", "thinking", "assistant"]);
});

test("relay e2e: two sessions run side by side over one relay link", async (t) => {
  const { relayUrl, web, state } = await setup(t, { waitMs: 6000 });
  const a = await agent(t, `${relayUrl}/mcp`);
  const b = await agent(t, `${relayUrl}/mcp`);
  const idA = (await a.call("connect_session", { name: "A" })).data.id;
  const idB = (await b.call("connect_session", { name: "B" })).data.id;
  assert.notEqual(idA, idB);

  const waitA = a.call("wait_message", { id: idA });
  const waitB = b.call("wait_message", { id: idB });
  await until(async () => (await state()).sessions.length === 2 && (await state()).sessions.every((s) => s.status === "waiting"), "both sessions to wait");

  await web(`/api/sessions/${idB}/messages`, { method: "POST", body: { text: "只给 B" } });
  assert.equal((await waitB).data.message, "只给 B");
  await web(`/api/sessions/${idA}/messages`, { method: "POST", body: { text: "只给 A" } });
  assert.equal((await waitA).data.message, "只给 A");
});

test("relay e2e: the bridge reconnects the link on its own and the agent keeps working", async (t) => {
  const { relay, relayUrl, web, state } = await setup(t, { waitMs: 6000 });
  const { call } = await agent(t, `${relayUrl}/mcp`);
  const { id } = (await call("connect_session")).data;

  relay.close(); // the link drops, as if the relay restarted or the network blipped
  await until(() => relay.linkCount === 1, "the bridge to re-register its link");

  const waiting = call("wait_message", { id });
  await until(async () => (await state()).sessions[0]?.status === "waiting", "the session to wait after reconnect");
  await web(`/api/sessions/${id}/messages`, { method: "POST", body: { text: "断线重连后还能用" } });
  assert.equal((await waiting).data.message, "断线重连后还能用");
});
