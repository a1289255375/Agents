import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  cleanRoot, ConfigError, detectEncodings, normalizePublicUrl, normalizeRelayUrl, openState, parseOptions, resolveToken,
} from "../src/config.mjs";
import { legacyEncodings } from "../src/project/text.mjs";
import { tempDir, windows } from "./helpers.mjs";

const mainFile = fileURLToPath(new URL("../src/main.mjs", import.meta.url));

test("options: defaults", () => {
  assert.deepEqual(parseOptions(["D:\\work\\app"]), {
    help: false,
    root: "D:\\work\\app",
    port: 3220,
    mcpPort: 3221,
    mcpHost: "127.0.0.1",
    publicUrl: undefined,
    tunnel: undefined,
    relayUrl: undefined,
    policy: "ask",
    waitMs: 50_000,
    shellWaitMs: 1_200_000,
    legacyEncoding: undefined,
    stateDir: nodePath.join(os.homedir(), ".cursor-cloud-bridge"),
    newToken: false,
    open: false,
  });
  assert.equal(parseOptions([]).root, undefined);
  assert.equal(parseOptions(["--help"]).help, true);
});

test("options: every option is read", () => {
  const options = parseOptions([
    "--root", "/srv/app", "--port", "4000", "--mcp-port", "0", "--mcp-host", "0.0.0.0",
    "--public-url", "https://bridge.example.com/mcp/", "--command-policy", "deny", "--wait-seconds", "25",
    "--shell-wait-seconds", "0", "--legacy-encoding", "big5", "--state-dir", "/tmp/state", "--new-token", "--open",
  ]);
  assert.deepEqual(options, {
    help: false,
    root: "/srv/app",
    port: 4000,
    mcpPort: 0,
    mcpHost: "0.0.0.0",
    publicUrl: "https://bridge.example.com",
    tunnel: undefined,
    relayUrl: undefined,
    policy: "deny",
    waitMs: 25_000,
    shellWaitMs: 0,
    legacyEncoding: "big5",
    stateDir: "/tmp/state",
    newToken: true,
    open: true,
  });
  assert.equal(parseOptions(["--tunnel", "cloudflared"]).tunnel, "cloudflared");
  assert.equal(parseOptions(["--relay", "36.138.159.226"]).relayUrl, "https://36.138.159.226");
  assert.equal(parseOptions(["--relay", "https://relay.example.com:8443/mcp"]).relayUrl, "https://relay.example.com:8443");
  // High ports default to http: that's what --insecure-http listens on when 80/443 are blocked.
  assert.equal(parseOptions(["--relay", "36.138.159.226:18443"]).relayUrl, "http://36.138.159.226:18443");
  assert.equal(parseOptions(["--relay", "http://36.138.159.226:18443"]).relayUrl, "http://36.138.159.226:18443");
  assert.equal(parseOptions(["--relay", "1.2.3.4:443"]).relayUrl, "https://1.2.3.4");
});

test("options: the project root survives Windows quoting accidents", () => {
  // What `"D:\my project\"` turns into on a Windows command line, and Explorer's "Copy as path".
  assert.equal(parseOptions(["D:\\my project\""]).root, "D:\\my project");
  assert.equal(parseOptions(["--open", "\"D:\\my project\""]).root, "D:\\my project");
  assert.equal(cleanRoot("  \"C:\\Users\\me\\我的 项目\"  "), "C:\\Users\\me\\我的 项目");
  assert.equal(cleanRoot(""), "");

  // With options after it, the same accident swallows them; a quote cannot be part of a Windows path.
  const swallowed = "D:\\my project\" --command-policy allow";
  assert.throws(() => parseOptions(["--open", swallowed], "win32"), (error) => error instanceof ConfigError
    && error.message.includes("项目根目录里混进了引号和后面的参数：D:\\my project\" --command-policy allow")
    && error.message.includes("写成 \"D:\\my project\""));
  assert.equal(parseOptions([swallowed], "linux").root, swallowed);
});

