// Drives the real controller with a fake vscode and the real bridge code, and plays the cloud agent
// with a real MCP client. It proves the extension's wiring: activate brings up a working bridge, the
// console API the panel reads shows sessions and their thinking, several sessions run side by side,
// the deploy bundle carries the connection values, and changing the workspace restarts on the new root.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import nodePath from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { newToken } from "../../src/auth.mjs";
import { detectEncodings, normalizePublicUrl, openState, resolveToken } from "../../src/config.mjs";
import { startBridge } from "../../src/main.mjs";
import { tempDir, writeTree } from "../../test/helpers.mjs";
import { createController } from "../lib/controller.mjs";

const bridgeApi = { startBridge, openState, resolveToken, detectEncodings, normalizePublicUrl, newToken };

function fakeVscode(initial) {
  const store = { cursorCloudBridge: { ...initial } };
  const calls = { errors: [], info: [], clipboard: [], external: [], panels: [] };
  const scripted = { openDialog: [], quickPick: [], info: [], warning: [] };
  const uri = (value) => ({ toString: () => value, fsPath: value });
  const vscode = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, One: 1 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    Uri: { parse: (value) => uri(value), file: (value) => uri(value) },
    env: {
      clipboard: { writeText: async (text) => { calls.clipboard.push(text); } },
      openExternal: async (target) => { calls.external.push(target.toString()); return true; },
      asExternalUri: (target) => target,
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, append() {}, clear() {}, show() {}, dispose() {} }),
      createStatusBarItem: () => ({ text: "", tooltip: "", command: "", show() {}, hide() {}, dispose() {} }),
      showErrorMessage: async (message) => { calls.errors.push(message); },
      showInformationMessage: async (message) => { calls.info.push(message); return scripted.info.shift(); },
      showWarningMessage: async (message) => scripted.warning.shift(),
      showQuickPick: async () => scripted.quickPick.shift(),
      showOpenDialog: async () => scripted.openDialog.shift(),
      createWebviewPanel: (viewType, title) => {
        const panel = {
          viewType, title,
          webview: { html: "", options: {}, cspSource: "vscode-webview://x", asWebviewUri: (u) => u },
          onDidDispose(cb) { panel._dispose = cb; return { dispose() {} }; },
          reveal() { panel.revealed = true; },
          dispose() { panel._dispose?.(); },
        };
        calls.panels.push(panel);
        return panel;
      },
    },
    commands: { registerCommand: () => ({ dispose() {} }) },
    workspace: {
      workspaceFolders: (initial.__folders ?? []).map((path) => ({ uri: uri(path) })),
      getConfiguration: (section) => ({
        get: (key) => store[section]?.[key],
        update: async (key, value) => { store[section] = { ...store[section], [key]: value }; },
      }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
  };
  return { vscode, calls, scripted, store };
}

