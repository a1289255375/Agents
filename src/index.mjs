#!/usr/bin/env node
// MCP server that creates and drives Cursor chat sessions in the running Cursor (see transport.mjs).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { openCursor } from "./transport.mjs";
import { BRIDGE_VERSION, installBridge } from "./bridge.mjs";
import { startWeb } from "./web.mjs";

const connection = {
  cdpPort: Number(process.env.CURSOR_CDP_PORT ?? 0) || undefined, // only if Cursor runs with --remote-debugging-port
  mainPid: Number(process.env.CURSOR_MAIN_PID ?? 0) || undefined, // pin a specific Cursor.exe (tests)
};
const waitInstruction = "message 是用户交给当前 Agent 的任务。按内容执行或回答，按需使用 Cursor 自己的工具完成工作。需要说明进展时用正常对话输出。用 reply_message 发送实际结果，然后立即用返回的 id 再次调用 wait_message。等待调用会一直挂起直到收到网页消息或断开，请留在当前这一轮。";
const pendingConnections = new Map();

function requestBinding(toolName, args, confirmation) {
  const bindingToken = randomUUID();
  const expiry = setTimeout(() => pendingConnections.delete(bindingToken), 120_000).unref();
  pendingConnections.set(bindingToken, { window: args.window, expiry, toolName, confirmation });
  return {
    event: "bind",
    bindingToken,
    instruction: "立即在本会话调用下面的 nextCall 确认来源。",
    nextCall: { name: toolName, arguments: { ...args, bindingToken } },
  };
}