test("options: mistakes are reported in terms of the option", () => {
  const fails = (argv, pattern) => assert.throws(() => parseOptions(argv), (error) => error instanceof ConfigError && pattern.test(error.message));
  fails(["a", "b"], /只能指定一个项目根目录.*a {2}\| {2}b.*路径含空格时请加引号/);
  fails(["a", "--root", "b"], /只能指定一个项目根目录/);
  fails(["--port", "abc"], /选项 --port 的值无效：abc/);
  fails(["--port", "70000"], /选项 --port 的值无效：70000/);
  fails(["--command-policy", "yes"], /选项 --command-policy 的值无效：yes/);
  fails(["--wait-seconds", "2"], /选项 --wait-seconds 的值无效：2/);
  fails(["--tunnel", "ngrok"], /选项 --tunnel 的值无效：ngrok/);
  fails(["--legacy-encoding", "klingon"], /选项 --legacy-encoding 的值无效：klingon/);
  fails(["--no-such-option"], /参数错误/);
  fails(["--port"], /参数错误/);
  fails(["--public-url", "bridge.example.com"], /公网地址应是 https:\/\/ 开头的完整网址，收到的是：bridge\.example\.com/);
});

test("public address: accepts what people paste", () => {
  assert.equal(normalizePublicUrl("https://abc.trycloudflare.com"), "https://abc.trycloudflare.com");
  assert.equal(normalizePublicUrl(" https://abc.trycloudflare.com/mcp \n"), "https://abc.trycloudflare.com");
  assert.equal(normalizePublicUrl("https://Example.com:8443/base/mcp/"), "https://example.com:8443/base");
  assert.equal(normalizePublicUrl("http://203.0.113.5:3221/"), "http://203.0.113.5:3221");
  for (const bad of ["", "abc", "ftp://example.com", "example.com:3221", "javascript:alert(1)"]) {
    assert.throws(() => normalizePublicUrl(bad), ConfigError, bad);
  }
});

test("relay address: a bare host is assumed https so only the server address is needed", () => {
  assert.equal(normalizeRelayUrl("36.138.159.226"), "https://36.138.159.226");
  assert.equal(normalizeRelayUrl("  relay.example.com \n"), "https://relay.example.com");
  assert.equal(normalizeRelayUrl("https://relay.example.com:8443/mcp/"), "https://relay.example.com:8443");
  assert.equal(normalizeRelayUrl("http://203.0.113.5:8080"), "http://203.0.113.5:8080");
});

test("state: the token is generated once and kept outside the repository", async (t) => {
  const dir = nodePath.join(await tempDir(t), "state");
  const state = await openState(dir);
  assert.deepEqual(state.get(), {});

  const first = await resolveToken(state, { env: {} });
  assert.equal(first.source, "new");
  assert.match(first.token, /^[\w-]{40,}$/);
  assert.deepEqual(JSON.parse(await fs.readFile(nodePath.join(dir, "config.json"), "utf8")), { token: first.token });
  if (!windows) assert.equal((await fs.stat(nodePath.join(dir, "config.json"))).mode & 0o777, 0o600);

  await state.save({ lastRoot: "D:\\work\\app", publicUrl: "https://bridge.example.com" });
  const reopened = await openState(dir);
  assert.deepEqual(reopened.get(), { token: first.token, lastRoot: "D:\\work\\app", publicUrl: "https://bridge.example.com" });
  assert.deepEqual(await resolveToken(reopened, { env: {} }), { token: first.token, source: "saved" });

  const renewed = await resolveToken(reopened, { env: {}, renew: true });
  assert.equal(renewed.source, "new");
  assert.notEqual(renewed.token, first.token);
  assert.equal((await openState(dir)).get().token, renewed.token);
  assert.equal((await openState(dir)).get().lastRoot, "D:\\work\\app");
});

