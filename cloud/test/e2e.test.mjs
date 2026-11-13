// End to end: a real MCP client plays the cloud agent against the running bridge, and the console's
// HTTP API plays the user at the web page.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import nodePath from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { waitTicket } from "../src/auth.mjs";
import { startBridge } from "../src/main.mjs";
import { tempDir, windows, writeTree } from "./helpers.mjs";

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
    root, token, port: 0, mcpPort: 0, policy: "ask", waitMs: 500, shellWaitMs: 1500, legacyEncoding: "gbk", consoleEncoding: "gbk",
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
  return { client, call, next: (nextCall) => call(nextCall.name, nextCall.arguments) };
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

async function until(check, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`timed out waiting for: ${message}`);
}

// A shell poll that began after `since` is in flight. Between two polls the console still shows the
// previous one, so the start time is what tells a new poll apart.
const shellPoll = (state, since) => until(async () => {
  const { waiting } = (await state()).sessions[0];
  return waiting?.via === "shell" && waiting.since >= since;
}, "a shell poll to start");

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
  const { client, call, next } = await connectAgent();

  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(tools, [
    "connect_session", "wait_message", "reply_message", "report_progress", "disconnect_session",
    "project_info", "list_dir", "find_files", "search_text", "read_file", "write_file", "edit_file", "delete_path", "move_path",
    "run_command", "command_status", "stop_command",
  ]);

  // connect_session returns at once with the call that starts the wait.
  const bind = (await call("connect_session", { name: "演练" })).data;
  assert.equal(bind.event, "bind");
  assert.deepEqual(bind.nextCall, { name: "wait_message", arguments: { id: bind.id } });
  assert.match(bind.project, new RegExp(`项目根目录：${root.replaceAll("\\", "\\\\")}`));
  assert.deepEqual((await state()).sessions.map(({ id, name }) => ({ id, name })), [{ id: bind.id, name: "演练" }]);

  // Nothing to do yet: the wait times out as "idle" and tells the agent to wait again. Twice.
  const idle = (await next(bind.nextCall)).data;
  assert.equal(idle.event, "idle");
  assert.match(idle.instruction, /立即再次执行 nextCall 继续等待/);
  assert.equal((await next(idle.nextCall)).data.event, "idle");

  // The user types an instruction into the web page while the agent hangs in wait_message.
  const waiting = next(idle.nextCall);
  await until(async () => (await state()).sessions[0].status === "waiting", "session to be waiting");
  const sent = await web(`/api/sessions/${bind.id}/messages`, { method: "POST", body: { text: "把 greeting 改成 你好" } });
  assert.equal(sent.status, 200);
  const task = (await waiting).data;
  assert.equal(task.event, "message");
  assert.equal(task.message, "把 greeting 改成 你好");
  assert.equal(task.redelivered, undefined);
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
  assert.equal((await call("report_progress", { id: session, text: "文件已改，正在运行验证" })).data.sent, true);

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

  // Reply, then wait again as told.
  const replied = (await call("reply_message", { id: session, text: "已把 greeting 改成 **你好**，运行输出正常。" })).data;
  assert.equal(replied.event, "replied");
  assert.deepEqual(replied.nextCall, bind.nextCall);
  const again = next(replied.nextCall);
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
  assert.match(repeated.instruction, /之前已经投递过/);
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
  const ended = (await waiting).data;
  assert.equal(ended.event, "disconnected");
  assert.match(ended.instruction, /停止等待/);
  assert.equal((await call("wait_message", { id })).data.event, "disconnected");
  assert.equal((await call("reply_message", { id, text: "x" })).data.event, "disconnected");
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