function createMcpServer(sessions) {
  const server = new McpServer({ name: "cursor-session", version: "0.3.0" });

  const windowArg = z.string().optional().describe("目标窗口标题里的一段文字；不填用有焦点的 Cursor 窗口");
  const idArg = z.string().describe("会话 ID（create_session / list_sessions 返回的 id）");
  const modelArg = z
    .string()
    .optional()
    .describe("模型名，可用 model-id[参数=值,...] 或 “opus5-5 1m max fast”");
  const maxModeArg = z.boolean().optional().describe("是否开 Max 模式，默认关");

  if (sessions) {
    tool(
      "connect_session",
      `调用 connect_session({}) 自动接入自己的 Cursor 会话。收到 event=bind 时，在同一会话立即用返回的 bindingToken 再调用一次 connect_session 以确认来源并开始等待。外部 MCP 客户端可用 id 指定会话。${waitInstruction}`,
      {
        id: idArg.optional(),
        window: windowArg,
        bindingToken: z.uuid().optional().describe("仅在收到 event=bind 时使用，填写工具返回的 bindingToken"),
      },
      async ({ id, window, bindingToken }, extra) => {
        if (!id && !bindingToken) {
          return requestBinding("connect_session", { window });
        }
        const session = bindingToken
          ? await withCallingSession(bindingToken, "connect_session", extra.signal, async (caller) =>
              sessions.add(await caller.bridge.call("connect", { id: caller.id }), caller.w, { relay: true }))
          : await inWindow(window, async (bridge, w) =>
              sessions.add(await bridge.call("connect", { id }), w, { relay: true }));
        const result = await sessions.wait(session.id, extra);
        return { ...result, instruction: result.event === "disconnected" ? "网页等待已结束。" : waitInstruction };
      },
    );
    tool(
      "wait_message",
      `让已接入的会话等待下一条网页消息。${waitInstruction}`,
      { id: idArg },
      async ({ id }, extra) => {
        const result = await sessions.wait(id, extra);
        return { ...result, instruction: result.event === "disconnected" ? "网页等待已结束。" : waitInstruction };
      },
    );
    tool(
      "reply_message",
      "把执行用户任务后的结果或问题答复发到网页。随后立刻调用 wait_message 继续等待。",
      { id: idArg, text: z.string().trim().min(1).max(100000) },
      ({ id, text }) => ({ ...sessions.reply(id, text), instruction: "现在立刻用同一个 id 调用 wait_message。" }),
    );
    tool(
      "disconnect_session",
      "停止此会话的网页等待。仅在用户明确要求结束网页等待时调用。",
      { id: idArg },
      ({ id }) => sessions.disconnect(id),
    );
  }

  tool(
    "list_windows",
    "列出能控制的 Cursor 窗口：标题、类型（agents / editor）、是否有焦点、编辑器窗口打开的文件夹",
    {},
    () =>
      withCursor(async (cursor) => {
        const infos = [];
        for (const w of cursor.windows) infos.push(await (await bridgeOf(w)).call("info"));
        return infos;
      }),
  );

  tool("list_models", "列出目标窗口当前可用的模型，标出默认模型", { window: windowArg }, ({ window }) =>
    inWindow(window, (b) => b.call("models")),
  );
  tool(
    "list_model_variants",
    "列出可传给 create_subagents 的实际模型档位，包括该模型支持的上下文、推理强度、Thinking 和 Fast",
    { window: windowArg },
    ({ window }) => getModelVariants(window),
  );

  tool(
    "check_model",
    "只解析模型和档位（不建会话），返回会用的模型名、Max 开关和参数",
    { model: z.string().min(1).describe("同 create_session 的 model"), window: windowArg },
    ({ window, ...args }) => inWindow(window, (b) => b.call("checkModel", args)),
  );

  tool(
    "list_workspaces",
    "Agents 窗口：列出已有 agent 所属的项目文件夹（create_session 的 workspace 可用这里的 folder）；编辑器窗口：它打开的文件夹",
    { window: windowArg },
    ({ window }) => inWindow(window, (b) => b.call("workspaces")),
  );

  tool(
    "create_session",
    "新建一个 Cursor 会话（Agents 窗口里是新 agent，编辑器窗口里是新聊天标签），可指定项目文件夹、模型、模式、名字，并直接发出第一条消息",
    {
      prompt: z.string().optional().describe("第一条消息；不填只建空会话"),
      workspace: z
        .string()
        .optional()
        .describe("项目文件夹的本地路径（Agents 窗口用；不填用当前打开的 agent 所在项目）"),
      model: modelArg,
      maxMode: maxModeArg,
      mode: z.string().optional().describe("agent（默认）/ plan / debug / multitask / chat（Ask），或自定义模式名"),
      name: z.string().optional().describe("会话名字"),
      submit: z.boolean().optional().describe("是否直接发出 prompt，默认是；false 时只填进输入框"),
      window: windowArg,
    },
    ({ window, workspace, ...args }) =>
      inWindow(window, async (b, w) => {
        const session = await b.call("create", { ...args, workspace: workspace ? workspaceArg(workspace) : undefined });
        if (sessions) sessions.add(session, w);
        return session;
      }),
  );

  tool(
    "create_subagents",
    "为当前 Cursor 会话并行创建原生本地子代理，每个子代理可指定不同模型档位。父会话在 Cursor 中调用时省略 parentId，收到 event=bind 后按 nextCall 确认，然后等待创建结果。外部 MCP 客户端可指定 parentId 和 window。",
    {
      agents: z.array(z.object({
        name: z.string().trim().min(1).max(100),
        model: z.string().trim().min(1).max(500).describe("模型档位，原样使用 list_model_variants 返回的 model"),
        prompt: z.string().trim().min(1).max(20000),
      })).min(1).max(10),
      parentId: idArg.optional(),
      window: windowArg,
      bindingToken: z.uuid().optional().describe("收到 event=bind 时才传工具给出的令牌"),
    },
    ({ agents, parentId, window, bindingToken }, { signal }) => {
      const start = async (bridge, target, id, specs) => {
        signal.throwIfAborted();
        let children;
        try {
          children = await bridge.call("createSubagents", { parentId: id, agents: specs });
        } catch (error) {
          for (const spec of specs) sessions?.addDispatchResult({ name: spec.name, error: error.message }, id, target);
          throw error;
        }
        for (const child of children) sessions?.addDispatchResult(child, id, target);
        return { parentId: id, children };
      };
      if (bindingToken) {
        return withCallingSession(bindingToken, "create_subagents", signal, ({ bridge, w, id }, pending) =>
          start(bridge, w, id, pending.confirmation));
      }
      if (parentId) return inWindow(window, (bridge, target) => start(bridge, target, parentId, agents));
      return requestBinding("create_subagents", { agents, window }, agents);
    },
  );

  tool(
    "send_message",
    "向已有会话发一条消息。会话还在生成时按 whenBusy 处理：reject（默认，拒绝）、steer（不停下，插进正在进行的这一轮）、queue（这一轮结束后自动发）、interrupt（先停掉当前生成再发）",
    {
      id: idArg,
      text: z.string().min(1).describe("消息内容"),
      model: modelArg,
      maxMode: maxModeArg,
      whenBusy: z.enum(["reject", "steer", "queue", "interrupt"]).optional(),
      window: windowArg,
    },
    ({ window, ...args }) => inWindow(window, (b) => b.call("send", args)),
  );

  tool(
    "read_session",
    "读取会话状态和最近的消息，包括正文、Cursor 可见的思考、工具输出和错误。生成中也可读取当前内容；waitSeconds 可等待生成结束",
    {
      id: idArg,
      last: z.number().int().min(1).max(200).optional().describe("返回最近几条消息，默认 10"),
      maxChars: z.number().int().min(100).max(100000).optional().describe("正文、思考、错误和工具输出每个字段的最大字符数，默认 4000"),
      // MCP clients (Cursor included) time a tool call out at about 60 s, so one call never waits longer than 55 s.
      waitSeconds: z.number().int().min(0).max(55).optional().describe("最多等多少秒（≤ 55）；还在生成就再调一次"),
      window: windowArg,
    },
    async ({ window, waitSeconds = 0, ...args }) => {
      // Poll in short separate connections so other calls (e.g. stop_session) can interleave while waiting.
      const deadline = Date.now() + waitSeconds * 1000;
      while (Date.now() < deadline) {
        if ((await inWindow(window, (b) => b.call("summary", args.id))).status !== "generating") break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      return inWindow(window, (b) => b.call("read", args));
    },
  );

  tool(
    "list_sessions",
    "按最近更新时间列出会话（Agents 窗口列侧边栏里的 agent）",
    {
      limit: z.number().int().min(1).max(500).optional().describe("默认 20"),
      includeArchived: z.boolean().optional().describe("是否包含已归档的，默认否"),
      window: windowArg,
    },
    ({ window, ...args }) => inWindow(window, (b) => b.call("list", args)),
  );

  tool("stop_session", "停止会话当前的生成", { id: idArg, window: windowArg }, ({ window, ...args }) =>
    inWindow(window, (b) => b.call("stop", args)),
  );

  tool("open_session", "在窗口里打开并切到这个会话", { id: idArg, window: windowArg }, ({ window, ...args }) =>
    inWindow(window, (b) => b.call("open", args)),
  );

  tool(
    "rename_session",
    "给会话改名",
    { id: idArg, name: z.string().min(1), window: windowArg },
    ({ window, ...args }) => inWindow(window, (b) => b.call("rename", args)),
  );

  return server;

  function tool(name, description, inputSchema, run) {
    server.registerTool(name, { description, inputSchema }, async (args, extra) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(await run(args, extra), null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: String(e?.message ?? e) }] };
      }
    });
  }
}