test("state: a token from the environment wins and is not written to disk", async (t) => {
  const dir = await tempDir(t);
  const state = await openState(dir);
  const token = "from-the-environment-0123456789";
  assert.deepEqual(await resolveToken(state, { env: { CLOUD_BRIDGE_TOKEN: token } }), { token, source: "env" });
  await assert.rejects(fs.access(nodePath.join(dir, "config.json")));
  await assert.rejects(resolveToken(state, { env: { CLOUD_BRIDGE_TOKEN: "short" } }), /CLOUD_BRIDGE_TOKEN 太短/);
});

test("state: a damaged file is reported instead of silently replacing the token", async (t) => {
  const dir = await tempDir(t);
  await fs.writeFile(nodePath.join(dir, "config.json"), "{ not json");
  await assert.rejects(openState(dir), (error) => error instanceof ConfigError && /无法读取或已损坏/.test(error.message));
  await fs.writeFile(nodePath.join(dir, "config.json"), JSON.stringify({ token: "too-short" }));
  await assert.rejects(openState(dir), /无法读取或已损坏/);
});

test("encodings: system code pages on Windows, GBK elsewhere", async () => {
  assert.deepEqual(await detectEncodings("linux"), { legacyEncoding: "gbk", consoleEncoding: "gbk" });
  if (!windows) return;
  const detected = await detectEncodings();
  assert.ok(legacyEncodings.includes(detected.legacyEncoding), JSON.stringify(detected));
  assert.ok(legacyEncodings.includes(detected.consoleEncoding), JSON.stringify(detected));
});

