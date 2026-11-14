// Two HTTP listeners. Only the MCP endpoint is meant to be reached through a tunnel; the console and
// its control API listen on 127.0.0.1 and refuse anything that looks like it came through a proxy.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { hasBearer } from "./auth.mjs";
import { ConfigError } from "./config.mjs";
import { SessionError } from "./hub.mjs";
import { createMcpServer } from "./mcp.mjs";
import { CommandError } from "./project/commands.mjs";

const proxyHeaders = [
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded", "via",
  "cf-connecting-ip", "cf-ray", "true-client-ip",
];
const loopbackHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const statePollMs = 25_000;

function json(res, status, data, headers) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(data));
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function closedSignal(res) {
  const controller = new AbortController();
  res.once("close", () => controller.abort());
  return controller.signal;
}

// The address the caller used to reach this endpoint, as far as the request tells. `external` is
// false for a direct call on this machine.
function addressOf(req) {
  const first = (name) => req.headers[name]?.split(",")[0].trim();
  const viaProxy = proxyHeaders.some((name) => req.headers[name] !== undefined);
  const host = first("x-forwarded-host") || req.headers.host;
  if (!host) return {};
  // A loopback Host behind a proxy means the tunnel rewrote it, and the public name is unknown.
  if (loopbackHost.test(host)) return viaProxy ? {} : { base: `http://${host}`, external: false };
  const proto = first("x-forwarded-proto");
  // Tunnels that terminate TLS announce themselves with proxy headers; a plain port mapping does not.
  return { base: `${proto === "http" || proto === "https" ? proto : viaProxy ? "https" : "http"}://${host}`, external: true };
}

export async function startMcpEndpoint({ bridge, hub, project, thinking, port, host }) {
  const config = { waitMs: bridge.waitMs, commandWaitMs: bridge.commandWaitMs };

  function unauthorized(res) {
    bridge.unauthorized++;
    hub.notify();
    json(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: missing or invalid bearer token" }, id: null },
      { "WWW-Authenticate": "Bearer" });
  }

  // Stateless: every POST gets its own server and transport, so nothing breaks when the tunnel,
  // the proxy in front of it, or this process restarts between two calls.
  async function handleMcp(req, res) {
    const address = addressOf(req);
    if (address.external && address.base !== bridge.observedUrl) {
      bridge.observedUrl = address.base;
      hub.notify();
    }
    const server = createMcpServer({ hub, project, config, thinking });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.once("close", () => { void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } finally {
      await server.close();
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, "http://bridge.invalid");
      if (pathname === "/" && req.method === "GET") {
        json(res, 200, { service: "cursor-cloud-bridge", instance: bridge.instance });
        return;
      }
      if (pathname === "/mcp") {
        if (!hasBearer(req, bridge.token)) unauthorized(res);
        else if (req.method !== "POST") json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, { Allow: "POST" });
        else await handleMcp(req, res);
        return;
      }
      json(res, 404, { error: "not found" });
    } catch (error) {
      console.error(`MCP 端点内部错误：${error?.stack ?? error}`);
      if (res.headersSent) res.destroy();
      else json(res, 500, { error: "internal error" });
    }
  });
  return { server, port: await listen(server, port, host) };
}

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);
const messageBody = z.object({ text: z.string().trim().min(1).max(100000) });
const decisionBody = z.object({ decision: z.enum(["allow", "always", "deny"]) });
const policyBody = z.object({ policy: z.enum(["ask", "allow", "deny"]) });
const publicUrlBody = z.object({ url: z.string().trim().max(500) });

