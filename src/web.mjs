import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createWebSessions } from "./web-sessions.mjs";

const host = "127.0.0.1";
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/subagents.js", ["subagents.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);
const messageBody = z.object({ text: z.string().trim().min(1).max(100000) });
const deleteBody = z.object({ deleteCursor: z.boolean().default(false) });
const dispatchBody = z.object({
  windowId: z.string().min(1).max(200),
  workspaceId: z.string().min(1).max(200),
  prompt: z.string().trim().min(1).max(100000),
  models: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
});

export async function startWeb({ createMcpServer, inConnectedWindow, readSessionStatuses, getModelVariants, listDispatchTargets, dispatchFromWeb }) {
  const port = Number(process.env.CURSOR_WEB_PORT ?? 3210);
  const origin = `http://${host}:${port}`;
  const sessions = createWebSessions({ origin, inConnectedWindow, readSessionStatuses });

  const http = createServer(async (req, res) => {
    try {
      if (req.headers.host !== `${host}:${port}` || (req.headers.origin && req.headers.origin !== origin)) {
        json(res, 403, { error: "请从本机 WebUI 地址访问" });
        return;
      }
      const { pathname, searchParams } = new URL(req.url, origin);
      if (pathname === "/mcp") {
        await handleMcp(req, res, createMcpServer(sessions));
        return;
      }
      const asset = assets.get(pathname);
      if (req.method === "GET" && asset) {
        const [file, type] = asset;
        const content = await readFile(new URL(`../web/${file}`, import.meta.url));
        res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" }).end(content);
        return;
      }
      if (req.method === "GET" && pathname === "/api/sessions") {
        json(res, 200, await sessions.list());
        return;
      }
      if (req.method === "GET" && pathname === "/api/model-variants") {
        json(res, 200, await getModelVariants(searchParams.get("windowId")));
        return;
      }
      if (req.method === "GET" && pathname === "/api/dispatch-targets") {
        json(res, 200, await listDispatchTargets());
        return;
      }
      if (req.method === "POST" && pathname === "/api/dispatch") {
        const parsed = dispatchBody.safeParse(await readBody(req, origin));
        if (!parsed.success) {
          json(res, 400, { error: "请选择已打开的工作区和有效的模型档位，并填写派发提示词" });
          return;
        }
        const parent = await dispatchFromWeb(parsed.data, sessions);
        json(res, 201, parent);
        return;
      }
      const match = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
      const entry = match && sessions.get(decodeURIComponent(match[1]));
      if (entry && req.method === "GET") {
        json(res, 200, await sessions.read(entry));
        return;
      }
      if (entry && req.method === "DELETE") {
        const parsed = deleteBody.safeParse(await readBody(req, origin));
        if (!parsed.success) {
          json(res, 400, { error: "删除选项必须是布尔值" });
          return;
        }
        json(res, 200, await sessions.remove(entry, parsed.data.deleteCursor));
        return;
      }
      if (entry && req.method === "POST") {
        const parsed = messageBody.safeParse(await readBody(req, origin));
        if (!parsed.success) {
          json(res, 400, { error: "请输入 1 至 100000 字符的消息" });
          return;
        }
        const result = await sessions.send(entry, parsed.data.text);
        if (result.webStatus === "offline") {
          json(res, 409, { ...result, error: "会话已离线，请在 Cursor 中重新接入" });
          return;
        }
        if (result.webStatus === "unavailable") {
          json(res, 503, { ...result, error: "暂时无法确认 Cursor 会话状态" });
          return;
        }
        json(res, 200, result);
        return;
      }
      json(res, 404, { error: "会话或页面不存在，请确认会话已接入" });
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: error.message });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, resolve);
  });
  console.log(`WebUI ${origin}/`);
  console.log(`MCP   ${origin}/mcp`);
  return origin;
}

async function readBody(req, origin) {
  if (req.headers["content-type"] !== "application/json") return;
  try { return await new Request(origin, { method: req.method, body: req, duplex: "half" }).json(); } catch {}
}

async function handleMcp(req, res, server) {
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: false });
  res.once("close", () => { void server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } finally {
    await server.close();
  }
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}
