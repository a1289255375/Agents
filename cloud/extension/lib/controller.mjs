// The extension's logic, with the vscode API and the bridge code injected so it can be driven by the
// test runner with a fake vscode. It runs the cloud bridge inside the extension host (reusing
// startBridge from cloud/src) and shows the same web console in a panel. No file paths are hard-coded
// here; extension.js hands in the assembled bridge API.
import os from "node:os";
import nodePath from "node:path";
import { deployBundle, deployText } from "./deploy.mjs";
import { bridgeParams, OptionError, resolveRoot, restartKeys } from "./options.mjs";
import { originOf, waitingHtml, webviewHtml } from "./webview.mjs";

const configSection = "cursorCloudBridge";
const panelViewType = "cursorCloudBridge.console";
const statusPollMs = 4000;

export function createController({ vscode, bridgeApi, context, stateDir = nodePath.join(os.homedir(), ".cursor-cloud-bridge") }) {
  const output = vscode.window.createOutputChannel("Cursor 云端桥");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment?.Left ?? 1, 100);
  status.command = `${configSection}.openConsole`;
  let running;
  let panel;
  let statusTimer;
  let starting;

  const settings = () => {
    const config = vscode.workspace.getConfiguration(configSection);
    return {
      workspaceRoot: config.get("workspaceRoot") ?? "",
      commandPolicy: config.get("commandPolicy") ?? "ask",
      consolePort: config.get("consolePort"),
      mcpPort: config.get("mcpPort"),
      publicUrl: config.get("publicUrl") ?? "",
      tunnel: config.get("tunnel") ?? "none",
      relayUrl: config.get("relayUrl") ?? "",
      waitSeconds: config.get("waitSeconds"),
      shellWaitSeconds: config.get("shellWaitSeconds"),
      autoStart: config.get("autoStart") ?? true,
    };
  };

  const workspaceFolders = () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);

  async function consoleFetch(path, init) {
    if (!running) throw new Error("云端桥还没有启动");
    const response = await fetch(new URL(path, running.consoleUrl), {
      ...init,
      headers: init?.body ? { "Content-Type": "application/json", ...init?.headers } : init?.headers,
    });
    const data = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(data?.error ?? `控制台请求失败（HTTP ${response.status}）`);
    return data;
  }

  function setStatus(text, tooltip) {
    status.text = text;
    status.tooltip = tooltip;
    status.show();
  }

  async function refreshStatus() {
    if (!running) return setStatus("$(circle-slash) 云端桥已停", "点击打开控制台");
    try {
      const state = await consoleFetch("/api/state?now=1");
      const pending = state.bridge.jobs.filter((job) => job.state === "awaiting_approval").length;
      const count = state.sessions.length;
      setStatus(`$(radio-tower) 云端桥 · ${count} 会话${pending ? ` · ${pending} 命令待确认` : ""}`, running.consoleUrl);
    } catch {
      setStatus("$(radio-tower) 云端桥运行中", running.consoleUrl);
    }
  }

  async function start() {
    if (running || starting) return running;
    const root = resolveRoot({ configuredRoot: settings().workspaceRoot, workspaceFolders: workspaceFolders() });
    if (!root) {
      setStatus("$(folder) 云端桥：未设置工作区", "点击设置工作区目录");
      status.command = `${configSection}.setWorkspaceRoot`;
      throw new OptionError("还没有设置工作区目录。用命令“Cursor 云端桥：设置工作区目录”选择要交给 Cloud Agent 的项目文件夹。");
    }
    status.command = `${configSection}.openConsole`;
    starting = (async () => {
      const state = await bridgeApi.openState(stateDir);
      const { token } = await bridgeApi.resolveToken(state);
      const encodings = await bridgeApi.detectEncodings();
      const current = settings();
      // The setting wins; otherwise reuse the address the console last saved, as the standalone CLI
      // does. In relay or cloudflared mode bridgeParams ignores the saved address on its own.
      const params = bridgeParams({
        root, token, settings: current, encodings,
        savedPublicUrl: state.get().publicUrl, normalizeRelayUrl: bridgeApi.normalizeRelayUrl,
      });
      running = await bridgeApi.startBridge({
        ...params,
        rememberPublicUrl: (url) => state.save({ publicUrl: url }),
        log: (text) => output.appendLine(text),
      });
      await state.save({ lastRoot: running.root });
      output.appendLine(`云端桥已启动：项目 ${running.root}；控制台 ${running.consoleUrl}；MCP ${running.localMcpUrl}`);
      renderPanel();
      await refreshStatus();
      statusTimer = setInterval(() => { void refreshStatus(); }, statusPollMs);
      statusTimer.unref?.();
      return running;
    })();
    try {
      return await starting;
    } catch (error) {
      running = undefined;
      if (error?.code === "EADDRINUSE") {
        throw new OptionError(`端口 ${error.port ?? ""} 已被占用，可能已经有一个云端桥在运行（start-cloud.cmd 或另一个窗口）。关掉它，或在设置里改 cursorCloudBridge.consolePort / mcpPort。`);
      }
      throw error;
    } finally {
      starting = undefined;
    }
  }

  async function stop() {
    clearInterval(statusTimer);
    statusTimer = undefined;
    const current = running;
    running = undefined;
    if (current) await current.stop();
    if (panel) panel.webview.html = waitingHtml("云端桥已停止。用命令“Cursor 云端桥：重启云端桥”重新启动。");
    setStatus("$(circle-slash) 云端桥已停", "点击打开控制台");
  }

  async function restart() {
    await stop();
    await start();
  }

  function iframeInfo() {
    if (!running || !panel) return {};
    const base = vscode.Uri.parse(running.consoleUrl);
    const external = vscode.env.asExternalUri ? vscode.env.asExternalUri(base) : base;
    const resolve = (value) => (value && typeof value.then === "function" ? value : Promise.resolve(value));
    return { external: resolve(external) };
  }

  async function renderPanel() {
    if (!panel) return;
    if (!running) {
      panel.webview.html = waitingHtml("云端桥还没有启动。设置工作区目录后再打开控制台。");
      return;
    }
    const { external } = iframeInfo();
    const uri = await external;
    const iframeSrc = uri.toString(true);
    panel.webview.html = webviewHtml({ iframeSrc, frameOrigin: originOf(iframeSrc), consoleUrl: running.consoleUrl });
  }

  async function openConsole() {
    if (!running) await start();
    if (!panel) {
      panel = vscode.window.createWebviewPanel(panelViewType, "Cursor 云端桥", vscode.ViewColumn?.Active ?? 1, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });
      panel.onDidDispose(() => { panel = undefined; });
    } else {
      panel.reveal?.();
    }
    await renderPanel();
    return panel;
  }

  async function openConsoleInBrowser() {
    if (!running) await start();
    await vscode.env.openExternal(vscode.Uri.parse(running.consoleUrl));
  }

  async function prepareCloud() {
    if (!running) await start();
    const connection = await consoleFetch("/api/connection");
    const state = await consoleFetch("/api/state?now=1");
    const bundle = deployBundle({ connection, publicUrl: state.bridge.publicUrl, consoleUrl: running.consoleUrl });
    output.clear();
    output.appendLine(deployText(bundle));
    output.show(true);
    const copyMcp = "复制 MCP 配置";
    const copyHeader = "复制请求头";
    const copyPrompt = "复制提示词";
    const openBrowser = "在浏览器打开控制台";
    const choice = await vscode.window.showInformationMessage(
      bundle.ready ? "云端接入信息已生成，详见“Cursor 云端桥”输出面板。" : "已生成云端接入信息，但公网地址还没就绪：先在控制台配好隧道。详见输出面板。",
      copyMcp, copyHeader, copyPrompt, openBrowser,
    );
    if (choice === copyMcp) await vscode.env.clipboard.writeText(bundle.mcpConfig);
    else if (choice === copyHeader) await vscode.env.clipboard.writeText(bundle.headerValue);
    else if (choice === copyPrompt) await vscode.env.clipboard.writeText(bundle.prompt);
    else if (choice === openBrowser) await vscode.env.openExternal(vscode.Uri.parse(running.consoleUrl));
    return bundle;
  }

  async function setWorkspaceRoot() {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: "作为云端桥的工作区",
    });
    if (!picked?.length) return;
    const root = picked[0].fsPath;
    await vscode.workspace.getConfiguration(configSection).update("workspaceRoot", root, vscode.ConfigurationTarget?.Workspace ?? 2);
    await restart();
    void vscode.window.showInformationMessage(`云端桥工作区已设为 ${root}`);
  }

  async function setCommandPolicy() {
    const items = [
      { label: "每条都要我确认", value: "ask" },
      { label: "全部允许", value: "allow" },
      { label: "禁止执行命令", value: "deny" },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "命令执行策略" });
    if (!picked) return;
    await vscode.workspace.getConfiguration(configSection).update("commandPolicy", picked.value, vscode.ConfigurationTarget?.Workspace ?? 2);
    if (running) await consoleFetch("/api/policy", { method: "POST", body: JSON.stringify({ policy: picked.value }) });
  }

  async function regenerateToken() {
    const yes = "重新生成";
    const choice = await vscode.window.showWarningMessage(
      "重新生成访问令牌会让旧令牌立即失效，cursor.com 上的 MCP 配置要跟着改。继续？", { modal: true }, yes,
    );
    if (choice !== yes) return;
    const state = await bridgeApi.openState(stateDir);
    await bridgeApi.resolveToken(state, { renew: true });
    await restart();
    void vscode.window.showInformationMessage("已生成新的访问令牌。用“准备云端接入”复制新的 MCP 配置到 cursor.com。");
  }

  async function onConfigChange(event) {
    if (!event.affectsConfiguration?.(configSection)) return;
    const relevant = restartKeys.some((key) => event.affectsConfiguration(`${configSection}.${key}`));
    if (relevant && running) await restart();
    else if (event.affectsConfiguration(`${configSection}.commandPolicy`) && running) {
      await consoleFetch("/api/policy", { method: "POST", body: JSON.stringify({ policy: settings().commandPolicy }) }).catch(() => {});
    }
  }

  function guard(run) {
    return async (...args) => {
      try {
        return await run(...args);
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof OptionError ? error.message : `云端桥：${error?.message ?? error}`);
      }
    };
  }

  const commands = {
    openConsole, openConsoleInBrowser, prepareCloud, setWorkspaceRoot, setCommandPolicy, restart, stop, regenerateToken,
  };

  async function activate() {
    context.subscriptions.push(output, status, { dispose: () => { void stop(); } });
    for (const [name, run] of Object.entries(commands)) {
      context.subscriptions.push(vscode.commands.registerCommand(`${configSection}.${name}`, guard(run)));
    }
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(guard(onConfigChange)));
    setStatus("$(circle-slash) 云端桥已停", "点击打开控制台");
    if (settings().autoStart) await guard(start)();
  }

  return { activate, start, stop, restart, openConsole, openConsoleInBrowser, prepareCloud, setWorkspaceRoot, setCommandPolicy, regenerateToken, onConfigChange, refreshStatus, get running() { return running; }, get panel() { return panel; } };
}
