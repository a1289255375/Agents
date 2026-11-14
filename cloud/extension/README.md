# Cursor 云端桥（IDE 插件）

把仓库里的[云端桥](../README.md)装进 Cursor / VS Code：IDE 启动后自动在本机跑起桥，无需再双击 `start-cloud.cmd`。插件在扩展宿主进程内直接运行 `cloud/src` 的代码，把本机能力通过 MCP 暴露给 Cursor Cloud Agent，并在面板里给云端子代理下指令、看它的思考过程、读写了哪些文件、执行了什么命令。一个插件可同时接住约十个云端会话。

## 打包

```bash
node cloud/extension/build.mjs            # 生成 cloud/extension/cursor-cloud-bridge-<版本>.vsix
node cloud/extension/build.mjs --out /tmp/cursor-cloud-bridge.vsix
```

构建脚本会把 `cloud/src`、`cloud/web`、`cloud/prompt.md` 复制到插件目录、安装运行时依赖（`@modelcontextprotocol/sdk`、`zod`），再用 `npx @vscode/vsce` 打包。`@vscode/vsce` 只在打包时用，不是插件的运行时依赖。

## 安装

在 Cursor / VS Code 的命令面板运行 **Extensions: Install from VSIX…**，选择生成的 `.vsix`；或命令行 `code --install-extension <file>.vsix`（Cursor 下为 `cursor --install-extension`）。

## 使用

- 命令（命令面板搜索“Cursor 云端桥”）：打开控制台、在浏览器中打开控制台、准备云端接入（一键）、设置工作区目录、切换命令执行策略、重启/停止云端桥、重新生成访问令牌。
- 设置（`cursorCloudBridge.*`）：工作区目录、命令执行策略、控制台/ MCP 端口、公网地址、隧道、自建中继地址（`relayUrl`，填了就走[自建公网中继](../README.md#自建公网中继可选不经第三方隧道)）、等待秒数、是否自动启动。
- 控制台面板就是浏览器里的那套网页控制台，会话列表、思考、进展、文件差异、命令确认都在里面。面板空白时用“在浏览器中打开控制台”。

完整的隧道选择、cursor.com 接入步骤、安全边界和未验证项见 [`cloud/README.md`](../README.md)。