async function connectAgent(t, url, token) {
  const client = new Client({ name: "ext-agent", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => client.close());
  const call = async (name, args = {}) => {
    const { content } = await client.callTool({ name, arguments: args });
    const { text } = content[0];
    return text.startsWith("{") ? JSON.parse(text) : text;
  };
  return { call };
}

async function setup(t, folders = []) {
  const root = await tempDir(t);
  await writeTree(root, { "src/app.js": "console.log('hi');\n" });
  const stateDir = await tempDir(t);
  const context = { subscriptions: [] };
  const { vscode, calls, scripted, store } = fakeVscode({
    workspaceRoot: folders.length ? "" : root,
    __folders: folders,
    autoStart: true, commandPolicy: "ask", tunnel: "none", publicUrl: "", consolePort: 0, mcpPort: 0,
  });
  const controller = createController({ vscode, bridgeApi, context, stateDir });
  t.after(() => controller.stop());
  const web = async (path, init) => {
    const response = await fetch(new URL(path, controller.running.consoleUrl), {
      ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    });
    return { status: response.status, data: await response.json() };
  };
  return { root, stateDir, controller, calls, scripted, store, web };
}

test("activate starts the bridge on the resolved root and the console API answers", async (t) => {
  const context = [];
  const { root, controller, web } = await setup(t);
  await controller.activate();
  assert.ok(controller.running, "bridge is running after activate");
  assert.equal(controller.running.root, await fs.realpath(root));
  const state = (await web("/api/state?now=1")).data;
  assert.equal(state.sessions.length, 0);
  assert.match(state.bridge.root, new RegExp(nodePath.basename(root)));
  const connection = (await web("/api/connection")).data;
  assert.equal(connection.serverName, "cursor-cloud-bridge");
  assert.ok(connection.token && connection.token.length >= 24);
});

test("activate falls back to the first workspace folder when no root is set", async (t) => {
  const folder = await tempDir(t);
  const { controller } = await setup(t, [folder]);
  await controller.activate();
  assert.equal(controller.running.root, await fs.realpath(folder));
});

test("a cloud agent's thinking and reply reach the console API the panel reads", async (t) => {
  const { controller, web } = await setup(t);
  await controller.activate();
  const token = (await web("/api/connection")).data.token;
  const { call } = await connectAgent(t, controller.running.localMcpUrl, token);

  const bind = await call("connect_session", { name: "子代理A" });
  assert.equal(bind.event, "bind");
  await call("report_thinking", { id: bind.id, text: "先看目录结构，再决定怎么改" });

  const waiting = call("wait_message", { id: bind.id });
  await sleep(100);
  await web(`/api/sessions/${bind.id}/messages`, { method: "POST", body: JSON.stringify({ text: "读一下 src/app.js" }) });
  assert.equal((await waiting).message, "读一下 src/app.js");
  await call("read_file", { path: "src/app.js", session: bind.id });
  await call("reply_message", { id: bind.id, text: "读完了", thinking: "文件只有一行" });

  const view = (await web(`/api/state?now=1&session=${bind.id}`)).data;
  const roles = view.session.timeline.map((item) => item.role);
  assert.deepEqual(roles.filter((role) => role !== "note"), ["thinking", "user", "thinking", "assistant"]);
  assert.match(view.session.timeline.find((item) => item.role === "thinking").text, /先看目录结构/);
  assert.ok(view.activity.some((entry) => entry.tool === "read_file" && entry.session === bind.id));
});

test("several cloud sessions are visible side by side", async (t) => {
  const { controller, web } = await setup(t);
  await controller.activate();
  const token = (await web("/api/connection")).data.token;
  const names = ["A", "B", "C", "D", "E"];
  for (const name of names) {
    const { call } = await connectAgent(t, controller.running.localMcpUrl, token);
    await call("connect_session", { name });
  }
  const sessions = (await web("/api/state?now=1")).data.sessions;
  assert.equal(sessions.length, names.length);
  assert.deepEqual([...sessions.map((s) => s.name)].sort(), [...names].sort());
});

test("prepareCloud builds the bundle once the public address checks out", async (t) => {
  const { controller, calls, scripted, web } = await setup(t);
  await controller.activate();
  // Point the public address at this very process so the self-test passes and the bundle is ready.
  const origin = new URL(controller.running.localMcpUrl).origin;
  const set = await web("/api/public-url", { method: "POST", body: JSON.stringify({ url: origin }) });
  assert.equal(set.data.ok, true);

  scripted.info.push("复制 MCP 配置");
  const bundle = await controller.prepareCloud();
  assert.equal(bundle.ready, true);
  assert.equal(bundle.serverUrl, `${origin}/mcp`);
  assert.match(bundle.mcpConfig, /cursor-cloud-bridge/);
  assert.match(bundle.prompt, /connect_session/);
  // The chosen "copy MCP config" action put the config on the clipboard.
  assert.equal(calls.clipboard.at(-1), bundle.mcpConfig);
});

test("setWorkspaceRoot restarts the bridge on the chosen folder", async (t) => {
  const { controller, scripted, store, web } = await setup(t);
  await controller.activate();
  const first = controller.running.root;
  const next = await tempDir(t);
  await writeTree(next, { "readme.txt": "new project\n" });
  scripted.openDialog.push([{ fsPath: next }]);

  await controller.setWorkspaceRoot();
  assert.equal(store.cursorCloudBridge.workspaceRoot, next);
  assert.notEqual(controller.running.root, first);
  assert.equal(controller.running.root, await fs.realpath(next));
  assert.match((await web("/api/state?now=1")).data.bridge.root, new RegExp(nodePath.basename(next)));
});

test("restart keeps the same token across a settings change", async (t) => {
  const { controller, web } = await setup(t);
  await controller.activate();
  const before = (await web("/api/connection")).data.token;
  await controller.restart();
  const after = (await web("/api/connection")).data.token;
  assert.equal(before, after);
});
