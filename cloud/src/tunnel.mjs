// Optional convenience: runs a cloudflared quick tunnel for the MCP port and reports the address it gets.
import { spawn } from "node:child_process";

// api.trycloudflare.com shows up in cloudflared's error messages and is not a tunnel address.
const quickTunnelUrl = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;

export function startCloudflared({ port, onUrl, onExit }) {
  const child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let log = "";
  let found = false;
  let ended = false;
  const read = (chunk) => {
    log = (log + chunk).slice(-4000);
    const url = !found && quickTunnelUrl.exec(log)?.[0];
    if (!url) return;
    found = true;
    onUrl(url);
  };
  const end = (reason) => {
    if (ended) return;
    ended = true;
    onExit(reason);
  };
  for (const stream of [child.stdout, child.stderr]) stream.setEncoding("utf8").on("data", read);
  child.once("error", (error) => end(error.code === "ENOENT"
    ? "没有找到 cloudflared。请先安装（winget install --id Cloudflare.cloudflared），或自行启动隧道后用 --public-url 填写地址"
    : `cloudflared 启动失败：${error.message}`));
  child.once("exit", (code) => end(`cloudflared 已退出（退出码 ${code}）。最后的输出：\n${log.trim().split("\n").slice(-5).join("\n")}`));
  return () => {
    ended = true;
    child.kill();
  };
}
