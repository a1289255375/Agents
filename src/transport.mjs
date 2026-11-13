// Two ways to reach a Cursor window, both returning the same shape:
//   { windows: [{ title, isFocused(), evaluate(expr), install(fnSource, version) }], close() }
// 1. attach (default): activate the Node inspector of the running Cursor main process on demand
//    (process._debugProcess is the Windows counterpart of SIGUSR1), drive windows through Electron's
//    webContents from there, and close the inspector again when the call is done.
// 2. port: Cursor was started with --remote-debugging-port, talk CDP to each window directly.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const INSPECTOR_PORT = 9229; // Node's default; Cursor's main process is not started with --inspect-port
const RELAY = "globalThis.__cursorSessionMcpMain";

export async function openCursor({ cdpPort, mainPid }) {
  const pages = await listCdpPages(cdpPort);
  return pages ? openByPort(pages) : openByAttach(mainPid);
}

// ---------- attach ----------

let cachedMain;

async function openByAttach(pidOverride) {
  const main = pidOverride ?? (await cursorMainPid());
  let session;
  try {
    session = await attachMain(main);
  } catch (e) {
    if (pidOverride || !/找不到进程|does not exist|ESRCH/i.test(String(e))) throw e;
    cachedMain = undefined; // the cached process is gone; look again once
    session = await attachMain(await cursorMainPid());
  }
  const windows = (await session.evaluate(`${RELAY}.windows()`)).map((w) => attachWindow(session, w));
  return { windows, close: session.close };
}

