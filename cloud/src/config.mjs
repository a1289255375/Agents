// Command line options, and the state kept outside the repository (access token, last root, public address).
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import { newToken } from "./auth.mjs";
import { encodingOfCodePage, legacyEncodings } from "./project/text.mjs";

export class ConfigError extends Error {}

export const usage = `用法：node cloud/src/main.mjs [项目根目录] [选项]
      start-cloud.cmd [项目根目录] [选项]

不写项目根目录时会在启动后询问。

选项：
  --port <端口>               网页控制台端口，只监听 127.0.0.1（默认 3220）
  --mcp-port <端口>           MCP 端点端口，交给隧道的只有它（默认 3221）
  --mcp-host <地址>           MCP 端点监听地址（默认 127.0.0.1；隧道客户端不在本机时才需要改）
  --public-url <地址>         隧道的公网地址，例如 https://bridge.example.com（会记住，下次不用再写）
  --tunnel cloudflared        启动时顺带运行 cloudflared 快速隧道（需要已安装 cloudflared）
  --command-policy <策略>     命令执行策略：ask 每条命令在网页上确认（默认）、allow 全部允许、deny 禁止
  --wait-seconds <秒>         单次 MCP 工具调用最长挂起多久（默认 50）
  --shell-wait-seconds <秒>   Shell 等待（curl 长轮询）单次最长多久，0 表示关闭（默认 1800）
  --legacy-encoding <编码>    非 UTF-8 的文件和命令输出按什么编码处理（默认取系统代码页，中文 Windows 是 gbk）
  --state-dir <目录>          保存访问令牌等状态的目录（默认 ~/.cursor-cloud-bridge）
  --new-token                 重新生成访问令牌（旧令牌立即失效，云端配置要跟着改）
  --open                      启动后自动打开网页控制台
  --help                      显示这段说明

环境变量：
  CLOUD_BRIDGE_TOKEN          指定访问令牌（至少 24 个字符）；不设置则自动生成并保存在状态目录`;

const port = z.coerce.number().int().min(0).max(65535);
const optionsSchema = z.object({
  root: z.string().optional(),
  port: port.default(3220),
  "mcp-port": port.default(3221),
  "mcp-host": z.string().min(1).default("127.0.0.1"),
  "public-url": z.string().optional(),
  tunnel: z.enum(["cloudflared"]).optional(),
  "command-policy": z.enum(["ask", "allow", "deny"]).default("ask"),
  "wait-seconds": z.coerce.number().int().min(5).max(3600).default(50),
  "shell-wait-seconds": z.coerce.number().int().min(0).max(86_400).default(1800),
  "legacy-encoding": z.enum(legacyEncodings).optional(),
  "state-dir": z.string().min(1).optional(),
  "new-token": z.boolean().default(false),
  open: z.boolean().default(false),
  help: z.boolean().default(false),
});
const flags = new Set(["new-token", "open", "help"]);
const stateSchema = z.object({
  token: z.string().min(24).optional(),
  lastRoot: z.string().optional(),
  publicUrl: z.string().optional(),
});

// Explorer's "Copy as path" adds quotes, and "D:\dir\" on a command line arrives as D:\dir" .
export const cleanRoot = (input) => input.trim().replace(/^"|"$/g, "");

// Accepts what people paste: with or without a trailing slash or the /mcp path.
export function normalizePublicUrl(input) {
  let url;
  try {
    url = new URL(input.trim());
  } catch {}
  if (url?.protocol !== "https:" && url?.protocol !== "http:") {
    throw new ConfigError(`公网地址应是 https:// 开头的完整网址，收到的是：${input}`);
  }
  return url.origin + url.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "");
}

export function parseOptions(argv, platform = process.platform) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: Object.fromEntries(Object.keys(optionsSchema.shape).map((name) => [name, { type: flags.has(name) ? "boolean" : "string" }])),
    });
  } catch (error) {
    throw new ConfigError(`参数错误：${error.message}`);
  }
  const { values, positionals } = parsed;
  if (positionals.length > 1 || (positionals.length && values.root !== undefined)) {
    throw new ConfigError(`只能指定一个项目根目录，收到了多个：${[values.root, ...positionals].filter(Boolean).join("  |  ")}。路径含空格时请加引号`);
  }
  const result = optionsSchema.safeParse({ ...values, root: values.root ?? positionals[0] });
  if (!result.success) {
    const name = result.error.issues[0].path[0];
    throw new ConfigError(`选项 --${name} 的值无效：${values[name]}`);
  }
  const options = result.data;
  const root = options.root && cleanRoot(options.root);
  // "D:\my project\" --port 1 reaches a Windows program as one argument: D:\my project" --port 1
  if (platform === "win32" && root?.includes('"')) {
    throw new ConfigError(`项目根目录里混进了引号和后面的参数：${root}\n带引号的路径不要以 \\ 结尾，例如把 "D:\\my project\\" 写成 "D:\\my project"`);
  }
  return {
    help: options.help,
    root,
    port: options.port,
    mcpPort: options["mcp-port"],
    mcpHost: options["mcp-host"],
    publicUrl: options["public-url"] && normalizePublicUrl(options["public-url"]),
    tunnel: options.tunnel,
    policy: options["command-policy"],
    waitMs: options["wait-seconds"] * 1000,
    shellWaitMs: options["shell-wait-seconds"] * 1000,
    legacyEncoding: options["legacy-encoding"],
    stateDir: options["state-dir"] ?? nodePath.join(os.homedir(), ".cursor-cloud-bridge"),
    newToken: options["new-token"],
    open: options.open,
  };
}

// The token lives in the user's profile, never in the repository or on the command line.
export async function openState(stateDir) {
  const file = nodePath.join(stateDir, "config.json");
  let state = {};
  try {
    state = stateSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw new ConfigError(`状态文件 ${file} 无法读取或已损坏（${error.message}）。删除它后重新启动会生成新的访问令牌`);
  }
  return {
    file,
    get: () => state,
    async save(patch) {
      state = { ...state, ...patch };
      await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    },
  };
}

export async function resolveToken(state, { env = process.env, renew = false } = {}) {
  const fromEnv = env.CLOUD_BRIDGE_TOKEN;
  if (fromEnv !== undefined) {
    if (fromEnv.length < 24) throw new ConfigError("环境变量 CLOUD_BRIDGE_TOKEN 太短，至少需要 24 个字符；删除这个环境变量即可改用自动生成的令牌");
    return { token: fromEnv, source: "env" };
  }
  if (state.get().token && !renew) return { token: state.get().token, source: "saved" };
  const token = newToken();
  await state.save({ token });
  return { token, source: "new" };
}

// Files and console output on Windows may use the system code pages: ACP for files, OEMCP for consoles.
export async function detectEncodings(platform = process.platform) {
  let ansi;
  let oem;
  if (platform === "win32") {
    try {
      const { stdout } = await promisify(execFile)("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage"], { windowsHide: true });
      const labelOf = (name) => encodingOfCodePage(Number(new RegExp(`\\b${name}\\s+REG_SZ\\s+(\\d+)`).exec(stdout)?.[1]));
      ansi = labelOf("ACP");
      oem = labelOf("OEMCP");
    } catch {}
  }
  // No usable code page (UTF-8 system locale, not Windows): GBK is the likeliest encoding of a stray legacy file here.
  const legacyEncoding = ansi ?? "gbk";
  return { legacyEncoding, consoleEncoding: oem ?? legacyEncoding };
}
