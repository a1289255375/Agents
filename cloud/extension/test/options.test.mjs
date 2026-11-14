import assert from "node:assert/strict";
import test from "node:test";
import { bridgeParams, OptionError, resolveRoot, restartKeys } from "../lib/options.mjs";

test("resolveRoot prefers the setting, then the first workspace folder", () => {
  assert.equal(resolveRoot({ configuredRoot: "  D:\\work  ", workspaceFolders: ["C:\\other"] }), "D:\\work");
  assert.equal(resolveRoot({ configuredRoot: "", workspaceFolders: ["  /home/me/proj  ", "/second"] }), "/home/me/proj");
  assert.equal(resolveRoot({ configuredRoot: "   ", workspaceFolders: ["", "/second"] }), "/second");
  assert.equal(resolveRoot({ configuredRoot: "", workspaceFolders: [] }), undefined);
  assert.equal(resolveRoot({}), undefined);
});

test("bridgeParams maps settings to startBridge arguments", () => {
  const params = bridgeParams({
    root: " /home/me/proj ",
    token: "a-token-value",
    settings: { commandPolicy: "allow", consolePort: 4000, mcpPort: 4001, waitSeconds: 30, publicUrl: "https://x.example/mcp/" },
    encodings: { legacyEncoding: "gbk", consoleEncoding: "cp866" },
  });
  assert.deepEqual(params, {
    root: "/home/me/proj",
    token: "a-token-value",
    port: 4000,
    mcpPort: 4001,
    policy: "allow",
    waitMs: 30_000,
    legacyEncoding: "gbk",
    consoleEncoding: "cp866",
    publicUrl: "https://x.example/mcp/",
    tunnel: undefined,
    relayUrl: undefined,
  });
});

test("bridgeParams uses defaults and drops publicUrl when a tunnel runs", () => {
  const params = bridgeParams({ root: "/p", token: "t", settings: { tunnel: "cloudflared", publicUrl: "https://ignored.example" }, encodings: {} });
  assert.equal(params.port, 3220);
  assert.equal(params.mcpPort, 3221);
  assert.equal(params.policy, "ask");
  assert.equal(params.waitMs, 50_000);
  assert.equal(params.legacyEncoding, "gbk");
  assert.equal(params.consoleEncoding, "gbk");
  assert.equal(params.tunnel, "cloudflared");
  assert.equal(params.publicUrl, undefined);
  assert.equal(params.relayUrl, undefined);
});

test("bridgeParams switches to relay mode when only a server address is filled", () => {
  const params = bridgeParams({
    root: "/p", token: "t",
    settings: { relayUrl: " 1.2.3.4 ", publicUrl: "https://ignored.example", tunnel: "none" },
    savedPublicUrl: "https://saved.example",
    normalizeRelayUrl: (value) => `https://${value.trim()}`,
  });
  assert.equal(params.relayUrl, "https://1.2.3.4");
  assert.equal(params.tunnel, undefined);
  assert.equal(params.publicUrl, undefined);
});

test("bridgeParams treats tunnel=relay the same and requires an address", () => {
  const params = bridgeParams({ root: "/p", token: "t", settings: { tunnel: "relay", relayUrl: "relay.example.com" }, normalizeRelayUrl: (v) => `https://${v}` });
  assert.equal(params.relayUrl, "https://relay.example.com");
  assert.throws(() => bridgeParams({ root: "/p", token: "t", settings: { tunnel: "relay", relayUrl: "  " } }), /中继模式需要/);
});

test("bridgeParams: an explicit cloudflared tunnel beats a leftover relay address", () => {
  const params = bridgeParams({ root: "/p", token: "t", settings: { tunnel: "cloudflared", relayUrl: "1.2.3.4" } });
  assert.equal(params.tunnel, "cloudflared");
  assert.equal(params.relayUrl, undefined);
});

test("bridgeParams falls back to the saved public address only when nothing overrides it", () => {
  assert.equal(bridgeParams({ root: "/p", token: "t", settings: {}, savedPublicUrl: "https://saved.example" }).publicUrl, "https://saved.example");
  assert.equal(bridgeParams({ root: "/p", token: "t", settings: { publicUrl: "https://set.example" }, savedPublicUrl: "https://saved.example" }).publicUrl, "https://set.example");
  assert.equal(bridgeParams({ root: "/p", token: "t", settings: { relayUrl: "1.2.3.4" }, savedPublicUrl: "https://saved.example", normalizeRelayUrl: (v) => `https://${v}` }).publicUrl, undefined);
});

test("bridgeParams rejects bad settings with a readable message", () => {
  assert.throws(() => bridgeParams({ root: "", token: "t" }), OptionError);
  assert.throws(() => bridgeParams({ root: "/p", token: "" }), OptionError);
  assert.throws(() => bridgeParams({ root: "/p", token: "t", settings: { commandPolicy: "nope" } }), /ask、allow 或 deny/);
  assert.throws(() => bridgeParams({ root: "/p", token: "t", settings: { consolePort: 70000 } }), /端口号/);
  assert.throws(() => bridgeParams({ root: "/p", token: "t", settings: { waitSeconds: 1 } }), /秒数/);
});

test("the policy is applied live, so it is not among the restart keys", () => {
  assert.ok(!restartKeys.includes("commandPolicy"));
  assert.ok(restartKeys.includes("workspaceRoot"));
  assert.ok(restartKeys.includes("mcpPort"));
});
