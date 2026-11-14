import assert from "node:assert/strict";
import test from "node:test";
import { deployBundle, deployText } from "../lib/deploy.mjs";

const connection = {
  serverName: "cursor-cloud-bridge",
  url: "https://abc.trycloudflare.com/mcp",
  ready: true,
  token: "secret-token",
  authorization: "Bearer secret-token",
  config: '{\n  "mcpServers": {\n    "cursor-cloud-bridge": { "url": "https://abc.trycloudflare.com/mcp", "headers": { "Authorization": "Bearer secret-token" } }\n  }\n}',
  prompt: "【云端桥会话】...connect_session({})...",
};

test("deployBundle carries the values the user copies into cursor.com", () => {
  const bundle = deployBundle({ connection, publicUrl: "https://abc.trycloudflare.com", consoleUrl: "http://127.0.0.1:3220/" });
  assert.equal(bundle.ready, true);
  assert.equal(bundle.serverName, "cursor-cloud-bridge");
  assert.equal(bundle.serverUrl, "https://abc.trycloudflare.com/mcp");
  assert.equal(bundle.headerValue, "Bearer secret-token");
  assert.match(bundle.mcpConfig, /cursor-cloud-bridge/);
  assert.match(bundle.prompt, /connect_session/);
});

test("deployText spells out the manual cursor.com step and never claims it is done", () => {
  const text = deployText(deployBundle({ connection, publicUrl: "https://abc.trycloudflare.com", consoleUrl: "http://127.0.0.1:3220/" }));
  assert.match(text, /必须由你在 cursor\.com 手动完成的一步/);
  assert.match(text, /没有替你点/);
  assert.match(text, /Bearer secret-token/);
  assert.match(text, /connect_session/);
  assert.match(text, /控制台：http:\/\/127\.0\.0\.1:3220\//);
});

test("deployText warns plainly when the public address is not ready yet", () => {
  const text = deployText(deployBundle({ connection: { ...connection, ready: false }, publicUrl: null }));
  assert.match(text, /公网地址还没就绪/);
});