export async function startConsole({ bridge, hub, project, port, actions }) {
  let origins;

  async function body(req, schema) {
    if (req.headers["content-type"] !== "application/json") return undefined;
    try {
      const parsed = schema.safeParse(await new Request("http://console.invalid", { method: req.method, body: req, duplex: "half" }).json());
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async function route(req, res) {
    const { pathname, searchParams } = new URL(req.url, "http://console.invalid");
    const asset = assets.get(pathname);
    if (req.method === "GET" && asset) {
      const [file, type] = asset;
      const content = await readFile(new URL(`../web/${file}`, import.meta.url));
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" }).end(content);
      return;
    }

    if (req.method === "GET" && pathname === "/api/state") {
      const since = Number(searchParams.get("rev")) || 0;
      const signal = closedSignal(res);
      if (!searchParams.has("now")) {
        await hub.watch(since, statePollMs, signal);
        // Changes arrive in bursts (command output, a reply followed by the next wait).
        await sleep(40);
      }
      if (signal.aborted) return;
      const selected = searchParams.get("session");
      json(res, 200, {
        rev: hub.revision,
        bridge: actions.view(),
        sessions: hub.summaries(),
        session: (selected && hub.detail(selected)) ?? null,
        activity: hub.activitySince(since),
      });
      return;
    }
    if (req.method === "GET" && pathname === "/api/connection") {
      json(res, 200, await actions.connection());
      return;
    }
    if (req.method === "POST" && pathname === "/api/policy") {
      const data = await body(req, policyBody);
      if (!data) return json(res, 400, { error: "命令策略必须是 ask、allow 或 deny" });
      project.commands.setPolicy(data.policy);
      hub.notify();
      return json(res, 200, { policy: data.policy });
    }
    if (req.method === "POST" && pathname === "/api/public-url") {
      const data = await body(req, publicUrlBody);
      if (!data) return json(res, 400, { error: "请填写公网地址" });
      return json(res, 200, await actions.setPublicUrl(data.url));
    }
    if (req.method === "POST" && pathname === "/api/selftest") {
      return json(res, 200, await actions.selfTest());
    }

    const job = /^\/api\/jobs\/(c\d+)\/(decision|stop)$/.exec(pathname);
    if (job && req.method === "POST") {
      if (job[2] === "stop") {
        project.commands.stop(job[1]);
        return json(res, 200, { stopped: true });
      }
      const data = await body(req, decisionBody);
      if (!data) return json(res, 400, { error: "decision 必须是 allow、always 或 deny" });
      project.commands.decide(job[1], data.decision);
      return json(res, 200, { decision: data.decision });
    }

    const session = /^\/api\/sessions\/([0-9a-f]{8})(\/messages|\/disconnect)?$/.exec(pathname);
    if (session && hub.detail(session[1])) {
      const [, id, action] = session;
      if (req.method === "POST" && action === "/messages") {
        const data = await body(req, messageBody);
        if (!data) return json(res, 400, { error: "请输入 1 至 100000 字符的消息" });
        hub.send(id, data.text);
        return json(res, 200, hub.detail(id));
      }
      if (req.method === "POST" && action === "/disconnect") {
        hub.disconnect(id, "user");
        return json(res, 200, hub.detail(id));
      }
      if (req.method === "DELETE" && !action) {
        hub.remove(id);
        return json(res, 200, { id, deleted: true });
      }
    }
    json(res, 404, { error: "会话或页面不存在" });
  }

  const server = createServer(async (req, res) => {
    try {
      // Host and Origin checks stop DNS rebinding and cross-site requests from a browser. Proxy
      // headers mean someone pointed a tunnel at this port; the console must never be served that way.
      const viaProxy = proxyHeaders.some((name) => req.headers[name] !== undefined);
      if (viaProxy || !origins.has(`http://${req.headers.host}`) || (req.headers.origin && !origins.has(req.headers.origin))) {
        json(res, 403, { error: "控制台只能在本机用 http://127.0.0.1 访问，不能经隧道或代理访问" });
        return;
      }
      await route(req, res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
      } else if (error instanceof SessionError || error instanceof CommandError || error instanceof ConfigError) {
        json(res, 409, { error: error.message });
      } else {
        console.error(`控制台内部错误：${error?.stack ?? error}`);
        json(res, 500, { error: String(error?.message ?? error) });
      }
    }
  });
  const listening = await listen(server, port, "127.0.0.1");
  origins = new Set([`http://127.0.0.1:${listening}`, `http://localhost:${listening}`]);
  return { server, port: listening };
}