// Runs the real command line program and collects what it prints.
function runCli(t, args, { env = {} } = {}) {
  const child = spawn(process.execPath, [mainFile, ...args], {
    env: { ...process.env, CLOUD_BRIDGE_TOKEN: undefined, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const output = { out: "", err: "" };
  child.stdout.setEncoding("utf8").on("data", (text) => { output.out += text; });
  child.stderr.setEncoding("utf8").on("data", (text) => { output.err += text; });
  const exited = new Promise((resolve) => { child.once("close", (code) => resolve(code)); });
  t.after(async () => {
    child.kill();
    await exited;
  });
  return {
    output,
    exited,
    stop: () => child.kill(windows ? undefined : "SIGINT"),
    async until(pattern) {
      for (let attempt = 0; attempt < 150; attempt++) {
        const match = pattern.exec(output.out);
        if (match) return match;
        if (child.exitCode !== null) break;
        await new Promise((resolve) => { setTimeout(resolve, 100); });
      }
      throw new Error(`no ${pattern} in the output:\n${output.out}\n${output.err}`);
    },
  };
}

test("command line: help, and no project root without a terminal", async (t) => {
  const help = runCli(t, ["--help"]);
  assert.equal(await help.exited, 0);
  assert.match(help.output.out, /^用法：node cloud\/src\/main\.mjs \[项目根目录\] \[选项\]/);
  assert.match(help.output.out, /--command-policy/);

  const stateDir = await tempDir(t);
  const noRoot = runCli(t, ["--state-dir", stateDir]);
  assert.equal(await noRoot.exited, 1);
  assert.match(noRoot.output.err, /^没有指定项目根目录。\n\n用法：/);

  const missing = runCli(t, [nodePath.join(stateDir, "no such dir"), "--state-dir", stateDir]);
  assert.equal(await missing.exited, 1);
  assert.match(missing.output.err, /^项目根目录不存在或不是目录：.*no such dir\n$/);

  const both = runCli(t, [stateDir, "--state-dir", stateDir, "--tunnel", "cloudflared", "--public-url", "https://x.example.com"]);
  assert.equal(await both.exited, 1);
  assert.match(both.output.err, /--tunnel 和 --public-url 不能同时使用/);

  const relayClash = runCli(t, [stateDir, "--state-dir", stateDir, "--relay", "1.2.3.4", "--public-url", "https://x.example.com"]);
  assert.equal(await relayClash.exited, 1);
  assert.match(relayClash.output.err, /--relay 不能和 --tunnel 或 --public-url 同时使用/);
});

test("command line: starts, keeps the token out of the terminal and remembers its state", async (t) => {
  const base = await tempDir(t);
  const root = nodePath.join(base, "我的 项目");
  const stateDir = nodePath.join(base, "state");
  await fs.mkdir(root);
  const args = [root, "--state-dir", stateDir, "--port", "0", "--mcp-port", "0"];

  const first = runCli(t, args);
  const consoleUrl = (await first.until(/网页控制台 {2}(http:\/\/127\.0\.0\.1:\d+\/)/))[1];
  const mcpUrl = (await first.until(/MCP 端点 {4}(http:\/\/127\.0\.0\.1:\d+\/mcp)/))[1];
  await first.until(/按 Ctrl\+C 停止。/);
  const state = JSON.parse(await fs.readFile(nodePath.join(stateDir, "config.json"), "utf8"));
  assert.equal(state.lastRoot, root);
  assert.match(state.token, /^[\w-]{40,}$/);
  assert.ok(!first.output.out.includes(state.token), "the token must not be printed");
  assert.match(first.output.out, /命令策略 {4}每次确认/);
  assert.match(first.output.out, /公网地址 {4}未设置/);

  const view = await (await fetch(`${consoleUrl}api/state?now=1`)).json();
  assert.equal(view.bridge.root, root);
  assert.equal(view.bridge.policy, "ask");
  assert.equal((await fetch(mcpUrl, { method: "POST" })).status, 401);
  const connection = await (await fetch(`${consoleUrl}api/connection`)).json();
  assert.equal(connection.token, state.token);
  assert.match(connection.prompt, /connect_session/);

  // The port is taken while the first one runs.
  const clash = runCli(t, [root, "--state-dir", stateDir, "--port", new URL(consoleUrl).port, "--mcp-port", "0"]);
  assert.equal(await clash.exited, 1);
  assert.match(clash.output.err, /端口 \d+ 已被占用/);

  first.stop();
  await first.exited;
  if (!windows) assert.match(first.output.out, /正在停止……/);

  // Same token on the next start; the public address given once is remembered; a new token on request.
  const second = runCli(t, [...args, "--public-url", "http://127.0.0.1:9/mcp", "--command-policy", "allow"]);
  await second.until(/公网地址 {4}http:\/\/127\.0\.0\.1:9\/mcp/);
  await second.until(/警告：公网地址不是 https/);
  await second.until(/公网地址自检未通过/);
  assert.match(second.output.out, /命令策略 {4}全部允许/);
  second.stop();
  await second.exited;
  const kept = JSON.parse(await fs.readFile(nodePath.join(stateDir, "config.json"), "utf8"));
  assert.deepEqual(kept, { token: state.token, lastRoot: root, publicUrl: "http://127.0.0.1:9" });

  const third = runCli(t, [...args, "--new-token"]);
  await third.until(/旧令牌已失效/);
  await third.until(/公网地址 {4}http:\/\/127\.0\.0\.1:9\/mcp/);
  third.stop();
  await third.exited;
  const renewed = JSON.parse(await fs.readFile(nodePath.join(stateDir, "config.json"), "utf8"));
  assert.notEqual(renewed.token, state.token);
  assert.ok(!third.output.out.includes(renewed.token));
});

test("command line: warns when the project root holds the user profile", async (t) => {
  const base = await tempDir(t);
  const stateDir = nodePath.join(base, "project", ".state");
  await fs.mkdir(stateDir, { recursive: true });
  const cli = runCli(t, [nodePath.join(base, "project"), "--state-dir", stateDir, "--port", "0", "--mcp-port", "0"]);
  await cli.until(/警告：项目根目录包含你的用户目录/);
});