test("shell wait: the curl poll delivers the same events with its own narrow ticket", async (t) => {
  const { bridge, web, state, agent: connectAgent } = await setup(t);
  const { call } = await connectAgent();
  const bind = (await call("connect_session")).data;
  const { id } = bind;
  const waitUrl = new URL(`/wait/${id}`, bridge.localMcpUrl);
  const ticket = waitTicket(token, id);
  const poll = async (bearer) => {
    const response = await fetch(waitUrl, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} });
    return { status: response.status, type: response.headers.get("content-type"), text: await response.text() };
  };

  // A loop of short polls: 2 seconds in all, each request answered within the wait budget.
  assert.equal(bind.shellWait.blockMs, 62_000);
  assert.equal(bind.shellWait.command, `end=$(($(date +%s)+2)); n=0; while :; do `
    + `r=$(curl -sS -m 31 -H 'Authorization: Bearer ${ticket}' '${waitUrl}?loop='$$-$end 2>&1); `
    + `case $r in '{'?event?:?idle?*) n=0;; '{'?event?:?*) break;; *) n=$((n+1)); [ $n -ge 3 ] && break; sleep 5;; esac; `
    + `[ $(date +%s) -ge $end ] && break; done; printf '%s\\n' "$r" | tail -n 1`);
  assert.match(bind.shellWait.instruction, /不要放进后台或 tmux.*不小于 blockMs 毫秒.*或 2 秒到时/);

  // The ticket opens this one session's wait and nothing else; the main token is not accepted here.
  assert.equal((await poll()).status, 401);
  assert.equal((await poll(token)).status, 401);
  assert.equal((await poll(waitTicket(token, "00000000"))).status, 401);
  const other = await fetch(bridge.localMcpUrl, { method: "POST", headers: { Authorization: `Bearer ${ticket}` } });
  assert.equal(other.status, 401);

  // The loop tells the results apart by how the body starts, so it is one compact JSON object.
  const started = Date.now();
  const idle = await poll(ticket);
  assert.equal(idle.status, 200);
  assert.match(idle.type, /^application\/json/);
  assert.match(idle.text, /^\{"event":"idle","id":"[0-9a-f]{8}",/);
  assert.deepEqual(JSON.parse(idle.text).nextCall, bind.nextCall);
  assert.ok(Date.now() - started >= 450 && Date.now() - started < 3000);
  // Between two polls the session still counts as waiting.
  assert.equal((await state()).sessions[0].status, "waiting");

  const pollStarted = Date.now();
  const waiting = poll(ticket);
  await shellPoll(state, pollStarted);
  await web(`/api/sessions/${id}/messages`, { method: "POST", body: { text: "经由 curl 收到" } });
  const delivered = (await waiting).text;
  assert.match(delivered, /^\{"event":"message",/);
  assert.equal(JSON.parse(delivered).message, "经由 curl 收到");

  // reply_message hands out the same command again, without repeating the explanation.
  const replied = (await call("reply_message", { id, text: "好" })).data;
  assert.deepEqual(replied.shellWait, { command: bind.shellWait.command, blockMs: 62_000 });
});

test("shell wait: a loop the agent left behind cannot take the wait back", async (t) => {
  const { bridge, web, state, agent: connectAgent } = await setup(t);
  const { call } = await connectAgent();
  const { id } = (await call("connect_session")).data;
  const pollAs = async (loop) => {
    const url = new URL(`/wait/${id}${loop ? `?loop=${loop}` : ""}`, bridge.localMcpUrl);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${waitTicket(token, id)}` } });
    return (await response.json()).event;
  };
  // Resolves once the call is in flight; `result` is the call itself.
  const mcpWait = async () => {
    const result = call("wait_message", { id });
    await until(async () => (await state()).sessions[0].waiting?.via === "mcp", "wait_message");
    return { result };
  };

  // Between two polls a loop holds no request, so a newer wait finds nothing to supersede.
  assert.equal(await pollAs("4242-1700000000"), "idle");
  const live = await mcpWait();
  // The old loop's next poll is turned away at once and leaves the newer wait alone.
  assert.equal(await pollAs("4242-1700000000"), "superseded");
  await web(`/api/sessions/${id}/messages`, { method: "POST", body: { text: "给 wait_message 的" } });
  assert.equal((await live.result).data.message, "给 wait_message 的");
  await call("reply_message", { id, text: "好" });

  // A run of the command started later is a new loop and waits normally.
  assert.equal(await pollAs("4243-1700000100"), "idle");

  // A poll that names no loop is a wait of its own, and the newest wait wins.
  assert.equal(await pollAs(), "idle");
  const older = await mcpWait();
  const bare = pollAs();
  assert.equal((await older.result).data.event, "superseded");
  await web(`/api/sessions/${id}/messages`, { method: "POST", body: { text: "给没有名字的轮询" } });
  assert.equal(await bare, "message");
});

// The command exactly as the agent receives it, run by real shells against the running bridge.
const shells = ["/bin/sh", "/bin/bash", "/bin/zsh"].filter((shell) => existsSync(shell));
const runShell = (shell, command) => promisify(execFile)(shell, ["-c", command]);

test("shell wait: the command given to the agent delivers a message", { skip: windows && "cloud agents run it on Linux" }, async (t) => {
  const { web, state, agent: connectAgent } = await setup(t, { shellWaitMs: 20_000 });
  const { call } = await connectAgent();
  const { id, shellWait } = (await call("connect_session")).data;
  for (const shell of shells) {
    const text = `it's a "quoted" 指令 for ${shell} with $HOME, \`backticks\`, * and a\nsecond line`;
    const started = Date.now();
    const run = runShell(shell, shellWait.command);
    await shellPoll(state, started);
    // Several idle polls pass before the message arrives; the loop keeps going without any output.
    await sleep(1200);
    await web(`/api/sessions/${id}/messages`, { method: "POST", body: { text } });
    const { stdout, stderr } = await run;
    assert.equal(stderr, "");
    assert.equal(stdout.split("\n").filter(Boolean).length, 1, stdout);
    assert.equal(JSON.parse(stdout).message, text);
    await call("reply_message", { id, text: "好" });
  }
});

