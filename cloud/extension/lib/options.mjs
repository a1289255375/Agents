// Turns the extension's settings and the open workspace into the arguments startBridge expects.
// Kept free of the vscode API so the mapping can be unit-tested on its own.

export class OptionError extends Error {}

const trim = (value) => (typeof value === "string" ? value.trim() : "");

// The project root the cloud agent may touch: the explicit setting wins, otherwise the first
// workspace folder. Returning undefined means the user has to pick one before the bridge can start.
export function resolveRoot({ configuredRoot, workspaceFolders = [] } = {}) {
  const configured = trim(configuredRoot);
  if (configured) return configured;
  const folder = workspaceFolders.find((path) => trim(path));
  return folder ? trim(folder) : undefined;
}

function port(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 65535) throw new OptionError(`${name} 必须是 0 到 65535 之间的端口号`);
  return number;
}

function seconds(value, fallback, min, max, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new OptionError(`${name} 必须是 ${min} 到 ${max} 之间的秒数`);
  return number;
}

// startBridge arguments assembled from settings, the resolved root, the token and the detected
// encodings. Throws OptionError on a setting the user got wrong, so the caller can show it as-is.
// A relay server address is the public address, so filling it alone switches on relay mode; the
// explicit cloudflared tunnel still wins. normalizeRelayUrl is injected (the real one lives in the
// bridge's config.mjs, which this file stays decoupled from) so a bare host can default to https.
export function bridgeParams({ root, token, settings = {}, encodings = {}, savedPublicUrl, normalizeRelayUrl = (value) => value }) {
  if (!trim(root)) throw new OptionError("还没有设置工作区目录");
  if (!token) throw new OptionError("缺少访问令牌");
  const policy = settings.commandPolicy ?? "ask";
  if (!["ask", "allow", "deny"].includes(policy)) throw new OptionError(`命令执行策略必须是 ask、allow 或 deny，收到：${policy}`);
  const relaySet = trim(settings.relayUrl);
  const useRelay = settings.tunnel === "relay" || (settings.tunnel !== "cloudflared" && Boolean(relaySet));
  if (useRelay && !relaySet) throw new OptionError("中继模式需要在设置 cursorCloudBridge.relayUrl 里填写公网服务器地址");
  const relayUrl = useRelay ? normalizeRelayUrl(relaySet) : undefined;
  const tunnel = useRelay ? undefined : settings.tunnel === "cloudflared" ? "cloudflared" : undefined;
  const publicUrl = useRelay || tunnel ? undefined : trim(settings.publicUrl) || trim(savedPublicUrl) || undefined;
  return {
    root: trim(root),
    token,
    port: port(settings.consolePort, 3220, "网页控制台端口"),
    mcpPort: port(settings.mcpPort, 3221, "MCP 端点端口"),
    policy,
    waitMs: seconds(settings.waitSeconds, 50, 5, 3600, "单次等待秒数") * 1000,
    shellWaitMs: seconds(settings.shellWaitSeconds, 1200, 0, 86_400, "Shell 等待秒数") * 1000,
    legacyEncoding: encodings.legacyEncoding ?? "gbk",
    consoleEncoding: encodings.consoleEncoding ?? encodings.legacyEncoding ?? "gbk",
    publicUrl,
    tunnel,
    relayUrl,
  };
}

// The settings that force the bridge to restart when they change. The policy is applied live through
// the console API instead, so it is left off this list.
export const restartKeys = [
  "workspaceRoot", "consolePort", "mcpPort", "publicUrl", "tunnel", "relayUrl", "waitSeconds", "shellWaitSeconds",
];
