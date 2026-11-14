# Cursor 云端桥

在自己的 Windows 电脑上打开一个网页，给云端的 Cursor Cloud Agent 下指令；Cloud Agent 通过 MCP 直接读写、搜索你本地项目里的文件，在你的电脑上执行命令；回复之后继续挂起，等你的下一条指令。

它和仓库根目录的本地方案（`start-web.cmd`，驱动本机的 Cursor Desktop）互不影响，可以同时运行。两者的关系见[和本地方案的关系](#和本地方案的关系)。

## 一条指令怎么走

```text
  Cloud Agent（云端）
      │  MCP 工具调用由 Cursor 后端发出
      ▼
  隧道的公网 HTTPS 地址
      │
══════╪══════════════════════════  以下都在你的 Windows 电脑上
      ▼
  MCP 端点  127.0.0.1:3221（每个请求都要带访问令牌）
      │
  云端桥  node cloud/src/main.mjs  ──►  你指定的项目根目录（读写文件、执行命令）
      │
  网页和控制接口  127.0.0.1:3220（只监听本机，隧道不指向它）
      ▲
      │
  浏览器  http://127.0.0.1:3220/
```

1. Cloud Agent 调用 `connect_session` 接入，网页左侧出现一个会话；随后它挂起等待。
2. 你在网页上输入指令。云端桥把它交给正在挂起的那次等待，Cloud Agent 收到 `event=message`。
3. Cloud Agent 调用项目工具（`read_file`、`edit_file`、`run_command` 等）。每次调用经隧道到达你的电脑，在项目根目录里执行，网页上实时显示它做了什么。命令默认要你在网页上点“允许一次”才会执行。
4. Cloud Agent 调用 `reply_message`，回复显示在网页上；它接着再次挂起等待。

多个 Cloud Agent 可以同时接入，各占一个会话，网页上分别下指令。

## 需要准备什么

- Windows 10 或 11，Node.js 22 或更新版本。
- 一个能运行 Cloud Agent 的 Cursor 账号。[官方文档](https://cursor.com/docs/cloud-agent)写的是 Premium 及以上、Teams、Enterprise 或旧版付费方案，Free 和 Plus 不含 Cloud Agent。
- 一条能把本机端口暴露成公网 HTTPS 地址的隧道。怎么选见[隧道怎么选](#隧道怎么选)。
- 建议安装 Git for Windows：项目是 git 仓库时，搜索会遵守 `.gitignore`。

## 作为 IDE 插件使用（推荐）

把云端桥打包成 Cursor / VS Code 插件（`.vsix`）装进 IDE。IDE 启动后插件自动在本机把云端桥跑起来，无需再双击 `start-cloud.cmd`（它仍保留为备用，见[从零开始](#从零开始)）。插件在扩展宿主进程里直接运行 `cloud/src` 的同一套代码，把本机能力通过 MCP 暴露给 Cloud Agent，并在 IDE 面板里给云端子代理下指令、看思考过程。插件源码在 [`extension/`](extension/)。

### 1. 打包 vsix

```bash
node cloud/extension/build.mjs                       # 生成 cloud/extension/cursor-cloud-bridge-<版本>.vsix
node cloud/extension/build.mjs --out D:\tmp\ccb.vsix  # 指定输出路径
```

构建脚本把 `cloud/src`、`cloud/web`、`cloud/prompt.md` 复制到插件目录，安装运行时依赖（`@modelcontextprotocol/sdk`、`zod`），再用 `npx @vscode/vsce` 打包。`@vscode/vsce` 只在打包时用，不是插件的运行时依赖。

### 2. 安装 vsix

在 Cursor / VS Code 命令面板运行 **Extensions: Install from VSIX…**，选择 `.vsix`；或命令行 `cursor --install-extension <file>.vsix`（VS Code 为 `code --install-extension`）。装完重载窗口。

### 3. 打开界面、设置工作区

- 命令面板搜“Cursor 云端桥”，运行 **打开控制台**。面板内嵌的就是下文的[网页控制台](#网页控制台)：会话列表、思考、进展、文件差异、命令确认都在里面。面板空白时用 **在浏览器中打开控制台**。
- 工作区（交给 Cloud Agent 的项目根目录）默认取当前 IDE 工作区的第一个文件夹，可用设置 `cursorCloudBridge.workspaceRoot` 或命令 **设置工作区目录** 改成任意文件夹。Cloud Agent 的文件读写被限制在这个目录内，挡住路径穿越。改工作区会用新根目录重启云端桥。

### 4. 一键准备云端接入

运行命令 **准备云端接入（一键）**。插件会确保云端桥在跑（设置 `cursorCloudBridge.tunnel` 为 `cloudflared` 时顺带起一条快速隧道），把下面这些可复制的值写进“Cursor 云端桥”输出面板，并在弹窗里提供“复制 MCP 配置 / 复制请求头 / 复制提示词”：

- MCP 服务名称、URL、请求头 `Authorization: Bearer <令牌>`，以及完整 JSON 配置；
- 发给 Cloud Agent 的提示词（把挂起循环写死的中文模板）。

**必须由你在 cursor.com 手动完成、这个环境替你做不了的一步**：打开 [cursor.com/agents](https://cursor.com/agents) 的 MCP 下拉菜单，添加一个 HTTP 自定义 MCP 服务（填上面的名称、URL、请求头，或粘贴 JSON）并启用；再新建 Cloud Agent，把提示词作为第一条消息发给它。插件不会假装替你点过这一步，输出面板里会明确写出来。

### 5. 一次起多个 Cloud Agent，看思考过程

在 cursor.com/agents 对每个新建的 Cloud Agent 都发同一份提示词即可；一个插件可同时接住约十个云端会话，左侧列表并列显示，各自独立下指令。选中某个会话，对话区会按时间显示它的思考、`report_progress` 进展、读写了哪些文件（带差异）、执行了什么命令和输出、以及 `reply_message` 的回复。

**思考从哪里来**：就是 cursor.com/agents 聊天界面上能看到的那份思考，云端桥从 Cursor 的 [Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints) 读取（`GET /v1/agents/{id}/stream` 里的 `thinking` 事件），子代理不需要、也不会为此多写什么。要让它出现，需要两样东西：

- 在本机给云端桥设置环境变量 `CURSOR_API_KEY`（在 Cursor 控制台 → API Keys 生成），设好后重启 IDE 或 `start-cloud.cmd`。没设置时桥照常工作，只是不显示思考，输出里会提示一次。这个变量不会传给子代理在本机执行的命令。
- 子代理在 `connect_session` 里传入 `agent` 参数。提示词让它先读自己环境里现成的 `CURSOR_CONVERSATION_ID`（就是这个 Cloud Agent 的 id，`bc-…`），再把值传进来，桥据此订阅它的思考。没传（读不到这个变量）时桥不知道它是哪个 Cloud Agent，只是不显示思考，其他功能照常。桥重启后子代理只用原 id 调 `wait_message` 接回来时也不会带上 `agent`，要等它再调一次 `connect_session` 思考才会恢复。

API key 读不到这个 Agent（密钥错、Agent 属于别的账号或已归档）时，会话里会出现一条说明和 Cursor 返回的 HTTP 状态。思考的有无和多少取决于模型本身是否输出可见思考。

### 插件设置项（`cursorCloudBridge.*`）

| 设置 | 作用 |
| --- | --- |
| `workspaceRoot` | 工作区根目录，留空用当前工作区第一个文件夹 |
| `commandPolicy` | 命令执行策略：`ask`（默认，逐条确认）、`allow`、`deny`。运行中也可用命令或控制台切换 |
| `consolePort` / `mcpPort` | 控制台（默认 3220）和 MCP 端点（默认 3221）端口 |
| `publicUrl` | 隧道公网地址；`tunnel` 为 `cloudflared` 或填了 `relayUrl` 时忽略 |
| `relayUrl` | 自建公网中继的地址，例如 `https://1.2.3.4` 或 `1.2.3.4`（默认按 https）。填了就自动进入中继模式，见[自建公网中继](#自建公网中继可选不经第三方隧道) |
| `tunnel` | `none`、`cloudflared`（启动时顺带起快速隧道）或 `relay`（连 `relayUrl` 的中继；只填 `relayUrl` 也会自动进入） |
| `waitSeconds` | 单次等待的上限秒数 |
| `autoStart` | IDE 启动后是否自动运行云端桥 |

### 插件验证到哪一步

- 在本仓库的 Linux 开发机上：用插件的控制器代码（`extension/lib/controller.mjs`）在固定端口起桥，十个 MCP 客户端扮演子代理并列接入，走通“下指令 → 读文件 → 改文件（差异）→ 请求执行命令 → 逐条确认 → 命令输出 → 回复 → 再次挂起”整条循环，并在 Chrome 里截图录屏；把打包好的 `.vsix` 解压后，用它自带的 `extension.js` 在打包布局下成功起桥、读到 `web/` 与 `prompt.md` 资产。
- 没有在真实 Windows 的 Cursor / VS Code 里装过这个 vsix、也没在 IDE 的 webview 面板里实测内嵌 iframe（本环境没有带界面的 IDE）。内嵌面板依赖桌面版 IDE 的 `asExternalUri` 把本机端口暴露给 webview；万一面板空白，用 **在浏览器中打开控制台** 一定可用。

## 从零开始

### 1. 安装 Node.js，取得本仓库

```powershell
winget install OpenJS.NodeJS.LTS
git clone https://github.com/a1289255375/Agents.git
cd Agents
```

没有 git 也可以在 GitHub 页面下载 ZIP 后解压。装完 Node.js 要新开一个终端窗口。

### 2. 启动

在仓库目录里运行，把路径换成你要交给 Cloud Agent 的项目文件夹：

```powershell
.\start-cloud.cmd "D:\work\my-project"
```

也可以直接双击 `start-cloud.cmd`，在窗口里输入项目路径后回车（下次直接回车沿用上次的路径）。第一次启动会自动安装依赖，然后用默认浏览器打开网页控制台 `http://127.0.0.1:3220/`。

窗口里会显示项目根目录、两个端口和命令策略。这个窗口要一直开着，按 Ctrl+C 停止。

带引号的路径不要以 `\` 结尾：`"D:\my project\"` 在 Windows 命令行里会把后面的引号吃掉，写成 `"D:\my project"`。

### 3. 开隧道

隧道只指向 MCP 端口 `3221`，不要指向网页所在的 `3220`。

想先试通，最快的是 cloudflared 的快速隧道，不用注册。在第 2 步的窗口里按 Ctrl+C 停掉服务，安装 cloudflared 后带上 `--tunnel cloudflared` 重新启动：

```powershell
winget install --id Cloudflare.cloudflared
.\start-cloud.cmd "D:\work\my-project" --tunnel cloudflared
```

刚装完 cloudflared 时要新开一个终端窗口，它才找得到这个命令。启动窗口和网页的“连接配置”里会出现形如 `https://xxxx.trycloudflare.com` 的地址。这个地址每次启动都会变，变了就要回到 cursor.com 改一次 MCP 配置，所以长期使用请换成地址固定的隧道。

用别的隧道时，自己把隧道指向 `http://127.0.0.1:3221`，再把得到的公网地址填进网页“连接配置”的第 1 步，点“保存并自检”。地址会记住，下次启动不用再填；也可以用 `--public-url https://你的地址` 在启动时给出。

### 4. 在 cursor.com/agents 添加 MCP 服务

打开网页控制台左上角的“连接配置”，第 2 步列出了要填的四项，每项都有“复制”按钮：

| 项 | 值 |
| --- | --- |
| 类型 | HTTP |
| 名称 | `cursor-cloud-bridge` |
| URL | `https://你的隧道地址/mcp` |
| 请求头 | `Authorization`，值为 `Bearer 你的访问令牌` |

在 [cursor.com/agents](https://cursor.com/agents) 的 MCP 下拉菜单里添加一个自定义 MCP 服务，把这四项填进去并启用。如果那里要求粘贴 JSON，用“连接配置”里的 JSON 配置。页面上令牌默认用圆点遮住，“复制”按钮复制的是带真实令牌的完整内容：

```json
{
  "mcpServers": {
    "cursor-cloud-bridge": {
      "url": "https://你的隧道地址/mcp",
      "headers": { "Authorization": "Bearer 你的访问令牌" }
    }
  }
}
```

访问令牌等同于这台电脑的钥匙：只填进 Cursor 的 MCP 配置，不要提交到仓库，不要发给别人。

### 5. 启动 Cloud Agent，发提示词

在 cursor.com/agents 新建一个 Cloud Agent。它用哪个仓库都可以（官方也提供不带仓库的 Start from scratch），因为真正要改的是你本地的项目。确认 MCP 下拉里 `cursor-cloud-bridge` 已启用，然后把“连接配置”第 3 步的提示词作为第一条消息发给它。提示词的原文在 [`prompt.md`](prompt.md)。

### 6. 下第一条指令

几秒后，网页左侧出现一个会话，状态是“等待网页消息”。选中它，在底部输入指令，按 Ctrl+Enter 发送，例如：

```text
看一下这个项目的目录结构，告诉我入口文件是哪个。
```

Cloud Agent 的每次文件操作和命令都会出现在对话里。它要执行命令时，页面顶部会弹出确认卡片，点“允许一次”“始终允许这条命令”或“拒绝”。它回复之后状态回到“等待网页消息”，可以继续下指令。

## 网页控制台

- **左侧会话列表**：每个接入的 Cloud Agent 一个会话。状态含义：

  | 状态 | 含义 |
  | --- | --- |
  | 等待网页消息 | 它正挂起等你的指令 |
  | 处理中 | 已收到指令，还没回复 |
  | 已接入 | 刚有过调用，但此刻不在等待 |
  | 未在等待 | 已有一阵没有任何调用，它那一轮多半已经结束 |
  | 已断开 | 你或它结束了这个会话 |

- **对话区**：你的指令、它的进展（`report_progress`）和回复，以及它在你电脑上做的每一步：读了哪个文件、改了哪几行（带差异）、执行了什么命令和输出。还没回复的指令旁标着“排队中，等云端领取”或“已送达，处理中”。
- **命令确认**：命令策略是“每条都要我确认”时，待确认和运行中的命令固定显示在页面顶部，运行中的命令可以随时“终止”。
- **连接配置**：公网地址和自检、云端要填的 MCP 配置、提示词。
- **左下角**：项目根目录、公网地址状态、命令策略（可随时切换，立即生效）。
- “断开”会让那个 Cloud Agent 停止等待；“删除会话”再把它从列表里移除。

会话在“未在等待”时发出的指令会排队，等它再次等待时送达。让它回来的办法：到 cursor.com/agents 对那个 Agent 说“继续等待网页消息”，或者重新发一次提示词。

## 隧道怎么选

要求只有三条：公网上是 HTTPS 地址；能把请求原样转到 `http://127.0.0.1:3221`；单个请求至少能保持 60 秒不被切断。发起调用的是 Cursor 的后端，它在海外，所以隧道的公网入口要能从海外访问，而你的电脑要能稳定连上隧道服务商的中转节点。

| 方案 | 地址是否固定 | 说明 |
| --- | --- | --- |
| cloudflared 快速隧道 | 每次启动都变 | 不用注册，`--tunnel cloudflared` 一步完成。适合试用 |
| cloudflared 命名隧道 | 固定（自己的域名） | 需要 Cloudflare 账号和一个托管在 Cloudflare 的域名，免费 |
| ngrok | 固定（免费账号有一个固定域名） | 需要注册 |
| Tailscale Funnel | 固定（`机器名.tailnet 名.ts.net`） | 需要 Tailscale 账号并开启 Funnel |
| frp + 自己的云服务器 | 固定（自己的域名或 IP） | 中转节点自己掌握，线路可以自己挑；需要在服务器上配置 HTTPS |
| cpolar、natapp、花生壳、SakuraFrp 等国内内网穿透服务 | 固定地址通常要付费 | 中转节点在国内，本机连接稳定；要选能给 HTTPS 地址、并且海外能访问的线路 |

在中国大陆的网络下：到 Cloudflare、ngrok、Tailscale 中转节点的连接可能不稳定或被干扰，哪一种可用取决于你的网络，只能自己试。思路上最稳妥的是 frp 配一台你的电脑和海外都能顺畅访问的云服务器（例如香港、新加坡、日本的节点），或者选一家国内内网穿透服务里海外可达的线路。判断标准很简单：在网页“连接配置”里点“保存并自检”能通过，并且 Cloud Agent 能接入。这张表里只有 cloudflared 快速隧道实际测试过，而且是在海外的 Linux 机器上；其余方案和大陆网络下的表现都没有验证。

常见写法（以各家官方文档为准）：

```powershell
# cloudflared 命名隧道（地址固定）
cloudflared tunnel login
cloudflared tunnel create cursor-bridge
cloudflared tunnel route dns cursor-bridge bridge.example.com
cloudflared tunnel run --url http://127.0.0.1:3221 cursor-bridge

# ngrok（把地址换成你账号里的固定域名）
ngrok http 3221 --url https://你的固定域名

# Tailscale Funnel
tailscale funnel 3221
```

frp 的做法是在云服务器上运行 `frps`，本机运行 `frpc` 把 `127.0.0.1:3221` 映射出去，再在服务器上用 Caddy 或 nginx 加一层 HTTPS。反向代理要把读超时设到 120 秒以上，否则等待请求会被提前切断。

快速隧道的地址变了以后：把新地址更新到 cursor.com 的 MCP 配置里，再让 Cloud Agent 重新接入。正在运行的 Cloud Agent 会不会自动用上新地址没有确认过，稳妥的做法是新开一个 Agent。

## 自建公网中继（可选，不经第三方隧道）

有一台带公网 IP 的 Linux 服务器时，可以不用 Cloudflare 等第三方隧道，改用仓库自带的中继：插件主动从你的电脑连到你服务器上的中继，Cursor 后端把 MCP 请求发到中继，中继再经这条已经建立的连接转回你的电脑。你家里/公司网络**不用开任何入站端口**。

```text
  Cloud Agent（Cursor 后端）
      │  https://<服务器IP>:<端口>/mcp
      ▼
  你的公网服务器：中继（cloud/relay，Node 22，无第三方依赖）
      ▲  插件主动发起的出站长连接（HTTP Upgrade + 帧多路复用）
══════╪══════════════════════════  以下都在你的 Windows 电脑上
      ▼
  MCP 端点 127.0.0.1:3221  ◄─  云端桥（插件）
```

### 为什么是这个形状

- **无第三方依赖的 Node 中继**：中继只用 Node 22 内置能力（`http`/`https`、`crypto`），不装任何 npm 包，部署和审计都简单。它只在 Cursor 和插件之间转发字节，不执行命令、不落盘。代码在 [`relay/`](relay/)。
- **插件出站、家里不开端口**：插件用 HTTP Upgrade 向中继发起一条出站长连接，中继在这条连接上用一个很小的帧协议（`[流号][类型][长度][负载]`）多路复用并发请求。这样 Cursor 的每个请求都能即时逐块转发——SSE 和约 50 秒的 `wait_message` 长轮询都不会被缓冲到结束才发。
- **按令牌哈希路由**：插件注册时只上报 `sha256(令牌)`，中继只在内存里记这个哈希，从不接触令牌本身，也不记录令牌。Cursor 请求带的 `Authorization: Bearer 令牌`，中继按 `sha256(令牌)` 找到对应插件转发；对不上任何已连接插件就回 401；到了你电脑上，本地桥仍然照常校验令牌。
- **自动重连**：中继重启或网络抖动把连接断了，插件会自己退避重连接回去，`wait_message` 的消息在重连期间不会丢。
- **选 HTTP Upgrade 帧多路复用而不是 WebSocket**：Node 22 有内置 WebSocket 客户端但没有内置 WebSocket 服务端，自己实现中继端的多路复用比手搓 WebSocket 握手/分片更少代码、更可控。

### 证书与明文的取舍（重要）

理想情况是中继用受信任的 HTTPS 证书，令牌和流量全程加密。但在中国大陆的云服务器上实测发现：**入站 80、443、8080、8443 常被运营商按 ICP 备案策略封掉**（在服务器上监听、从外部访问全部超时），而其它高位端口畅通。这带来一个硬限制：

- Let's Encrypt 给**裸 IP** 签证书只支持 HTTP-01（走 80 端口）和 TLS-ALPN-01（走 443 端口），裸 IP 不支持 DNS-01。80 和 443 都被封 ⇒ **拿不到任何受信任证书**。sslip.io 这类“把 IP 变域名”的办法也一样：HTTP-01 仍要 80 端口，DNS-01 又改不了它的 DNS 记录。自签证书则会被 Cursor 后端拒绝（没法让 Cursor 跳过证书校验）。

所以 80/443 被封时只能退到**高位端口的明文 HTTP**（`deploy.sh --insecure-http`）。代价和缓解：

- **风险**：Cursor 后端到中继这一段是明文，`Authorization` 里的令牌和全部 MCP 流量（文件内容、命令输出）在公网上不加密传输，跨境链路上可能被旁路截获。插件到中继那一段只传令牌哈希，不传令牌本身。
- **缓解**：令牌是 256 位随机数；命令策略默认 `ask`（每条命令要你在网页确认）；不用时停掉；令牌一旦可能泄露，用“重新生成访问令牌”换一个。
- **要全程加密，两条升级路**：① 给服务器完成 ICP 备案、放开 80/443，再用 `deploy.sh`（默认 TLS 模式）申请裸 IP 证书；② 你有域名并能改它的 DNS：用 DNS-01（不需要入站 80/443）签 `relay.你的域名` 的证书，把 A 记录指到服务器 IP，中继在高位端口上用这张证书起 HTTPS——证书按域名校验，端口不影响信任。

### 怎么部署（服务器端）

`deploy.sh` 是可重复执行的幂等脚本：自己装 Node 22、装中继代码、建 systemd 服务（以非 root 的 `cursor-relay` 用户运行，用 `CAP_NET_BIND_SERVICE` 绑低端口）。TLS 模式还会用 [lego](https://github.com/go-acme/lego) 申请裸 IP 证书并装一个每日续期的 systemd 定时器。

把 `cloud/src` 和 `cloud/relay` 放到服务器上（结构保持 `cloud/src`、`cloud/relay` 两个目录），用 root 运行（`<服务器IP>` 换成你的公网 IP）：

```bash
# 80/443 可用（已备案）：TLS，中继监听 443
./deploy.sh --ip <服务器IP> --email you@example.com

# 80/443 被封：明文 HTTP，中继监听一个高位端口（例如 18443）
./deploy.sh --ip <服务器IP> --insecure-http --port 18443
```

脚本跑完会打印健康检查命令和要在插件里填的地址。它改动的系统项只有：`/opt/cursor-bridge-relay`（代码和 Node）、`/etc/cursor-bridge-relay`（配置，TLS 模式下还有证书）、`cursor-relay` 系统用户、systemd 单元 `cursor-bridge-relay.service`（TLS 模式另有 `*-renew.service/.timer`）。**回滚**：`systemctl disable --now cursor-bridge-relay`（TLS 再加 `cursor-bridge-relay-renew.timer`），删掉这些单元、`/opt/cursor-bridge-relay`、`/etc/cursor-bridge-relay` 和 `cursor-relay` 用户即可。中继服务器无法从外网下二进制时，可在能联网的机器下好后用 `NODE_TARBALL=... LEGO_TARBALL=... ./deploy.sh ...` 传入。

### 怎么用（插件 / 命令行）

- **插件**：在设置 `cursorCloudBridge.relayUrl` 里填服务器地址即可——**只填这一项**就自动进入中继模式。TLS 模式填 `https://<服务器IP>`（或直接 `<服务器IP>`，默认按 https）；明文高位端口模式填 `http://<服务器IP>:18443`。再运行“准备云端接入”，给出的 MCP URL 就是这个地址加 `/mcp`。
- **命令行 / `start-cloud.cmd`**：加 `--relay`：
  ```powershell
  .\start-cloud.cmd "D:\work\my-project" --relay http://<服务器IP>:18443
  ```
- cursor.com 上 MCP 配置的 URL 用 `http(s)://<服务器IP>:<端口>/mcp`，请求头仍是 `Authorization: Bearer 你的令牌`。中继在插件断线时会自动重连，服务器上的中继进程一直在跑，无需你干预。

## 挂起等待是怎么保持的

MCP 客户端、Cursor 后端和隧道都会切断挂得太久的请求，所以“一直挂起”是由一连串短等待接起来的：等待只用 `wait_message`（MCP 工具），一次最长 50 秒，没有消息就返回 `event=idle`。工具返回里只有数据，什么时候再等、收到消息后做什么，全写在提示词里（[`prompt.md`](prompt.md)）：`connect_session` 之后调用 `wait_message`；`event=message` 做完用 `reply_message` 回复，再调用 `wait_message`；`event=idle` 再调用 `wait_message`；`event=disconnected` 或你明确说结束时调用 `disconnect_session`。每次等待返回都要消耗一次模型调用，空闲一小时大约 72 次。

服务运行期间消息不会丢：一条指令在 Cloud Agent 调用 `reply_message` 之前一直留在队列里。等待的响应如果在路上丢了（超时、隧道重启），下一次等待会再次收到它，并带着 `redelivered: true`；提示词让它在已经处理过时只补发结果。服务重启后，只要公网地址没变，Cloud Agent 带着原来的会话 id 继续等待就能自动接回来，但重启前的对话记录和还没回复的指令不保留。

可以调的参数：

- `--wait-seconds`：一次等待请求的最长时间，默认 50。如果网页上提示“上一次 wait_message 在第 N 秒被对端切断”，按提示调小。

需要知道的限制：

- Cloud Agent 是否一直照做，取决于模型是否遵守提示词。它提前结束了这一轮时，网页会显示“未在等待”，按上面的办法让它回来即可，会话和排队的指令都还在。
- 挂起期间的每次模型调用都会计入用量：官方文档写明 Cloud Agent 按所选模型的费率消耗你的方案用量，首次使用时会让你设置花费上限。长时间挂着时留意用量。
- 一轮对话最长能持续多久，官方文档没有说明。

## 安全

这套东西把你电脑上的文件读写和命令执行能力开放给了公网上持有令牌的调用方，下面是默认的防护和你需要知道的边界。

**默认防护**

- **令牌**：MCP 端点的每个请求都必须带 `Authorization: Bearer 令牌`，否则返回 401。令牌是首次启动时生成的 256 位随机数，保存在 `%USERPROFILE%\.cursor-cloud-bridge\config.json`，不在仓库里，也不会打印到启动窗口。`--new-token` 可以换一个新的，旧的立即失效。“连接配置”里会显示收到过多少次令牌错误的请求。
- **网页不出本机**：网页和它的控制接口在另一个端口上，只监听 `127.0.0.1`，并且拒绝带代理转发头、Host 或 Origin 不是本机的请求（返回 403）。误把隧道指到这个端口时，这层检查是兜底，不要依赖它：隧道只应指向 `3221`。
- **文件限制在项目根目录内**：所有路径先解析成真实路径再判断。用 `..`、绝对路径、其他盘符、UNC 路径、符号链接或目录联接（junction）指到根目录之外的，一律拒绝；设备路径（`\\?\`、`\\.\` 开头）、保留设备名（`CON`、`NUL` 等）和 NTFS 备用数据流也拒绝。文件工具不能改动 `.git` 目录，防止通过 git 钩子间接执行代码。
- **命令默认逐条确认**：命令策略默认是 `ask`，每条命令都要你在网页上点“允许一次”才会执行。原因是命令一旦执行就不受项目根目录限制，它能做你这个 Windows 用户能做的任何事。“始终允许这条命令”只对一字不差的同一条命令（并且是同一种 shell）生效，只在本次运行期间有效。等待确认时如果云端超过 2 分钟不再查询，这条命令作废，不会在你事后点允许时突然执行。
**命令策略怎么选**

| 策略 | 适用 |
| --- | --- |
| `ask`（默认） | 平时使用。每条命令你都看得到、点了才执行 |
| `allow` | 你在盯着做一连串构建、测试，不想逐条点。用完切回去 |
| `deny` | 只让它读写文件，完全不执行命令 |

启动时用 `--command-policy` 指定，运行中在网页左下角切换。

**你需要知道的边界**

- 文件写入本身也可能导致代码执行：Cloud Agent 改过的构建脚本、`package.json` 的 scripts、任务配置，会在你之后自己运行项目时执行。运行前用 `git diff` 看一眼它改了什么。
- 项目根目录里的所有文件它都能读，包括 `.env` 这类密钥文件，读到的内容会发往 Cursor 和模型服务商。不要把根目录指到含有无关机密的文件夹，更不要指到整个用户目录或整个盘（根目录包含你的用户目录时，启动会有警告）。
- 网页没有登录。这台电脑上的其他用户和本机程序都能打开 `http://127.0.0.1:3220/`，也就能下指令、批准命令。多人共用的电脑上不要用。
- 公网地址请用 HTTPS。填了 `http://` 的地址时，令牌和文件内容会明文传输，启动时会有警告。
- 不用的时候按 Ctrl+C 停掉服务和隧道，这是最可靠的防护。
- MCP 端口的 `GET /` 不需要令牌，只返回服务名和一个随机的进程标识，供自检判断隧道是否通到了本进程。

## Windows 上的行为

- **路径**：工具接受相对项目根目录的路径（根目录内的绝对路径也可以），`/` 和 `\` 都可以，大小写不敏感。
- **编码**：读文件时识别 UTF-8、带 BOM 的 UTF-8、UTF-16，以及系统代码页（中文 Windows 是 GBK）。改已有文件时保持它原来的编码、BOM 和换行符（CRLF 或 LF），不会把整个文件的换行改掉。新文件用 UTF-8。系统代码页从注册表读取，`--legacy-encoding` 可以手动指定。
- **命令**：默认用 PowerShell 执行，装了 PowerShell 7（`pwsh.exe`）就用它，否则用系统自带的 Windows PowerShell 5.1（不支持 `&&`，多条命令用 `;` 分隔）。Cloud Agent 也可以指定用 `cmd`。命令在项目根目录或它的子目录里启动，没有窗口，标准输入是关闭的，所以不能运行需要键盘交互的程序。
- **输出**：按控制台代码页（中文 Windows 是 GBK）解码，UTF-8 输出也能识别。个别程序仍然乱码时见[常见问题](#常见问题)。
- **超时和终止**：每条命令默认 600 秒超时。超时、在网页上点“终止”或停止服务时，会结束整个进程树（`taskkill /T /F`）。
- **长时间运行的命令**：一次工具调用最多等约 50 秒，命令没结束就先返回已有输出，Cloud Agent 再用 `command_status` 接着等，所以构建、测试这类慢命令不会因为单次调用超时而失败。

## 命令行选项

```text
用法：node cloud/src/main.mjs [项目根目录] [选项]
      start-cloud.cmd [项目根目录] [选项]

不写项目根目录时会在启动后询问。

选项：
  --port <端口>               网页控制台端口，只监听 127.0.0.1（默认 3220）
  --mcp-port <端口>           MCP 端点端口，交给隧道的只有它（默认 3221）
  --mcp-host <地址>           MCP 端点监听地址（默认 127.0.0.1；隧道客户端不在本机时才需要改）
  --public-url <地址>         隧道的公网地址，例如 https://bridge.example.com（会记住，下次不用再写）
  --tunnel cloudflared        启动时顺带运行 cloudflared 快速隧道（需要已安装 cloudflared）
  --relay <服务器地址>        主动连到自己公网服务器上的中继，例如 https://1.2.3.4（只填一项，公网地址即服务器地址）
  --command-policy <策略>     命令执行策略：ask 每条命令在网页上确认（默认）、allow 全部允许、deny 禁止
  --wait-seconds <秒>         一次等待请求最长挂起多久（默认 50；隧道或云端会更早切断时调小）
  --legacy-encoding <编码>    非 UTF-8 的文件和命令输出按什么编码处理（默认取系统代码页，中文 Windows 是 gbk）
  --state-dir <目录>          保存访问令牌等状态的目录（默认 ~/.cursor-cloud-bridge）
  --new-token                 重新生成访问令牌（旧令牌立即失效，云端配置要跟着改）
  --open                      启动后自动打开网页控制台
  --help                      显示这段说明

环境变量：
  CLOUD_BRIDGE_TOKEN          指定访问令牌（至少 24 个字符）；不设置则自动生成并保存在状态目录
  CURSOR_API_KEY              你的 Cursor API 密钥。设置后控制台从 Cursor 读取云端 Agent 的思考并显示
```

`start-cloud.cmd` 会自动带上 `--open`。不用启动脚本时，先在仓库目录运行一次 `npm ci`，再运行 `node cloud\src\main.mjs "D:\work\my-project"`，或者 `npm run cloud -- "D:\work\my-project"`。

一个进程只服务一个项目根目录。换项目就停掉后换路径重新启动；公网地址和令牌不变，云端配置不用改。

## Cloud Agent 能用的工具

会话工具：

| 工具 | 作用 |
| --- | --- |
| `connect_session` | 接入网页，返回 `event=bind`、会话 id 和项目环境。带上原 id 可以重新接入同一个会话；可选参数 `agent` 是 Cloud Agent 的 id，用来读它的思考 |
| `wait_message` | 挂起等待下一条指令，返回 `message`、`idle`、`superseded` 或 `disconnected` |
| `reply_message` | 把结果发到网页，返回还在排队的消息数 `queued` |
| `report_progress` | 任务进行中把进展发到网页 |
| `disconnect_session` | 结束这个会话 |

这些工具的返回只有数据，不带“下一步做什么”的说明；流程只写在提示词里。网页上的思考不经过这些工具的返回，见[一次起多个 Cloud Agent，看思考过程](#5-一次起多个-cloud-agent看思考过程)。

项目工具：`project_info`、`list_dir`、`find_files`、`search_text`、`read_file`、`write_file`、`edit_file`（精确替换）、`delete_path`、`move_path`、`run_command`、`run_program`、`run_tests`、`command_status`、`stop_command`。

工具名沿用仓库里本地方案的 `connect_session` / `wait_message` / `reply_message` / `disconnect_session`。

## 官方文档确认了什么，没确认什么

以下依据 2026-11-13 读到的 Cursor 官方文档。

**已确认**

- Cloud Agent 可以加载自定义 MCP 服务，个人的在 cursor.com/agents 的 MCP 下拉菜单里添加和启用，团队共享的由管理员在 Dashboard 的 Plugins & MCPs 里配置。（[Capabilities](https://cursor.com/docs/cloud-agent/capabilities)）
- 支持 HTTP 和 stdio 两种传输，不支持 SSE 和 `mcp-remote`；官方推荐 HTTP。本项目用的是 HTTP（Streamable HTTP）。（同上）
- HTTP 服务的工具调用由 Cursor 后端代理发出，配置（包括请求头）加密保存、保存后不能再读出，也不会出现在 Cloud Agent 的虚拟机里。所以访问令牌只存在于 Cursor 的配置和你的电脑上。（同上）
- 远程 MCP 服务的配置格式是 `url` 加 `headers`。（[MCP](https://cursor.com/docs/context/mcp)）
- MCP 服务鉴权失败时，那次运行的事件里会出现 `mcp_auth_error`，它的工具被跳过，运行继续。（[Capabilities](https://cursor.com/docs/cloud-agent/capabilities)）
- Cloud Agent 的虚拟机默认可以访问互联网，可以配置出站白名单。（[Security & network](https://cursor.com/docs/cloud-agent/security-network)）
- Cloud Agent 按所选模型的费率消耗方案用量；需要含 Cloud Agent 的方案；可以不带仓库启动（Start from scratch）。（[Cloud Agents](https://cursor.com/docs/cloud-agent)）
- Cloud Agents API v1（公开测试版）的 `GET /v1/agents/{id}/stream` 以 SSE 推送 Agent 的 `thinking`（思考增量，`{ text }`）、`assistant`、`tool_call` 等事件，用 `Last-Event-ID` 续传，过了保留期返回 `410`；用用户或服务账号的 API key 鉴权。（[Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints)）

以下是 2026-11-14 在一个 Cloud Agent 虚拟机上实际看到的，文档没有写：

- Agent 的 Shell 环境里有 `CURSOR_CONVERSATION_ID`，值就是这个 Agent 的 id（`bc-…`）。
- 查过但读不到思考的地方：虚拟机上 `AGENT_TRANSCRIPTS` 指向的目录不存在；Agent 自带的会话导出在运行中只有空的 `messages`。Hooks 的 `afterAgentThought` 文档说在 Cloud Agent 里会执行，但只认被操作的云端仓库里的 `.cursor/hooks.json`，要往那个仓库提交钩子和桥的地址、令牌，所以没有采用。

**没有确认**

- 没有用真实的 API key 读过 `thinking` 事件（开发环境没有 key），只按文档的事件格式用本地模拟的 SSE 服务测试。

- cursor.com/agents 上添加 MCP 服务的界面具体有哪些输入框。上面第 4 步按“名称、URL、请求头”和 JSON 两种形式都给了，以实际界面为准。
- Cursor 后端对单次 MCP 工具调用的超时上限。默认的 50 秒是按 MCP 客户端常见的 60 秒上限留的余量。
- Cloud Agent 单轮对话的最长时长。
- 出站白名单是否也约束由后端代理的 MCP 调用。
- 正在运行的 Cloud Agent 是否会用上修改后的 MCP 地址。
- 除 cloudflared 快速隧道以外的各种隧道，以及任何隧道在中国大陆网络下的表现。

没有用一个真实的 Cloud Agent 通过 cursor.com 的 MCP 配置连过本服务，原因是开发环境无法给自己的 Cloud Agent 运行添加 MCP 服务。服务端是用真实的 MCP 客户端（官方 SDK，Streamable HTTP）经 cloudflared 隧道验证的。

## 验证状态

**在真实 Windows 上运行过**（GitHub Actions 的 `windows-latest`，Windows Server 2025，Node 22 和 24，PowerShell 7 和 Windows PowerShell 5.1 各一遍）：全部自动化测试，包括路径限制（盘符、UNC、8.3 短文件名、junction、符号链接）、PowerShell 和 cmd 执行与退出码、GBK 和 UTF-8 输出解码、超时和终止时结束整个进程树、编码和换行的保持、完整的 MCP 端到端流程、命令行参数，`start-cloud.cmd` 的参数传递，以及 `scripts/start-cloud.ps1` 在带空格和中文的路径上启动服务。

**只在 Linux 上验证过**（开发用的云端虚拟机，在海外）：

- 经 cloudflared 快速隧道的全流程：接入、等待、下指令、改文件、确认命令、回复、再等待。扮演 Cloud Agent 的是官方 MCP SDK 的客户端。
- 挂起等待：一个会话用 `wait_message` 经隧道连续挂了 30 分钟（空等返回 36 次，中间处理了一条指令）。
- 自建中继全流程：把中继用 `deploy.sh --insecure-http` 部署到一台真实的公网 Linux 服务器（systemd、非 root 运行），开发机上的云端桥以中继模式主动连上去，官方 MCP SDK 客户端经 `http://<服务器IP>:18443/mcp` 列工具、开两个会话、下指令、改文件、`run_command` 拿到 stdout/stderr/退出码、回复。其中一次 `wait_message` 经公网中继实测挂满 50.6 秒才返回 `idle`（**没有被缓冲**，期间下的指令约 0.9 秒就送达）；把中继服务重启一次，插件约 1.5 秒自动重连，会话继续。
- 在 Chrome 里实际操作网页控制台。

**没有验证**：系统代码页本身就是 936 的中文版 Windows（测试里是把控制台切到 936 来模拟）；双击启动和 `--open` 打开浏览器；Windows 上运行 cloudflared；真实的 Cloud Agent 接入；中国大陆的网络环境。

## 常见问题

**Cloud Agent 说找不到 `connect_session` 或 `cursor-cloud-bridge`。** 依次检查：cursor.com/agents 的 MCP 下拉里这个服务是否已启用；URL 是否以 `/mcp` 结尾；“连接配置”里的自检是否通过（隧道是否在运行）；cursor.com 上那次运行的事件里有没有 MCP 鉴权失败（`mcp_auth_error`）。有的话是令牌不对，重新从“连接配置”复制请求头的值。

**“连接配置”显示收到过令牌不正确的请求。** 刚配置完出现，说明请求头填错了，正确形式是名称 `Authorization`、值 `Bearer 令牌`，中间一个空格。没在配置时出现，说明有人在探测这个地址；令牌没泄露就不受影响，不放心可以用 `--new-token` 换一个。

**会话变成“未在等待”。** Cloud Agent 那一轮结束了。到 cursor.com/agents 对它说“继续等待网页消息”。期间发的指令在排队，它回来后会收到。

**自检未通过，但隧道明明开着。** 自检是从你的电脑访问公网地址。有些隧道域名在本机网络下打不开、从海外却能访问，这时以 Cloud Agent 能否接入为准。提示“通到了另一个云端桥进程”或“不是本服务”时，检查隧道指向的端口是不是 `3221`。

**自检提示“这个地址是公网中继”或“本机还没连上它”。** 中继地址必须填进设置 `cursorCloudBridge.relayUrl`（例如 `http://1.2.3.4:18443`），不要只填在“连接配置”的公网地址栏——那样不会建立出站链路，中继上 `links` 一直是 0，自检就会拿到 HTTP 503。明文中继要写 `http://`，只填 IP 或写成 `https://` 会导致连不上。填好后运行“重启云端桥”，输出面板应出现 `relay 链路已连接`。

**快速隧道的地址变了。** 把 cursor.com 里 MCP 配置的 URL 改成新地址，重新启动一个 Cloud Agent 并发提示词。想一劳永逸就换成地址固定的隧道。

**命令一直显示“等待你确认”，或者变成“已作废”。** 默认策略下每条命令都要在网页顶部点“允许一次”。Cloud Agent 等了超过 2 分钟不再查询时，这条命令会作废，它需要的话会重新发起。嫌逐条确认麻烦，可以在左下角把命令策略切到“全部允许”。

**命令输出乱码。** 先确认是哪一段乱：PowerShell 把文本通过管道传给外部程序时用的是 `$OutputEncoding`，可以在命令开头加 `$OutputEncoding = [Text.Encoding]::UTF8;`。程序本身输出 UTF-8 而系统是 GBK 时一般能自动识别；整体不对时，用 `--legacy-encoding` 指定正确的编码。

**第一次启动时安装依赖很慢或失败。** 这一步是 `npm ci` 从 npm 下载依赖。访问不畅时先运行 `npm config set registry https://registry.npmmirror.com` 换成国内镜像，再重新启动。

**启动时提示端口已被占用。** 多半是上一个云端桥还在运行，关掉它；或者用 `--port`、`--mcp-port` 换端口（隧道要跟着指向新的 MCP 端口）。

**提示没有找到 cloudflared。** 运行 `winget install --id Cloudflare.cloudflared` 后重新打开一个终端窗口再启动；或者自己运行别的隧道，用 `--public-url` 填地址。

**PowerShell 提示禁止运行脚本。** 用 `start-cloud.cmd` 启动，它只对这一次启动放开执行策略，不改系统设置。

**重启服务后网页上的会话没了。** 会话保存在内存里。公网地址没变时，还在等待的 Cloud Agent 会带着原来的 id 自动接回来，但之前的对话记录不会恢复。

**Cloud Agent 在云端的仓库里改了文件，本地没变化。** 它用了自带的文件工具而不是 `cursor-cloud-bridge` 的工具。提示词里已经要求只用项目工具；遇到时在网页上提醒它“用 cursor-cloud-bridge 的工具改我本地的文件”。

## 开发和测试

```powershell
npm ci
npm test
```

测试用 Node 自带的测试运行器，不需要额外依赖。端到端测试里由官方 MCP SDK 的客户端扮演 Cloud Agent，由网页所用的 HTTP 接口扮演用户。`.github/workflows/cloud-bridge.yml` 在 Windows 和 Linux 上运行同一套测试。

```text
cloud/
  src/main.mjs        入口：参数、启动、隧道
  src/config.mjs      命令行选项和保存在用户目录的状态
  src/http.mjs        两个 HTTP 监听：MCP 端点和本机控制台
  src/mcp.mjs         MCP 工具定义
  src/hub.mjs         会话、消息队列、操作记录
  src/auth.mjs        访问令牌的生成和校验
  src/tunnel.mjs      cloudflared 快速隧道
  src/relay-mux.mjs   中继帧多路复用（中继服务端和插件链路共用）
  src/relay-link.mjs  插件侧：主动连中继、把请求转到本机 MCP 端点
  src/project/        路径限制、编码、文件、搜索、命令执行
  relay/              公网服务器上的中继：relay.mjs 路由、server.mjs 可执行、deploy.sh 部署脚本
  web/                网页控制台
  prompt.md           发给 Cloud Agent 的提示词
  test/               自动化测试
  extension/          IDE 插件（.vsix）：extension.js 入口、lib/ 逻辑、build.mjs 打包、test/ 测试
```

`npm test` 同时覆盖云端桥和插件的测试。打包插件：`node cloud/extension/build.mjs`（或 `npm run cloud:vsix`），说明见 [`extension/README.md`](extension/README.md)。

## 和本地方案的关系

| | 本地方案（仓库根目录） | 云端桥（本目录） |
| --- | --- | --- |
| 对象 | 本机正在运行的 Cursor Desktop 里的会话和子代理 | 运行在 Cursor 云端的 Cloud Agent |
| 启动 | `start-web.cmd` | `start-cloud.cmd` |
| 端口 | 3210 | 3220（网页）、3221（MCP） |
| MCP 服务名 | `cursor-session-web` | `cursor-cloud-bridge` |
| 谁来改文件 | Cursor Desktop 自带的工具 | 本服务提供的项目工具 |
| 是否需要隧道 | 不需要，全在本机 | 需要，云端要能访问到本机 |

本地方案不能直接给 Cloud Agent 用：它的 MCP 服务只在本机的 `127.0.0.1` 上，靠本机 Cursor Desktop 的调试接口工作，云端访问不到，也没有可以操作文件的工具。云端桥沿用了它的会话协议和网页的使用方式，代码全部在 `cloud/` 目录，没有改动 `src/` 和 `web/`，两者只共用 `package.json` 里的依赖。

### 官方的另一条路：My Machines

Cursor 官方有一个不需要隧道的做法，叫 [My Machines](https://cursor.com/docs/cloud-agent/my-machines)：在自己的电脑上运行 `agent worker start`，然后在 cursor.com/agents 里选择这台机器，Cloud Agent 的终端命令和文件修改就直接在你的电脑上执行，对话在 cursor.com 上进行。它不需要本项目，也就没有本项目的网页控制台、挂起等待、项目根目录限制和逐条确认命令。本项目没有验证过它，这里只是说明有这个选择。
