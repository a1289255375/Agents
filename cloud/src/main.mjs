#!/usr/bin/env node
// Cloud bridge: lets a Cursor Cloud Agent work on a project on this machine through MCP, driven from
// a local web console. Start with: node cloud/src/main.mjs <project root>
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  cleanRoot, ConfigError, detectEncodings, normalizePublicUrl, openState, parseOptions, resolveToken, usage,
} from "./config.mjs";
import { createHub } from "./hub.mjs";
import { startConsole, startMcpEndpoint } from "./http.mjs";
import { createProject, policyLabels } from "./project/index.mjs";
import { PathError } from "./project/paths.mjs";
import { startCloudflared } from "./tunnel.mjs";

const serverName = "cursor-cloud-bridge";
const selfTestTimeoutMs = 10_000;
const tunnelProbeDelaysMs = [3000, 5000, 10_000, 15_000, 30_000];

export async function startBridge({
  root, token, port, mcpPort, mcpHost = "127.0.0.1", policy, waitMs, shellWaitMs, legacyEncoding, consoleEncoding,
  publicUrl, tunnel, rememberPublicUrl = async () => {}, log = () => {},
}) {
  const hub = createHub();
  const project = await createProject({
    root, legacyEncoding, consoleEncoding, policy, commandWaitMs: waitMs, onJobChange: (job) => hub.recordJob(job),
  });
  const bridge = {
    instance: randomBytes(8).toString("hex"),
    token, waitMs, shellWaitMs, commandWaitMs: waitMs, publicUrl, unauthorized: 0,
  };
  const mcp = await startMcpEndpoint({ bridge, hub, project, port: mcpPort, host: mcpHost });
  const localMcpUrl = `http://127.0.0.1:${mcp.port}/mcp`;

  // Fetches the public address from here and checks that it leads back to this very process.
  async function selfTest() {
    const url = bridge.publicUrl;
    let result;
    if (!url) {
      result = { ok: false, message: "还没有填写公网地址" };
    } else {
      try {
        const response = await fetch(`${url}/`, { signal: AbortSignal.timeout(selfTestTimeoutMs), redirect: "manual" });
        const data = await response.json().catch(() => undefined);
        if (data?.instance === bridge.instance) {
          result = { ok: true, message: "从本机访问这个地址能到达本服务" };
        } else if (data?.service === serverName) {
          result = { ok: false, message: "这个地址通到了另一个云端桥进程。检查是否开了两个，或隧道指向了别的端口" };
        } else {
          result = { ok: false, message: `这个地址有响应（HTTP ${response.status}），但不是本服务。检查隧道是否指向 http://127.0.0.1:${mcp.port}` };
        }
      } catch (error) {
        const reason = error.cause?.code ?? error.cause?.message ?? error.message;
        result = {
          ok: false,
          message: `从本机访问不到这个地址（${reason}）。先确认隧道已启动并指向 http://127.0.0.1:${mcp.port}。有些隧道域名在本机网络下打不开、云端却能访问，最终以云端 Agent 能否接入为准`,
        };
      }
    }
    // The address may have been changed while the request was running.
    if (url === bridge.publicUrl) {
      bridge.selfTest = { ...result, url, at: Date.now() };
      hub.notify();
    }
    return { ...result, url };
  }

  let stopTunnel;
  function runTunnel() {
    bridge.tunnel = { state: "starting" };
    stopTunnel = startCloudflared({
      port: mcp.port,
      async onUrl(url) {
        bridge.publicUrl = url;
        bridge.selfTest = undefined;
        bridge.tunnel = { state: "up", url };
        hub.notify();
        log(`cloudflared 隧道已建立：${url}/mcp\n  快速隧道每次启动地址都会变，记得把云端 MCP 配置里的 url 改成这个新地址。`);
        // A new quick tunnel takes a while to become reachable.
        for (const delay of tunnelProbeDelaysMs) {
          await new Promise((resolve) => { setTimeout(resolve, delay).unref(); });
          if (bridge.publicUrl !== url || (await selfTest()).ok) return;
        }
      },
      onExit(reason) {
        bridge.tunnel = { state: "down", error: reason };
        hub.notify();
        log(`隧道已断开：${reason}`);
      },
    });
  }

  const actions = {
    view: () => ({
      instance: bridge.instance,
      root: project.guard.root,
      platform: process.platform,
      shell: project.commands.defaultShell,
      policy: project.commands.policy,
      localMcpUrl,
      publicUrl: bridge.publicUrl ?? null,
      observedUrl: bridge.observedUrl ?? null,
      selfTest: bridge.selfTest ?? null,
      tunnel: bridge.tunnel ?? null,
      unauthorized: bridge.unauthorized,
      waitSeconds: waitMs / 1000,
      shellWaitSeconds: shellWaitMs / 1000,
      jobs: project.commands.list().filter((job) => job.state === "awaiting_approval" || job.state === "running"),
    }),

    async connection() {
      const url = bridge.publicUrl ? `${bridge.publicUrl}/mcp` : "https://<你的隧道地址>/mcp";
      return {
        serverName,
        url,
        ready: Boolean(bridge.publicUrl),
        token,
        authorization: `Bearer ${token}`,
        config: JSON.stringify({ mcpServers: { [serverName]: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
        prompt: (await readFile(new URL("../prompt.md", import.meta.url), "utf8")).trim(),
      };
    },

    async setPublicUrl(input) {
      bridge.publicUrl = input ? normalizePublicUrl(input) : undefined;
      bridge.selfTest = undefined;
      hub.notify();
      await rememberPublicUrl(bridge.publicUrl);
      return bridge.publicUrl ? selfTest() : { ok: false, message: "已清除公网地址" };
    },

    selfTest,
  };
  let web;
  try {
    web = await startConsole({ bridge, hub, project, port, actions });
  } catch (error) {
    // Otherwise the listener that did start keeps the process alive after the error is reported.
    mcp.server.close();
    throw error;
  }
  if (tunnel === "cloudflared") runTunnel();

  return {
    hub, project, bridge, selfTest,
    root: project.guard.root,
    consoleUrl: `http://127.0.0.1:${web.port}/`,
    localMcpUrl,
    async stop() {
      stopTunnel?.();
      project.commands.shutdown();
      await Promise.all([mcp.server, web.server].map((server) => new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      })));
    },
  };
}

async function askRoot(lastRoot) {
  if (!process.stdin.isTTY) throw new ConfigError(`没有指定项目根目录。\n\n${usage}`);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = lastRoot ? `直接回车沿用 ${lastRoot}` : "要交给云端 Agent 操作的项目文件夹的完整路径";
    const answer = cleanRoot(await prompt.question(`项目根目录（${hint}）：`)) || lastRoot;
    if (!answer) throw new ConfigError("没有指定项目根目录。");
    return answer;
  } finally {
    prompt.close();
  }
}