async function cursorMainPid() {
  if (cachedMain && (await inspectorTargets()) === null && processAlive(cachedMain)) return cachedMain;
  const mains = await cursorMainProcesses();
  if (mains.length === 0) throw new Error("没找到正在运行的 Cursor（Cursor.exe 主进程）");
  // Prefer a process that owns a window; among several installs prefer the system-wide one.
  mains.sort((a, b) => (b.title ? 1 : 0) - (a.title ? 1 : 0) || (/program files/i.test(b.exe) ? 1 : 0) - (/program files/i.test(a.exe) ? 1 : 0));
  cachedMain = mains[0].pid;
  return cachedMain;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cursorMainProcesses() {
  // The real Electron main is a Cursor.exe that is not a utility (--type=), not a child of another Cursor, and
  // not an ELECTRON_RUN_AS_NODE script runner (git worker, language server, MCP server: command line ends in a
  // .js/.cjs/.mjs script). Those script runners have no webContents, so skip them.
  const script = `$all = Get-CimInstance Win32_Process -Filter "Name='Cursor.exe'"; $ids = @($all | ForEach-Object ProcessId);
    $mains = @($all | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch '\\.(js|cjs|mjs)(\\s|\\"|$)' -and $ids -notcontains $_.ParentProcessId } | ForEach-Object {
      [pscustomobject]@{ pid = $_.ProcessId; exe = $_.ExecutablePath; title = (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).MainWindowTitle } });
    ConvertTo-Json -InputObject $mains -Compress`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 20000 });
  const parsed = stdout.trim() ? JSON.parse(stdout) : [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function inspectorTargets() {
  try {
    return await (await fetch(`http://127.0.0.1:${INSPECTOR_PORT}/json/list`)).json();
  } catch {
    return null;
  }
}

async function attachMain(pid) {
  if ((await inspectorTargets()) === null) {
    try {
      process._debugProcess(pid);
    } catch (e) {
      throw new Error(`找不到进程 ${pid} 或无权访问：${e.message}`);
    }
    await waitFor(async () => (await inspectorTargets()) !== null, 3000, "Cursor 主进程没有打开调试入口（3 s 内 9229 没有监听）");
  }
  const targets = await inspectorTargets();
  const target = targets.find((t) => t.type === "node") ?? targets[0];
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  const actual = await cdp.evaluate("process.pid");
  if (actual !== pid) {
    cdp.close();
    throw new Error(`127.0.0.1:${INSPECTOR_PORT} 被别的 Node 进程（pid ${actual}）占用，关掉它再试`);
  }
  // inspector.close() blocks while a client is connected, so schedule it, disconnect, then wait for the port to drop.
  const close = async () => {
    try {
      await cdp.evaluate(`setTimeout(() => ${MAIN_REQUIRE}("inspector").close(), 300); "closing"`);
    } catch {}
    cdp.close();
    await waitFor(async () => (await inspectorTargets()) === null, 2000, "").catch(() => {});
  };
  try {
    await cdp.evaluate(RELAY_INIT);
  } catch (e) {
    await close();
    throw e;
  }
  return { evaluate: cdp.evaluate, close };
}

// `require` is only a command-line API in the inspector context; the main module's require always works.
const MAIN_REQUIRE = `(process.mainModule?.require ?? require)`;

const RELAY_INIT = `${RELAY} ??= (() => {
  const { webContents } = ${MAIN_REQUIRE}("electron");
  const workbench = () => webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getType() === "window" && w.getURL().includes("/workbench/workbench.html"));
  const byId = (id) => { const w = webContents.fromId(id); if (!w || w.isDestroyed()) throw new Error("窗口已关闭"); return w; };
  const group = "cursor-session-mcp";
  return {
    windows: () => workbench().map((w) => ({ id: w.id, title: w.getTitle(), focused: w.isFocused() })),
    exec: (id, code) => byId(id).executeJavaScript(code, false),
    install: async (id, fnSource, version) => {
      const dbg = byId(id).debugger;
      const attached = dbg.isAttached();
      if (!attached) dbg.attach("1.3");
      try {
        const proto = await dbg.sendCommand("Runtime.evaluate", { expression: "Map.prototype", objectGroup: group });
        const maps = await dbg.sendCommand("Runtime.queryObjects", { prototypeObjectId: proto.result.objectId, objectGroup: group });
        const r = await dbg.sendCommand("Runtime.callFunctionOn", { objectId: maps.objects.objectId, functionDeclaration: fnSource, arguments: [{ value: version }], awaitPromise: true, returnByValue: true });
        await dbg.sendCommand("Runtime.releaseObjectGroup", { objectGroup: group });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      } finally {
        if (!attached) dbg.detach();
      }
    },
  };
})(); "ready"`;

function attachWindow(main, w) {
  // executeJavaScript loses the error message of a rejected script, so errors travel back as data.
  const wrap = (expr) => `(async () => { try { return { ok: await (${expr}) }; } catch (e) { return { err: String(e?.message ?? e) }; } })()`;
  return {
    id: w.id,
    title: w.title,
    isFocused: async () => w.focused,
    evaluate: async (expr) => {
      const r = await main.evaluate(`${RELAY}.exec(${w.id}, ${JSON.stringify(wrap(expr))})`);
      if (r && typeof r === "object" && "err" in r) throw new Error(r.err);
      return r?.ok;
    },
    install: (fnSource, version) => main.evaluate(`${RELAY}.install(${w.id}, ${JSON.stringify(fnSource)}, ${version})`),
  };
}

// ---------- port ----------

async function listCdpPages(port) {
  if (!port) return null;
  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch {
    return null;
  }
  return targets.filter((t) => t.type === "page" && t.url.includes("/workbench/workbench.html"));
}

function openByPort(pages) {
  const windows = pages.map(portWindow);
  return { windows, close: async () => windows.forEach((w) => w.close()) };
}

function portWindow(page) {
  let cdp;
  const session = async () => (cdp ??= await connectCdp(page.webSocketDebuggerUrl));
  return {
    id: page.id,
    title: page.title,
    isFocused: async () => (await session()).evaluate("document.hasFocus()"),
    evaluate: async (expr) => (await session()).evaluate(expr),
    install: async (fnSource, version) => {
      const s = await session();
      const group = "cursor-session-mcp";
      const proto = await s.send("Runtime.evaluate", { expression: "Map.prototype", objectGroup: group });
      const maps = await s.send("Runtime.queryObjects", { prototypeObjectId: proto.result.objectId, objectGroup: group });
      try {
        return unwrap(
          await s.send("Runtime.callFunctionOn", {
            objectId: maps.objects.objectId,
            functionDeclaration: fnSource,
            arguments: [{ value: version }],
            awaitPromise: true,
            returnByValue: true,
          }),
        );
      } finally {
        await s.send("Runtime.releaseObjectGroup", { objectGroup: group });
      }
    },
    close: () => cdp?.close(),
  };
}

// ---------- shared ----------

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error(`调试连接失败：${wsUrl}`)), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${msg.error.message} ${msg.error.data ?? ""}`.trim()));
    else p.resolve(msg.result);
  });
  ws.addEventListener("close", () => {
    for (const p of pending.values()) p.reject(new Error("调试连接已断开（Cursor 窗口关闭或重载）"));
    pending.clear();
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return {
    send,
    evaluate: async (expression) =>
      unwrap(await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true })),
    close: () => ws.close(),
  };
}

function unwrap(r) {
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

async function waitFor(check, timeoutMs, message) {
  for (let waited = 0; ; waited += 100) {
    if (await check()) return;
    if (waited >= timeoutMs) throw new Error(message);
    await new Promise((r) => setTimeout(r, 100));
  }
}
