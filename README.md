# Cursor Session MCP

通过本机 MCP 客户端给正在运行的 Cursor Desktop 发送消息，读取会话进度和输出。已在 Windows 上的 Cursor 3.29.9 编辑器窗口验证。需要 Node.js 22 或更新版本。

## 从网页和 Cursor 会话对话

双击项目根目录的 `start-web.cmd`。它会在缺少依赖时自动安装，启动 WebUI 和 MCP，再用默认浏览器打开 `http://127.0.0.1:3210/`。服务已经运行时会直接打开网页。首次启动后保持启动窗口和 Cursor 打开。

命令行也可运行 `npm ci` 和 `npm run web`。首次接入 MCP 的电脑需要把以下条目合并到 Cursor 的 `%USERPROFILE%\.cursor\mcp.json`，或添加到其他支持 Streamable HTTP 的 MCP 客户端。

```json
{
  "mcpServers": {
    "cursor-session-web": {
      "url": "http://127.0.0.1:3210/mcp"
    }
  }
}
```

每个 Cursor Agent 都可以调用 `connect_session({})`，并按工具返回的 `nextCall` 自动确认接入。多个子代理可以同时接入，各自绑定自己的会话。网页显示该子代理的进度、可见思考、工具活动和执行结果。外部 MCP 客户端接入指定会话时可传 `id`。Cursor 若提示审批 MCP 工具，请批准本次调用。

WebUI 运行时会检查 Cursor 窗口的本机 Web MCP 连接。新窗口如果沿用了旧连接，WebUI 会自动更新该窗口的连接。服务重启后，如果 Cursor 将连接保留在 HTTP 连接失败状态，WebUI 会自动刷新该连接。

确认接入后，`connect_session` 会持续等待第一条消息。回复后由 Agent 调用 `wait_message` 继续挂起。当前轮结束、等待断开或调用 `disconnect_session` 后，网页显示「离线」并停止收消息。要重新上线，请从 Cursor 再次接入。同一轮等待仍受 Cursor MCP 客户端的单次工具调用时限约束。

网页接入名单和通过工具转发的聊天气泡保存在运行中的服务里，重启后需重新接入。原生会话记录仍保存在 Cursor。

选中会话后，点标题右侧的「删除会话」。默认只清除该条网页记录并结束等待；勾选「同时删除 Cursor 中的会话」再确认，才会调用 Cursor 删除原会话。同步删除失败时，网页保留该条记录并显示原因。

侧边栏的「批量管理」可勾选多个会话或全选，再用「删除所选」统一确认。

## 从网页派发 Multitask 子代理

点「Multitask 派发子代理」，选择已打开的 Cursor 工作区和子代理创建方式。按模型档位分组填写数量，总计 1 到 10 个。点「发送到 Cursor」后，网页会在所选工作区新建 Multitask 父会话并发送提示词。「查看／编辑提示词」可修改内容，也可像以前一样复制到 Cursor。

派发默认使用 Grok 4.7（500K、Extra High、Fast）。父会话使用第一组的模型档位。

选择「父代理调用 MCP」时，父会话使用 `create_subagents`，派发记录和创建错误会出现在侧栏。选择「父代理用 Cursor 原生工具」时，父会话通过原生 Task 工具创建，创建过程显示在父会话里，两种方式的子代理都会调用 `connect_session({})` 接入网页。

`list_model_variants` 返回当前可用的模型档位。调用 `create_subagents` 时，将每项的 `model` 原样传入，格式例如 `claude-opus-5-5[context=1m,effort=max,fast=true]`。Cursor 的本地子代理继承父会话的 Max Mode。如果所选档位需要 Max Mode，请先在父会话开启。

```text
并行启动所需的后台子代理，给它们不同的名称，把下面这段任务交给每个子代理：

【子会话】你负责接收并执行我在 WebUI 中发送的任务。现在调用 user-cursor-session-web 的 connect_session，参数为 {}，自动绑定你自己的 Cursor 会话。

收到 event=bind 时，立即在同一会话执行返回的 nextCall，让 MCP 确认你的会话并进入等待。

收到 event=message 后，把 message 当作用户任务，按要求执行，需要时调用工具。正常输出关键进展，网页会显示你的过程。完成后用 reply_message 发送实际结果，然后立即用返回的 id 调用 wait_message，挂起等待下一条消息。不要自行结束当前轮。网页明确要求结束等待时调用 disconnect_session。

父代理启动后告诉我各子代理的名称，我会在网页给它们分别发任务。
```

## stdio 接入

在 `E:\cursor-session-mcp` 运行 `npm ci`，保持 Cursor 打开。在 MCP 客户端中添加以下 stdio 服务。Cursor 客户端使用 `%USERPROFILE%\.cursor\mcp.json`，已有配置时只合并 `mcpServers` 下的对应条目。

```json
{
  "mcpServers": {
    "cursor-session": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["E:\\cursor-session-mcp\\src\\index.mjs"]
    }
  }
}
```

## 对话

1. 调用 `create_session`，例如 `{"mode":"chat","prompt":"用一句话解释二分查找"}`。`mode: "chat"` 对应 Ask，省略时使用 Agent。已有会话的 ID 可以通过 `list_sessions` 获取。
2. 用返回的 `id` 调用 `read_session`，例如 `{"id":"会话 ID","waitSeconds":30}`。返回 `generating` 时可再次读取。省略 `waitSeconds` 会立即读取当前进度。
3. 用同一个 `id` 调用 `send_message`，例如 `{"id":"会话 ID","text":"给一个简单例子"}`。同时开着多个 Cursor 窗口时可通过 `list_windows` 找到对应窗口，并在各次调用中传入标题片段 `window`。

`read_session` 按顺序返回最近的消息。`messages[].id` 标识该消息，重复读取时可用它更新正在生成的片段。`text` 是对话正文，`thinking` 是 Cursor 返回的可见思考文本，`thinkingDurationMs` 是 Cursor 提供的耗时。工具调用可带 `tool.status`、`tool.detail` 和 `tool.output`，请求失败时可查 `messages[].error` 或会话级 `submitError`。可见思考取决于模型和会话，字段只在有内容时返回。默认取最近 10 条，每个文本字段默认保留 4000 字符，可用 `last` 和 `maxChars` 调整。

```powershell
npm run smoke -- --mode chat --prompt '只回复 CURSOR_MCP_OK，不调用工具。'
```

## 云端桥：让 Cloud Agent 操作本机项目

以上都是驱动本机 Cursor Desktop 的本地方案。要让运行在 Cursor 云端的 Cloud Agent 通过 MCP 读写本机项目、执行命令，并在网页上给它下指令，用 `start-cloud.cmd`，说明见 [cloud/README.md](cloud/README.md)。两套方案互不影响，可以同时运行。