// VS Code identifies a local single-folder workspace by md5(URI.fsPath + folder birth time); fsPath carries a
// lower-case drive letter. Agents are grouped by this id, so it is computed here where the folder can be stat'ed.
function workspaceArg(folder) {
  const resolved = path.resolve(folder);
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    throw new Error(`文件夹不存在：${resolved}`);
  }
  if (!stat.isDirectory()) throw new Error(`不是文件夹：${resolved}`);
  const fsPath = /^[A-Za-z]:/.test(resolved) ? resolved[0].toLowerCase() + resolved.slice(1) : resolved;
  const birth = Math.floor(stat.birthtimeMs);
  const id = createHash("md5").update(fsPath).update(birth ? String(birth) : "").digest("hex");
  return { folder: resolved, id };
}

// Calls run one at a time: the attach transport opens and closes Cursor's inspector around each call.
let queue = Promise.resolve();
function withCursor(fn) {
  const run = async () => {
    const cursor = await openCursor(connection);
    try {
      return await fn(cursor);
    } finally {
      await cursor.close();
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

function inWindow(title, fn) {
  return withCursor(async (cursor) => {
    const window = await pickWindow(cursor.windows, title);
    return fn(await bridgeOf(window), window);
  });
}

function getModelVariants(window) {
  return inWindow(window, (bridge) => bridge.call("models", { includeVariants: true }));
}

function listDispatchTargets() {
  return withCursor(async ({ windows }) => {
    const results = await Promise.allSettled(windows.map(async (window) => {
      const bridge = await bridgeOf(window);
      const targets = await bridge.call("dispatchTargets");
      const focused = await window.isFocused();
      return targets.map((workspace) => ({
        windowId: String(window.id), title: window.title, workspaceId: workspace.id,
        folder: workspace.folder, preferred: focused && workspace.active,
      }));
    }));
    const open = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (!open.length && results.length && results.every((result) => result.status === "rejected")) throw results[0].reason;
    return open;
  });
}

function dispatchFromWeb({ windowId, workspaceId, prompt, models }, sessions) {
  return inWindowById(windowId, async (bridge, window) => {
    const session = await bridge.call("create", {
      workspaceId, mode: "multitask", name: "网页派发 · Multitask", prompt, model: models[0], subagentModels: models,
    });
    sessions.add(session, window, { dispatchParent: true });
    return session;
  });
}

function withCallingSession(bindingToken, toolName, signal, onCaller) {
  const pending = pendingConnections.get(bindingToken);
  if (pending?.toolName !== toolName) throw new Error("确认凭据无效或已过期，请从首次工具调用重新开始");

  return withCursor(async (cursor) => {
    signal.throwIfAborted();
    if (!pendingConnections.has(bindingToken)) throw new Error("确认凭据已使用或已过期");
    const windows = pending.window ? [await pickWindow(cursor.windows, pending.window)] : cursor.windows;
    const bridges = (await Promise.allSettled(windows.map(async (w) => ({ w, bridge: await bridgeOf(w) }))))
      .flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (!bridges.length) throw new Error("找不到可读的 Cursor 窗口");
    // Cursor can publish the first tool result to the workbench after the agent starts the second call.
    const deadline = Date.now() + 12_000;
    while (true) {
      const matches = (await Promise.all(bridges.map(async ({ w, bridge }) =>
        (await bridge.call("connectingSessions", { bindingToken, toolName })).map((id) => ({ id, w, bridge }))))).flat();
      const callers = new Map(matches.map((caller) => [caller.id, caller]));
      if (callers.size > 1) throw new Error("接入凭据出现在多个 Cursor 会话中");
      if (callers.size === 1) {
        const caller = callers.values().next().value;
        signal.throwIfAborted();
        clearTimeout(pending.expiry);
        pendingConnections.delete(bindingToken);
        return onCaller(caller, pending);
      }
      if (Date.now() >= deadline) break;
      await sleep(250, undefined, { signal });
    }
    throw new Error("Cursor 未显示接入凭据对应的工具结果，无法识别发起会话");
  });
}

function inConnectedWindow(id, fn) {
  return withCursor(async (cursor) => {
    const window = cursor.windows.find((w) => w.id === id);
    if (!window) throw new Error("原 Cursor 窗口已关闭，请在会话中重新调用 connect_session");
    return fn(await bridgeOf(window));
  });
}

function inWindowById(id, fn) {
  return withCursor(async ({ windows }) => {
    const window = windows.find((candidate) => String(candidate.id) === id);
    if (!window) throw new Error("所选 Cursor 窗口已关闭，请重新选择");
    return fn(await bridgeOf(window), window);
  });
}

async function readSessionStatuses(idsByWindow) {
  return withCursor(async ({ windows }) => {
    const results = await Promise.allSettled([...idsByWindow].map(async ([windowId, ids]) => {
      const window = windows.find((window) => window.id === windowId);
      if (!window) return Object.fromEntries(ids.map((id) => [id, null]));
      const bridge = await bridgeOf(window);
      const statuses = await bridge.call("sessionStatuses", ids);
      return Object.fromEntries(ids.map((id) => [id, statuses[id] ?? null]));
    }));
    return Object.assign({}, ...results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []));
  });
}

async function pickWindow(windows, title) {
  if (windows.length === 0) throw new Error("没找到 Cursor 窗口");
  if (title) {
    const hit = windows.find((w) => w.title.toLowerCase().includes(title.toLowerCase()));
    if (!hit) throw new Error(`没有标题包含「${title}」的窗口。现有：${windows.map((w) => w.title).join("，")}`);
    return hit;
  }
  if (windows.length === 1) return windows[0];
  for (const w of windows) if (await w.isFocused()) return w;
  return windows[0];
}

// The bridge lives in the page until the window reloads; installing it scans the page heap once (about a second).
async function bridgeOf(win) {
  const slot = `globalThis.__cursorSessionMcpBridges?.[${BRIDGE_VERSION}]`;
  if (!(await win.evaluate(`${slot}?.alive()`))) {
    if (!(await win.install(installBridge.toString(), BRIDGE_VERSION))) {
      throw new Error("没在窗口里找到 Cursor 的会话服务（窗口没加载完，或 Cursor 内部结构变了）");
    }
  }
  return { call: (op, arg = {}) => win.evaluate(`${slot}.${op}(${JSON.stringify(arg)})`) };
}

function watchWebMcp(origin) {
  async function check() {
    try {
      await withCursor(async ({ windows }) => {
        await Promise.allSettled(windows.map(async (window) =>
          (await bridgeOf(window)).call("watchWebMcp", { origin })));
      });
    } catch {
      // The WebUI can start before Cursor, or Cursor can be restarted while it runs.
    } finally {
      setTimeout(check, 3000).unref();
    }
  }
  void check();
}

if (process.argv.includes("--web")) {
  watchWebMcp(await startWeb({
    createMcpServer, inConnectedWindow, readSessionStatuses, listDispatchTargets, dispatchFromWeb,
    getModelVariants: (windowId) => windowId
      ? inWindowById(windowId, (bridge) => bridge.call("models", { includeVariants: true }))
      : getModelVariants(),
  }));
} else {
  await createMcpServer().connect(new StdioServerTransport());
}