test("shell wait: the command ends with idle at its deadline, on a newer wait, and after three failures", { skip: windows && "cloud agents run it on Linux" }, async (t) => {
  const { bridge, web, state, agent: connectAgent } = await setup(t, { shellWaitMs: 2000 });
  const { call } = await connectAgent();
  const { id, shellWait } = (await call("connect_session")).data;

  for (const shell of shells) {
    // Nothing to deliver: polls until the 2 seconds are over, then prints the last idle result once.
    const started = Date.now();
    const idle = await runShell(shell, shellWait.command);
    assert.ok(Date.now() - started >= 1000 && Date.now() - started < 8000, `${Date.now() - started} ms`);
    assert.equal(idle.stdout.split("\n").filter(Boolean).length, 1, idle.stdout);
    assert.equal(JSON.parse(idle.stdout).event, "idle");
    assert.match(JSON.parse(idle.stdout).instruction, /原样重新执行同一条等待命令/);

    // The agent moved on to wait_message while an old loop was still running: the loop stops.
    const staleStarted = Date.now();
    const stale = runShell(shell, shellWait.command.replace("+2))", "+60))"));
    await shellPoll(state, staleStarted);
    const viaMcp = call("wait_message", { id });
    assert.equal(JSON.parse((await stale).stdout).event, "superseded");
    await web(`/api/sessions/${id}/messages`, { method: "POST", body: { text: `给 wait_message 的（${shell}）` } });
    assert.equal((await viaMcp).data.message, `给 wait_message 的（${shell}）`);
    await call("reply_message", { id, text: "好" });
  }

  // An address that does not answer, a wrong ticket: three strikes, then the reason on the last line.
  const quick = shellWait.command.replace("sleep 5", "sleep 0.1").replace("+2))", "+60))");
  const refused = await runShell("/bin/sh", quick.replace(`:${new URL(bridge.localMcpUrl).port}/wait/`, ":9/wait/"));
  assert.match(refused.stdout, /^curl: \(7\) /);
  const denied = await runShell("/bin/sh", quick.replace(/Bearer wt_[\w-]+/, "Bearer wt_wrong"));
  assert.match(denied.stdout, /Unauthorized/);
  assert.ok((await state()).bridge.unauthorized >= 3);
});

test("shell wait is offered only when the public address is known and can be switched off", async (t) => {
  const { bridge, agent: connectAgent } = await setup(t);
  const viaTunnel = (headers) => fetch(bridge.localMcpUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "connect_session", arguments: {} } }),
  }).then(async (response) => JSON.parse(JSON.parse(/^data: (.*)$/m.exec(await response.text())[1]).result.content[0].text));

  // A tunnel that keeps the public host name: the address is taken from the request.
  const forwarded = await viaTunnel({ "X-Forwarded-Host": "abc-def.trycloudflare.com", "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.9" });
  assert.ok(forwarded.shellWait.command.includes(` 'https://abc-def.trycloudflare.com/wait/${forwarded.id}?loop='$$-$end 2>&1)`));
  // A tunnel that rewrites the host to localhost: unknown address, so only wait_message is offered.
  assert.equal((await viaTunnel({ "X-Forwarded-For": "203.0.113.9" })).shellWait, undefined);
  // A host name that could break out of the shell command is never used.
  assert.equal((await viaTunnel({ "X-Forwarded-Host": "a.example';id;'", "X-Forwarded-Proto": "https" })).shellWait, undefined);

  const off = await setup(t, { shellWaitMs: 0 });
  const { call } = await off.agent();
  const bind = (await call("connect_session")).data;
  assert.equal(bind.shellWait, undefined);
  assert.equal((await fetch(new URL(`/wait/${bind.id}`, off.bridge.localMcpUrl), { headers: { Authorization: `Bearer ${waitTicket(token, bind.id)}` } })).status, 404);
});

test("the public address is checked against this very process", async (t) => {
  const { bridge, web, state, remembered, agent: connectAgent } = await setup(t);
  const base = new URL(bridge.localMcpUrl).origin;
  const before = (await web("/api/connection")).data;
  assert.equal(before.ready, false);
  assert.match(before.config, /https:\/\/<你的隧道地址>\/mcp/);
  assert.match(before.prompt, /connect_session\(\{\}\)/);

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

  // With a known public address the shell wait uses it, whatever host the request came in on.
  const { call } = await connectAgent();
  const bind = (await call("connect_session")).data;
  assert.ok(bind.shellWait.command.includes(`'${base}/wait/${bind.id}?loop='`));

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
