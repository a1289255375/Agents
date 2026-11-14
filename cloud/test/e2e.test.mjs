// End to end: a real MCP client plays the cloud agent against the running bridge, and the console's
// HTTP API plays the user at the web page.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import nodePath from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge } from "../src/main.mjs";
import { fakeCursorApi, sse, tempDir, until, windows, writeTree } from "./helpers.mjs";

const token = "test-token-0123456789-abcdefghijklmnop";
const nodeCommand = (script) => `node ${script}`;

async function setup(t, overrides = {}) {
  const root = overrides.root ?? await tempDir(t);
  await writeTree(root, {
    "src/app.js": "const greeting = 'hello';\r\nconsole.log(greeting);\r\n",
    "say.js": "console.log('said ' + process.argv[2]);",
  });
  const remembered = [];
  const bridge = await startBridge({
    root, token, port: 0, mcpPort: 0, policy: "ask", waitMs: 500, legacyEncoding: "gbk", consoleEncoding: "gbk",
    rememberPublicUrl: async (url) => { remembered.push(url); },
    ...overrides,
  });
  t.after(() => bridge.stop());

  const web = async (path, { method = "GET", body } = {}) => {
    const response = await fetch(new URL(path, bridge.consoleUrl), {
      method, headers: body ? { "Content-Type": "application/json" } : {}, body: body && JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const state = async (session) => (await web(`/api/state?now=1${session ? `&session=${session}` : ""}`)).data;
  return { root, bridge, web, state, remembered, agent: (bearer) => agent(t, bridge.localMcpUrl, bearer) };
}

// One MCP client connection, as the cloud agent's backend would open it.
async function agent(t, url, bearer = token) {
  const client = new Client({ name: "e2e-agent", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  t.after(() => client.close());
  const call = async (name, args = {}, options) => {
    const result = await client.callTool({ name, arguments: args }, undefined, options);
    const { text } = result.content[0];
    return { text, isError: result.isError === true, data: text.startsWith("{") ? JSON.parse(text) : undefined };
  };
  return { client, call };
}

function rawRequest(url, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8").on("data", (chunk) => { body += chunk; }).on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on("error", reject).end();
  });
}

test("the MCP endpoint requires the bearer token", async (t) => {
  const { bridge, state, agent: connectAgent } = await setup(t);
  const post = (headers) => fetch(bridge.localMcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  const missing = await post({});
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get("www-authenticate"), "Bearer");
  assert.equal((await post({ Authorization: "Bearer wrong-token" })).status, 401);
  assert.equal((await post({ Authorization: `Basic ${token}` })).status, 401);
  assert.equal((await post({ Authorization: `Bearer ${token}x` })).status, 401);
  await assert.rejects(connectAgent("not-the-token"));
  assert.equal((await post({ Authorization: `Bearer ${token}` })).status, 200);

  // The token must not work in the URL, where proxies and logs would record it.
  assert.equal((await fetch(`${bridge.localMcpUrl}?token=${token}`, { method: "POST" })).status, 401);
  assert.equal((await fetch(bridge.localMcpUrl, { headers: { Authorization: `Bearer ${token}` } })).status, 405);

  // The health check says nothing but which instance this is; everything else is closed.
  const health = await fetch(new URL("/", bridge.localMcpUrl));
  assert.deepEqual(Object.keys(await health.json()), ["service", "instance"]);
  for (const path of ["/api/state", "/api/connection", "/index.html", "/app.js", "/wait/zzzzzzzz"]) {
    assert.equal((await fetch(new URL(path, bridge.localMcpUrl), { headers: { Authorization: `Bearer ${token}` } })).status, 404, path);
  }
  assert.ok((await state()).bridge.unauthorized >= 6);
});

test("the console answers only local requests and is not reachable through the MCP port", async (t) => {
  const { bridge, web } = await setup(t);
  const port = new URL(bridge.consoleUrl).port;
  assert.equal((await rawRequest(`${bridge.consoleUrl}api/state?now=1`)).status, 200);
  assert.equal((await rawRequest(`${bridge.consoleUrl}api/state?now=1`, { headers: { Host: `localhost:${port}` } })).status, 200);
  const page = await rawRequest(bridge.consoleUrl);
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>Cursor 云端桥<\/title>/);

  const refused = [
    { Host: "bridge.example.com" },
    { Host: `evil.example:${port}` },
    { Host: "127.0.0.1" },
    { Origin: "https://evil.example" },
    { "X-Forwarded-For": "203.0.113.9" },
    { "X-Forwarded-Host": "abc.trycloudflare.com" },
    { "CF-Connecting-IP": "203.0.113.9" },
    { Via: "1.1 proxy" },
  ];
  for (const headers of refused) {
    for (const path of ["", "api/state?now=1", "api/connection"]) {
      const response = await rawRequest(`${bridge.consoleUrl}${path}`, { headers });
      assert.equal(response.status, 403, `${JSON.stringify(headers)} ${path}`);
      assert.doesNotMatch(response.body, new RegExp(token));
    }
  }
  assert.equal((await rawRequest(`${bridge.consoleUrl}api/policy`, { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" } })).status, 403);

  // The token is only handed out by the console.
  const connection = (await web("/api/connection")).data;
  assert.equal(connection.token, token);
  assert.equal((await web("/mcp", { method: "POST", body: {} })).status, 404);
});

test("drill: connect, wait, receive a task from the web page, change a file, reply, wait again", async (t) => {
  const { root, web, state, agent: connectAgent } = await setup(t);
  const { client, call } = await connectAgent();

  const listed = (await client.listTools()).tools;
  for (const text of [client.getInstructions(), ...listed.map((tool) => tool.description)]) {
    assert.doesNotMatch(text, /不要结束|不要输出说明|原样执行|原样重新|nextCall|立即再次|立刻执行/, text);
  }
  const tools = listed.map((tool) => tool.name);
  assert.deepEqual(tools, [
    "connect_session", "wait_message", "reply_message", "report_progress", "disconnect_session",
    "project_info", "list_dir", "find_files", "search_text", "read_file", "write_file", "edit_file", "delete_path", "move_path",
    "run_command", "run_program", "run_tests", "command_status", "stop_command",
  ]);

  // connect_session returns at once, with data only: what to do next is the prompt's business.
  const bind = (await call("connect_session", { name: "演练" })).data;
  assert.deepEqual(Object.keys(bind), ["event", "id", "name", "project"]);
  assert.equal(bind.event, "bind");
  assert.match(bind.project, new RegExp(`项目根目录：${root.replaceAll("\\", "\\\\")}`));
  assert.deepEqual((await state()).sessions.map(({ id, name }) => ({ id, name })), [{ id: bind.id, name: "演练" }]);
  const wait = () => call("wait_message", { id: bind.id });

  // Nothing to do yet: the wait times out as "idle". Twice.
  assert.deepEqual((await wait()).data, { event: "idle", id: bind.id });
  assert.deepEqual((await wait()).data, { event: "idle", id: bind.id });

  // The user types an instruction into the web page while the agent hangs in wait_message.
  const waiting = wait();
  await until(async () => (await state()).sessions[0].status === "waiting", "session to be waiting");
  const sent = await web(`/api/sessions/${bind.id}/messages`, { method: "POST", body: { text: "把 greeting 改成 你好" } });
  assert.equal(sent.status, 200);
  const task = (await waiting).data;
  assert.deepEqual(task, { event: "message", seq: 1, message: "把 greeting 改成 你好", queued: 0, id: bind.id });
  assert.equal((await state()).sessions[0].status, "working");

  // The agent works on the local project through the project tools.
  const session = bind.id;
  assert.match((await call("find_files", { pattern: "*.js", session })).text, /src\/app\.js/);
  assert.match((await call("search_text", { pattern: "greeting", session })).text, /src\/app\.js\n {2}1:const greeting = 'hello';/);
  const read = await call("read_file", { path: windows ? "src\\app.js" : "src/app.js", session });
  assert.equal(read.text, "src/app.js（共 2 行，utf8，CRLF）\n     1|const greeting = 'hello';\n     2|console.log(greeting);");
  const edit = await call("edit_file", { path: "src/app.js", old_string: "'hello';\nconsole", new_string: "'你好';\nconsole", session });
  assert.equal(edit.text, "已修改 src/app.js：替换 1 处（第 1 行）");
  assert.equal(await fs.readFile(nodePath.join(root, "src/app.js"), "utf8"), "const greeting = '你好';\r\nconsole.log(greeting);\r\n");
  assert.match((await call("write_file", { path: "docs/说明.md", content: "# 说明\n", session })).text, /^已写入 docs\/说明\.md（新建，1 行，utf8，LF）/);
  assert.deepEqual((await call("report_progress", { id: session, text: "文件已改，正在运行验证" })).data, { event: "progress", id: session, sent: true, queued: 0 });

  // Commands need the user's approval on the web page (default policy "ask").
  const command = await call("run_command", { command: nodeCommand("src/app.js"), session });
  assert.match(command.text, /^\[c1\] 等待用户在网页控制台确认这条命令/);
  const pending = (await state()).bridge.jobs;
  assert.deepEqual(pending.map(({ id, command: line, state: jobState, session: owner }) => ({ id, line, jobState, owner })),
    [{ id: "c1", line: nodeCommand("src/app.js"), jobState: "awaiting_approval", owner: session }]);
  assert.equal((await web("/api/jobs/c1/decision", { method: "POST", body: { decision: "allow" } })).status, 200);
  let output = (await call("command_status", { jobId: "c1", session })).text;
  while (output.includes("仍在运行")) output = (await call("command_status", { jobId: "c1", session })).text;
  assert.match(output, /^\[c1\] 已结束，退出码 0，.*\n你好\n$/s);

  // Reply, then wait again.
  const replied = (await call("reply_message", { id: session, text: "已把 greeting 改成 **你好**，运行输出正常。" })).data;
  assert.deepEqual(replied, { event: "replied", id: session, sent: true, queued: 0 });
  const again = wait();
  await until(async () => (await state()).sessions[0].status === "waiting", "session to wait again");

  // The web page shows the conversation and what the agent did on this machine.
  const view = await state(session);
  assert.deepEqual(view.session.timeline.map(({ role, text, state: itemState }) => [role, text, itemState]), [
    ["note", "云端 Agent 已接入", undefined],
    ["user", "把 greeting 改成 你好", "done"],
    ["progress", "文件已改，正在运行验证", undefined],
    ["assistant", "已把 greeting 改成 **你好**，运行输出正常。", undefined],
  ]);
  const activity = view.activity.filter((entry) => entry.session === session);
  assert.deepEqual(activity.map(({ tool, ok, target }) => [tool, ok, target]), [
    ["find_files", true, "*.js"],
    ["search_text", true, "greeting"],
    ["read_file", true, "src/app.js"],
    ["edit_file", true, "src/app.js"],
    ["write_file", true, "docs/说明.md"],
    ["run_command", undefined, nodeCommand("src/app.js")],
  ]);
  assert.match(activity[3].diff, /-const greeting = 'hello';\n\+const greeting = '你好';/);
  assert.equal(activity[5].job.state, "exited");
  assert.match(activity[5].job.outputTail, /你好/);

  // A second instruction reaches the same loop.
  await web(`/api/sessions/${session}/messages`, { method: "POST", body: { text: "谢谢" } });
  assert.equal((await again).data.message, "谢谢");
});

test("the agent cannot leave the project root through the MCP tools", async (t) => {
  const { root, state, agent: connectAgent } = await setup(t);
  await fs.writeFile(nodePath.join(root, "..", `outside-${nodePath.basename(root)}.txt`), "secret");
  t.after(() => fs.rm(nodePath.join(root, "..", `outside-${nodePath.basename(root)}.txt`), { force: true }));
  const { call } = await connectAgent();
  const session = (await call("connect_session")).data.id;

  const outside = `../outside-${nodePath.basename(root)}.txt`;
  for (const [name, args] of [
    ["read_file", { path: outside }],
    ["read_file", { path: nodePath.join(root, outside) }],
    ["write_file", { path: outside, content: "x" }],
    ["edit_file", { path: outside, old_string: "secret", new_string: "x" }],
    ["delete_path", { path: outside }],
    ["move_path", { from: "say.js", to: outside }],
    ["move_path", { from: outside, to: "stolen.txt" }],
    ["list_dir", { path: ".." }],
    ["search_text", { pattern: "secret", path: ".." }],
    ["find_files", { pattern: "*", path: ".." }],
    ["run_command", { command: "echo x", cwd: ".." }],
  ]) {
    const result = await call(name, { ...args, session });
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(result.text, /路径在项目根目录之外/, name);
  }
  assert.equal(await fs.readFile(nodePath.join(root, outside), "utf8"), "secret");
  assert.match((await call("write_file", { path: ".git/hooks/pre-commit", content: "x", session })).text, /不允许用文件工具改动 \.git 目录/);

  const failures = (await state()).activity.filter((entry) => entry.ok === false);
  assert.equal(failures.length, 12);
  assert.ok(failures.every((entry) => entry.session === session && entry.error));
});

test("a wait cut off by a dropped connection or a client timeout loses and duplicates nothing", async (t) => {
  const { web, state, agent: connectAgent } = await setup(t, { waitMs: 5000 });
  const first = await connectAgent();
  const { id } = (await first.call("connect_session")).data;
  const send = (text) => web(`/api/sessions/${id}/messages`, { method: "POST", body: { text } });

  // The connection drops in the middle of a wait (tunnel restart, network change).
  const dropped = first.call("wait_message", { id });
  dropped.catch(() => {});
  await until(async () => (await state()).sessions[0].status === "waiting", "first wait");
  await first.client.close();
  await until(async () => (await state()).sessions[0].status !== "waiting", "the server to notice the drop");
  assert.equal((await state()).sessions[0].hint.holdMs, 5000);

  // The user sends while nobody is listening; the message waits for the agent to come back.
  await send("断线期间的指令");
  assert.equal((await state()).sessions[0].queued, 1);
  const second = await connectAgent();
  const received = (await second.call("wait_message", { id })).data;
  assert.equal(received.message, "断线期间的指令");
  assert.equal(received.redelivered, undefined);

  // The agent never saw that response and waits again: same message, flagged as a redelivery.
  const repeated = (await second.call("wait_message", { id })).data;
  assert.equal(repeated.message, "断线期间的指令");
  assert.equal(repeated.redelivered, true);
  assert.equal(repeated.instruction, undefined);
  assert.equal((await second.call("reply_message", { id, text: "收到" })).data.event, "replied");
  // A retried reply shows up once.
  await second.call("reply_message", { id, text: "收到" });
  assert.equal((await state(id)).session.timeline.filter((item) => item.role === "assistant").length, 1);

  // The client gives up on a wait (tool call timeout) but the request stays open on the server.
  await assert.rejects(second.call("wait_message", { id }, { timeout: 300 }), /timed out/i);
  const fresh = second.call("wait_message", { id });
  await until(async () => (await state()).sessions[0].waiting?.since > 0 && (await state()).sessions[0].status === "waiting", "fresh wait");
  await sleep(100);
  await send("超时之后的指令");
  const delivered = (await fresh).data;
  assert.equal(delivered.message, "超时之后的指令");
  assert.equal(delivered.redelivered, undefined);
  await second.call("reply_message", { id, text: "也收到" });

  const timeline = (await state(id)).session.timeline.filter((item) => item.role !== "note").map(({ role, text, state: itemState }) => [role, text, itemState]);
  assert.deepEqual(timeline, [
    ["user", "断线期间的指令", "done"],
    ["assistant", "收到", undefined],
    ["user", "超时之后的指令", "done"],
    ["assistant", "也收到", undefined],
  ]);
});

test("the agent's loop survives a restart of the bridge", async (t) => {
  const root = await tempDir(t);
  const before = await setup(t, { root });
  const old = await before.agent();
  const { id } = (await old.call("connect_session", { name: "重启前" })).data;
  await before.bridge.stop();

  // Same token and project, new process. The agent still holds its old id and just calls wait again.
  const after = await setup(t, { root });
  const agentAgain = await after.agent();
  const waiting = agentAgain.call("wait_message", { id });
  const session = await until(async () => (await after.state(id)).session, "the session to be adopted");
  assert.match(session.timeline[0].text, /服务重启后/);
  await after.web(`/api/sessions/${id}/messages`, { method: "POST", body: { text: "重启后还能用吗" } });
  assert.equal((await waiting).data.message, "重启后还能用吗");
  // connect_session with the old id works as well.
  assert.equal((await agentAgain.call("connect_session", { id })).data.id, id);
});

test("several cloud sessions work side by side", async (t) => {
  const { web, state, agent: connectAgent } = await setup(t, { waitMs: 5000 });
  const [a, b] = [await connectAgent(), await connectAgent()];
  const [idA, idB] = [(await a.call("connect_session", { name: "A" })).data.id, (await b.call("connect_session", { name: "B" })).data.id];
  assert.notEqual(idA, idB);
  const [waitA, waitB] = [a.call("wait_message", { id: idA }), b.call("wait_message", { id: idB })];
  await until(async () => (await state()).sessions.every((session) => session.status === "waiting"), "both sessions to wait");

  await web(`/api/sessions/${idB}/messages`, { method: "POST", body: { text: "只给 B" } });
  assert.equal((await waitB).data.message, "只给 B");
  assert.deepEqual((await state()).sessions.map(({ name, status }) => [name, status]), [["B", "working"], ["A", "waiting"]]);

  // Without a session argument a tool call cannot be attributed while two sessions are open.
  await b.call("read_file", { path: "say.js", session: idB });
  await a.call("read_file", { path: "say.js" });
  assert.deepEqual((await state()).activity.map((entry) => entry.session), [idB, undefined]);

  await web(`/api/sessions/${idA}/messages`, { method: "POST", body: { text: "只给 A" } });
  assert.equal((await waitA).data.message, "只给 A");
});

test("the user ends or deletes a session from the web page", async (t) => {
  const { web, state, agent: connectAgent } = await setup(t, { waitMs: 5000 });
  const { call } = await connectAgent();
  const { id } = (await call("connect_session")).data;
  const waiting = call("wait_message", { id });
  await until(async () => (await state()).sessions[0].status === "waiting", "the wait");

  assert.equal((await web(`/api/sessions/${id}/disconnect`, { method: "POST" })).data.status, "disconnected");
  assert.deepEqual((await waiting).data, { event: "disconnected", id });
  assert.deepEqual((await call("wait_message", { id })).data, { event: "disconnected", id });
  assert.deepEqual((await call("reply_message", { id, text: "x" })).data, { event: "disconnected", id });
  const refused = await web(`/api/sessions/${id}/messages`, { method: "POST", body: { text: "x" } });
  assert.deepEqual([refused.status, refused.data.error], [409, "会话已断开，不能再发送消息"]);
  assert.equal((await web(`/api/sessions/${id}/messages`, { method: "POST", body: { text: "   " } })).status, 400);

  assert.deepEqual((await web(`/api/sessions/${id}`, { method: "DELETE" })).data, { id, deleted: true });
  assert.deepEqual((await state()).sessions, []);
  assert.equal((await web(`/api/sessions/${id}`, { method: "DELETE" })).status, 404);

  // The agent ends a session itself.
  const own = (await call("connect_session")).data.id;
  assert.equal((await call("disconnect_session", { id: own })).data.disconnected, true);
  assert.equal((await state(own)).session.closed, "agent");
  assert.equal((await call("wait_message", { id: "not-an-id" })).isError, true);
});

test("the command policy is enforced and can be changed from the web page", async (t) => {
  const { web, state, agent: connectAgent } = await setup(t, { waitMs: 3000 });
  const { call } = await connectAgent();
  const session = (await call("connect_session")).data.id;
  assert.equal((await state()).bridge.policy, "ask");

  // ask: the call hangs until the user decides; a refusal is reported to the agent.
  const asked = call("run_command", { command: nodeCommand("say.js one"), session });
  await until(async () => (await state()).bridge.jobs.length === 1, "the approval request");
  await web("/api/jobs/c1/decision", { method: "POST", body: { decision: "deny" } });
  assert.match((await asked).text, /^\[c1\] 用户拒绝执行这条命令/);
  assert.equal((await web("/api/jobs/c1/decision", { method: "POST", body: { decision: "allow" } })).status, 409);
  assert.equal((await web("/api/jobs/c1/decision", { method: "POST", body: { decision: "maybe" } })).status, 400);

  // deny: nothing runs, and the agent is told why.
  assert.equal((await web("/api/policy", { method: "POST", body: { policy: "deny" } })).status, 200);
  const denied = await call("run_command", { command: nodeCommand("say.js two"), session });
  assert.equal(denied.isError, true);
  assert.match(denied.text, /用户已禁用命令执行/);
  assert.match((await call("project_info", { session })).text, /命令策略：禁止/);

  // allow: runs at once.
  await web("/api/policy", { method: "POST", body: { policy: "allow" } });
  let allowed = (await call("run_command", { command: nodeCommand("say.js three"), session })).text;
  while (allowed.includes("仍在运行")) allowed = (await call("command_status", { jobId: "c2", session })).text;
  assert.match(allowed, /已结束，退出码 0，.*\nsaid three\n$/s);
  assert.equal((await web("/api/policy", { method: "POST", body: { policy: "everything" } })).status, 400);

  // The user stops a running command from the web page.
  const running = call("run_command", { command: "node -e \"setTimeout(() => {}, 60000)\"", session });
  const job = await until(async () => (await state()).bridge.jobs.find((item) => item.state === "running"), "the running command");
  assert.equal((await web(`/api/jobs/${job.id}/stop`, { method: "POST" })).status, 200);
  assert.match((await running).text, /已被终止/);
  assert.match((await call("stop_command", { jobId: job.id, session })).text, /已被终止/);
});

test("the agent names itself on connect_session, and its thinking is read from Cursor", async (t) => {
  const agentId = "bc-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
  const api = await fakeCursorApi(t, [
    (req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sse("thinking", { text: "用户要我" }, "1"));
      res.write(sse("thinking", { text: "先读 README" }, "2"));
      res.write(sse("tool_call", { callId: "c1", name: "mcp", status: "running" }, "3"));
      res.write(sse("thinking", { text: "README 只有一行" }, "4"));
    },
  ]);
  const { state, agent: connectAgent } = await setup(t, { cursorApiKey: "key_e2e", cursorApiBase: api.base });
  const { call } = await connectAgent();
  const bind = (await call("connect_session", { agent: agentId })).data;
  assert.deepEqual(Object.keys(bind), ["event", "id", "name", "project"]);
  const { id } = bind;

  const thinking = await until(async () => {
    const items = (await state(id)).session.timeline.filter(({ role }) => role === "thinking");
    return items.length === 2 && items.map(({ text }) => text);
  }, "thinking in the console");
  assert.deepEqual(thinking, ["用户要我先读 README", "README 只有一行"]);
  // Connecting again with the same agent keeps the one stream.
  await call("connect_session", { id, agent: agentId });
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].url, `/v1/agents/${agentId}/stream`);
  assert.equal(api.requests[0].headers.authorization, "Bearer key_e2e");

  // Something that is not an agent id is refused at the door.
  const refused = await call("connect_session", { agent: "$CURSOR_CONVERSATION_ID" });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /agent 应为 Cloud Agent 的 id/);
});

test("without an agent id or an API key the bridge works and shows no thinking", async (t) => {
  const api = await fakeCursorApi(t, []);
  const noAgent = await setup(t, { cursorApiKey: "key_e2e", cursorApiBase: api.base });
  const noKey = await setup(t);
  for (const [{ web, state, agent: connectAgent }, args] of [[noAgent, {}], [noKey, { agent: "bc-1" }]]) {
    const { call } = await connectAgent();
    const { id } = (await call("connect_session", args)).data;
    const waiting = call("wait_message", { id });
    await until(async () => (await state()).sessions[0].status === "waiting", "the wait");
    await web(`/api/sessions/${id}/messages`, { method: "POST", body: { text: "照常工作" } });
    assert.equal((await waiting).data.message, "照常工作");
    assert.deepEqual((await state(id)).session.timeline.filter(({ role }) => role === "thinking"), []);
  }
  assert.equal(api.requests.length, 0);
});

test("the public address is checked against this very process", async (t) => {
  const { bridge, web, state, remembered } = await setup(t);
  const base = new URL(bridge.localMcpUrl).origin;
  const before = (await web("/api/connection")).data;
  assert.equal(before.ready, false);
  assert.match(before.config, /https:\/\/<你的隧道地址>\/mcp/);
  // The prompt carries the whole loop; the tool results carry none of it.
  assert.match(before.prompt, /connect_session[\s\S]*wait_message[\s\S]*reply_message[\s\S]*event=idle[\s\S]*disconnect_session/);
  assert.match(before.prompt, /CURSOR_CONVERSATION_ID[\s\S]*"agent"/);
  assert.doesNotMatch(before.prompt, /不要结束|不要输出说明|原样执行|原样重新|nextCall|shellWait|curl/);

  // People paste the address with /mcp or a trailing slash.
  const set = await web("/api/public-url", { method: "POST", body: { url: `${base}/mcp/` } });
  assert.deepEqual([set.status, set.data.ok, set.data.url], [200, true, base]);
  assert.deepEqual(remembered, [base]);
  const view = (await state()).bridge;
  assert.equal(view.publicUrl, base);
  assert.equal(view.selfTest.ok, true);
  const connection = (await web("/api/connection")).data;
  assert.deepEqual(JSON.parse(connection.config), {
    mcpServers: { "cursor-cloud-bridge": { url: `${base}/mcp`, headers: { Authorization: `Bearer ${token}` } } },
  });
  // Another bridge, a foreign server and a dead address are told apart.
  const other = await setup(t);
  const foreign = http.createServer((req, res) => res.end("<html>hello</html>"));
  await new Promise((resolve) => { foreign.listen(0, "127.0.0.1", resolve); });
  t.after(() => foreign.close());
  const foreignUrl = `http://127.0.0.1:${foreign.address().port}`;
  const check = async (url) => (await web("/api/public-url", { method: "POST", body: { url } })).data;
  assert.match((await check(other.bridge.localMcpUrl)).message, /另一个云端桥进程/);
  assert.match((await check(foreignUrl)).message, /有响应（HTTP 200），但不是本服务/);
  await new Promise((resolve) => { foreign.close(resolve); });
  const dead = await check(foreignUrl);
  assert.deepEqual([dead.ok, /从本机访问不到这个地址（ECONNREFUSED）/.test(dead.message)], [false, true]);
  assert.equal((await web("/api/selftest", { method: "POST" })).data.ok, false);

  const invalid = await web("/api/public-url", { method: "POST", body: { url: "not a url" } });
  assert.deepEqual([invalid.status, /公网地址应是 https:\/\/ 开头的完整网址/.test(invalid.data.error)], [409, true]);
  assert.equal((await check("")).message, "已清除公网地址");
  assert.equal((await state()).bridge.publicUrl, null);
  assert.equal(remembered.at(-1), undefined);
});

test("drill: run_program and run_tests through the local bridge", async (t) => {
  const { root, web, state, agent: connectAgent } = await setup(t, { policy: "allow" });
  await writeTree(root, {
    "package.json": JSON.stringify({ scripts: { test: "node say.js tests" } }),
    "argv.js": "console.log(JSON.stringify(process.argv.slice(2))); console.error('warn'); require('fs').writeFileSync('out.txt', 'x');",
  });
  const { call } = await connectAgent();
  const session = (await call("connect_session", { name: "新工具", key: "conv-1", meta: { conversation: "conv-1" } })).data.id;
  // The same key comes back to the same session, with no id given.
  assert.equal((await call("connect_session", { key: "conv-1" })).data.id, session);

  await web(`/api/sessions/${session}/messages`, { method: "POST", body: { text: "跑一下" } });
  assert.equal((await call("wait_message", { id: session })).data.event, "message");

  const program = await call("run_program", { session, program: process.execPath, args: ["argv.js", "a b", "x&y"] });
  assert.match(program.text, /^\[c1\] 已结束，退出码 0，.*（直接启动，目录 \.）\n\["a b","x&y"\]\n/s);
  assert.match(program.text, /── stderr 部分.*\nwarn\n── 文件变更：新增 1，/s);

  const tests = await call("run_tests", { session });
  assert.match(tests.text, /^测试命令：npm test（依据 package\.json 的 test 脚本（npm））\n\[c2\] /);
  // npm is a slow-starting .cmd on Windows, so poll until the job is final instead of assuming one wait.
  let status = tests.text;
  while (status.includes("仍在运行")) status = (await call("command_status", { jobId: "c2", session })).text;
  assert.match(status, /\[c2\] 已结束，退出码 0，/);
  assert.match(status, /said tests/);

  assert.equal((await call("reply_message", { id: session, text: "都跑完了" })).data.event, "replied");
  const view = await state(session);
  assert.deepEqual(view.session.timeline.slice(2).map(({ role, text }) => [role, text]), [["user", "跑一下"], ["assistant", "都跑完了"]]);
  assert.deepEqual(view.activity.map(({ tool, job }) => [tool, job.tool, job.exitCode]), [["run_program", "run_program", 0], ["run_tests", "run_tests", 0]]);
  assert.deepEqual(view.activity[0].job.changes, { added: ["out.txt"], modified: [], deleted: [] });
  assert.deepEqual([view.activity[0].job.stdoutTail, view.activity[0].job.stderrTail], ['["a b","x&y"]\n', "warn\n"]);
  assert.equal(view.sessions[0].key, "conv-1");
});
