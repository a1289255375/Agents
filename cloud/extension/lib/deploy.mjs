// Builds the "prepare cloud access" bundle: the values a user copies into cursor.com/agents to let a
// Cloud Agent reach this machine, plus the one step that must be clicked there by hand. `connection`
// is exactly what the console's /api/connection returns. Kept pure so the text can be unit-tested.

export function deployBundle({ connection, publicUrl, consoleUrl } = {}) {
  if (!connection) throw new Error("缺少连接信息");
  const ready = Boolean(publicUrl) && connection.ready !== false;
  return {
    ready,
    serverName: connection.serverName,
    serverUrl: connection.url,
    headerName: "Authorization",
    headerValue: connection.authorization,
    mcpConfig: connection.config,
    prompt: connection.prompt,
    publicUrl: publicUrl ?? null,
    consoleUrl: consoleUrl ?? null,
  };
}

const divider = "────────────────────────────────────────";

// The plain-text form shown in the output channel. The manual cursor.com step is spelled out and
// never presented as already done.
export function deployText(bundle) {
  const lines = [
    "Cursor 云端一键部署",
    divider,
    bundle.ready
      ? `公网地址已就绪：${bundle.publicUrl}`
      : "公网地址还没就绪：先在控制台“连接配置”里填隧道地址，或把设置 cursorCloudBridge.tunnel 改成 cloudflared 让插件自动起隧道。下面的 URL 仍是模板，隧道通了会自动换成真实地址。",
    "",
    "这个环境能替你准备的（下面都可直接复制）：",
    `  • MCP 服务名称：${bundle.serverName}`,
    `  • MCP 服务 URL：${bundle.serverUrl}`,
    `  • 请求头：${bundle.headerName}: ${bundle.headerValue}`,
    "",
    "MCP 配置（需要粘贴 JSON 时用）：",
    bundle.mcpConfig,
    "",
    "发给 Cloud Agent 的提示词（作为第一条消息）：",
    bundle.prompt,
    "",
    "必须由你在 cursor.com 手动完成的一步（这个环境点不了，没有替你点）：",
    "  1. 打开 cursor.com/agents，在 MCP 下拉菜单里“添加自定义 MCP 服务”，类型选 HTTP，",
    "     填入上面的名称、URL 和请求头（或粘贴上面的 JSON），然后启用它。",
    "  2. 新建一个 Cloud Agent（用哪个仓库都行，也可 Start from scratch），确认该 MCP 已启用，",
    "     把上面的提示词作为第一条消息发给它。",
    "  3. 几秒后本插件控制台左侧会出现一个“等待网页消息”的会话，就可以下指令了。",
    divider,
  ];
  if (bundle.consoleUrl) lines.push(`控制台：${bundle.consoleUrl}`);
  return lines.join("\n");
}