function openBrowser(url) {
  const [file, args] = process.platform === "win32" ? ["cmd.exe", ["/d", "/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(file, args, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
}

// Everything under the root is readable by whoever holds the token, so a root that swallows the
// user profile (token file, SSH keys, browser data) deserves a loud warning.
function rootWarning(root, stateDir) {
  const contains = (dir) => {
    const rel = nodePath.relative(root, dir);
    return !rel.startsWith("..") && !nodePath.isAbsolute(rel);
  };
  if (!contains(os.homedir()) && !contains(stateDir)) return undefined;
  return "警告：项目根目录包含你的用户目录（里面有访问令牌、SSH 密钥、浏览器数据等），这些文件云端 Agent 都能读到。建议只指定具体的项目文件夹。";
}

async function cli(argv) {
  const options = parseOptions(argv);
  if (options.help) {
    console.log(usage);
    return;
  }
  if (options.tunnel && options.publicUrl) {
    throw new ConfigError("--tunnel 和 --public-url 不能同时使用：快速隧道的地址由 cloudflared 分配。");
  }
  const state = await openState(options.stateDir);
  const { token, source } = await resolveToken(state, { renew: options.newToken });
  const root = options.root ?? await askRoot(state.get().lastRoot);
  const publicUrl = options.publicUrl ?? (options.tunnel ? undefined : state.get().publicUrl);

  const encodings = options.legacyEncoding
    ? { legacyEncoding: options.legacyEncoding, consoleEncoding: options.legacyEncoding }
    : await detectEncodings();

  let bridge;
  try {
    bridge = await startBridge({
      root, token, publicUrl, ...encodings,
      port: options.port, mcpPort: options.mcpPort, mcpHost: options.mcpHost, tunnel: options.tunnel,
      policy: options.policy, waitMs: options.waitMs, shellWaitMs: options.shellWaitMs,
      rememberPublicUrl: (url) => state.save({ publicUrl: url }),
      log: (text) => console.log(`\n${text}`),
    });
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    throw new ConfigError(`端口 ${error.port} 已被占用，可能已经有一个云端桥在运行。关掉它，或用 --port、--mcp-port 换端口。`);
  }
  await state.save({ lastRoot: bridge.root, ...(options.publicUrl && { publicUrl }) });

  const tokenNote = {
    env: "来自环境变量 CLOUD_BRIDGE_TOKEN",
    saved: `保存在 ${state.file}`,
    new: `已新生成，保存在 ${state.file}${options.newToken ? "（旧令牌已失效，云端 MCP 配置要换成新的）" : ""}`,
  }[source];
  const publicNote = publicUrl ? `${publicUrl}/mcp`
    : options.tunnel ? "正在启动 cloudflared 隧道……"
      : "未设置。启动隧道后，在网页的“连接配置”里填写，或下次启动加 --public-url";
  console.log([
    "",
    "Cursor 云端桥已启动",
    `  项目根目录  ${bridge.root}`,
    `  网页控制台  ${bridge.consoleUrl}  （只能在本机打开）`,
    `  MCP 端点    ${bridge.localMcpUrl}  （隧道只指向这个端口）`,
    `  公网地址    ${publicNote}`,
    `  命令策略    ${policyLabels[options.policy]}`,
    `  访问令牌    ${tokenNote}；云端要填的完整配置在网页的“连接配置”里复制`,
    "",
    "按 Ctrl+C 停止。",
  ].join("\n"));
  const warning = rootWarning(bridge.root, nodePath.resolve(options.stateDir));
  if (warning) console.log(`\n${warning}`);
  if (publicUrl?.startsWith("http://")) console.log("\n警告：公网地址不是 https，访问令牌和文件内容会在网络上明文传输。");
  if (options.mcpHost !== "127.0.0.1") {
    console.log(`\n注意：MCP 端点监听在 ${options.mcpHost}，同一网络里的其他设备也能访问它（仍然需要令牌）。`);
  }
  if (publicUrl) {
    void bridge.selfTest().then((result) => console.log(`\n公网地址自检${result.ok ? "通过" : "未通过"}：${result.message}`));
  }
  if (options.open) openBrowser(bridge.consoleUrl);

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    process.on(signal, () => {
      if (stopping) process.exit(1);
      stopping = true;
      console.log("\n正在停止……");
      // Running commands are killed synchronously first; open connections must not delay the exit.
      void bridge.stop().finally(() => process.exit(0));
    });
  }
}

if (process.argv[1] && nodePath.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof ConfigError || error instanceof PathError ? error.message : error);
    process.exitCode = 1;
  });
}
