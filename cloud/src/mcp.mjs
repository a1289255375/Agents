// MCP tools for the cloud agent: the session loop (connect / wait / reply) and the project tools
// that act on the user's local machine.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { waitTicket } from "./auth.mjs";
import { sessionIdPattern } from "./hub.mjs";
import { describeError } from "./project/files.mjs";
import { legacyEncodings } from "./project/text.mjs";

const heartbeatMs = 15_000;
const taskInstruction = "message 是用户交给你的任务。用本服务的项目工具（read_file、edit_file、write_file、search_text、run_command、run_program、run_tests 等）在用户的本地电脑上完成它，调用时带上 session 参数（当前会话 id）。耗时较长时用 report_progress 汇报进展。完成后调用 reply_message 发送结果，然后立即执行它返回的 nextCall 继续等待。不要结束当前这一轮。";
const redeliveredInstruction = "这条消息之前已经投递过，但一直没有收到 reply_message。如果你已经处理过它，直接调用 reply_message 补发结果，不要重复执行；否则现在处理。";
const idleInstruction = "暂时没有新消息，这不是错误。立即再次执行 nextCall 继续等待；不要输出说明，不要结束当前这一轮。";
const shellIdleInstruction = "暂时没有新消息，这不是错误。原样重新执行同一条等待命令继续等待（不行就调用 nextCall）；不要输出说明，不要结束当前这一轮。";
const disconnectedInstruction = "用户已经明确结束这个会话。停止等待，不要再调用 wait_message；这是唯一可以结束当前这一轮的情况。";
const supersededInstruction = "这次等待已被同一会话更新的一次等待取代，不需要处理，也不要为它再发起等待。";

const nextWait = (id) => ({ name: "wait_message", arguments: { id } });
const duration = (ms) => (ms >= 120_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 1000)} 秒`);

// What a finished wait tells the agent. The wait_message tool and the shell-wait endpoint both use
// it, so the two ways of waiting speak the same protocol. `link` says whether the user's side of a
// relay is connected; an idle wait passes it on so the agent can tell "no task yet" from "nobody there yet".
export function waitResult(id, result, via = "mcp", link = undefined) {
  if (result.event === "message") {
    const { redelivered, ...message } = result;
    return { ...message, id, ...(redelivered && { redelivered }), instruction: redelivered ? redeliveredInstruction : taskInstruction };
  }
  if (result.event === "idle") {
    return { event: "idle", id, ...(link && { plugin: link }), instruction: via === "shell" ? shellIdleInstruction : idleInstruction, nextCall: nextWait(id) };
  }
  if (result.event === "disconnected") return { event: "disconnected", id, instruction: disconnectedInstruction };
  return { event: result.event, id, instruction: supersededInstruction };
}

export function createMcpServer({ hub, project, config, waitUrl }) {
  const server = new McpServer({ name: "cursor-cloud-bridge", version: "1.0.0" }, {
    instructions: "这是通往用户本地电脑的项目桥。先调用 connect_session({}) 报到，再按返回的 nextCall 挂起等待用户下发的任务；项目工具直接读写用户本地项目里的文件、执行命令、运行程序和测试。每条任务回复后立刻继续等待，不要结束当前这一轮。",
  });
  const { files, search, commands } = project;
  const link = () => config.link?.();

  // The same wait as wait_message, run in the agent's own shell tool. One shell call can block for
  // many minutes, so an idle hour costs a few model calls, not dozens. The command is a loop of
  // short polls, not one long request: every poll is over before a tunnel can buffer or drop it.
  // Three failed polls in a row end the loop, so an unreachable address sends the agent back to
  // wait_message within seconds instead of leaving it deaf until the deadline. Each run of the
  // command names itself (shell pid and deadline), so the hub can tell its polls from a later run's.
  // A cloud agent's shell has its agent id in CURSOR_CONVERSATION_ID; the polls pass it on so the
  // bridge can read the agent's thinking from Cursor (thinking.mjs).
  // The agent copies the command out of a JSON string, so everything before the final printf avoids
  // double quotes and backslashes: the case patterns match the quotes of {"event":"idle" with `?`.
  function shellWait(id, explain) {
    const url = config.shellWaitMs && waitUrl(id);
    // The address comes from request headers or user input and ends up inside a shell command.
    if (!url || !/^[\w.~:/[\]%-]+$/.test(url)) return undefined;
    const poll = `curl -sS -m ${Math.ceil(config.waitMs / 1000) + 30} -H 'Authorization: Bearer ${waitTicket(config.token, id)}' '${url}?loop='$$-$end'&agent='$CURSOR_CONVERSATION_ID 2>&1`;
    return {
      command: `end=$(($(date +%s)+${Math.ceil(config.shellWaitMs / 1000)})); n=0; while :; do r=$(${poll}); `
        + `case $r in '{'?event?:?idle?*) n=0;; '{'?event?:?*) break;; *) n=$((n+1)); [ $n -ge 3 ] && break; sleep 5;; esac; `
        + `[ $(date +%s) -ge $end ] && break; done; printf '%s\\n' "$r" | tail -n 1`,
      blockMs: config.shellWaitMs + config.waitMs + 60_000,
      ...(explain && {
        instruction: `更省调用的等待方式：用你的 Shell/终端工具在前台原样执行 command（不要改写，不要放进后台或 tmux），并把该工具的阻塞（超时）时间设为不小于 blockMs 毫秒。它会一直挂起，直到网页有新消息或 ${duration(config.shellWaitMs)}到时，然后输出一行与 wait_message 相同的 JSON；event=idle 时原样重新执行同一条命令。输出不是这种 JSON（命令报错、被切断或被转到后台）时，改为调用 nextCall（wait_message），之后也一直用 nextCall。`,
      }),
    };
  }

  const asText = (text) => ({ content: [{ type: "text", text }] });
  const asError = (text) => ({ isError: true, content: [{ type: "text", text }] });

  function sessionTool(name, description, inputSchema, run) {
    server.registerTool(name, { description, inputSchema }, async (args, extra) => {
      try {
        return asText(JSON.stringify(await run(args, extra), null, 2));
      } catch (error) {
        return asError(String(error?.message ?? error));
      }
    });
  }

  const sessionArg = z.string().optional().describe("当前会话 id（connect_session 返回的 id）。接入会话后请始终填写，用户才能看到这次操作属于你的会话");

  // `run` returns { text, record }: text goes to the agent, record to the activity feed the user sees.
  function projectTool(name, description, inputSchema, run, annotations) {
    server.registerTool(name, { description, inputSchema: { ...inputSchema, session: sessionArg }, annotations }, async ({ session, ...args }, extra) => {
      const owner = hub.attribute(session);
      const startedAt = Date.now();
      try {
        const { text, record } = await run(args, extra, owner);
        if (record) hub.record({ session: owner, tool: name, ok: true, ms: Date.now() - startedAt, ...record });
        return asText(text);
      } catch (error) {
        const message = describeError(error, project.guard.root);
        const target = args.path ?? args.pattern ?? args.from ?? args.command ?? args.jobId ?? "";
        hub.record({ session: owner, tool: name, ok: false, ms: Date.now() - startedAt, target, error: message });
        return asError(message);
      }
    });
  }

  const idArg = z.string().regex(sessionIdPattern, "会话 id 应为 connect_session 返回的 8 位十六进制字符串").describe("会话 id（connect_session 返回的 id）");
  const pathArg = (what) => z.string().describe(`${what}，相对项目根目录${project.platform === "win32" ? "，/ 和 \\ 都可以" : ""}`);
  const readOnly = { readOnlyHint: true };

  sessionTool(
    "connect_session",
    "报到：告诉用户“我已经创建好了”，成为一个可以接收指令的会话。创建完毕后第一件事就调用它。调用 connect_session({}) 会立即返回 event=bind 和 nextCall；随后立刻执行 nextCall 挂起等待用户的指令。断线或服务重启后，可以带上原来的 id 或 key 重新接入同一个会话。",
    {
      name: z.string().trim().min(1).max(60).optional().describe("显示给用户的会话名称，可不填"),
      id: idArg.optional().describe("要重新接入的原会话 id；新会话不填"),
      key: z.string().trim().min(1).max(200).optional().describe("调用方的固定标识，例如对话 id。带同一个 key 再次调用会回到同一个会话，即使已经不记得会话 id"),
      meta: z.record(z.string().max(40), z.string().max(300)).optional().describe("显示在会话旁的附加信息，例如对话 id、所在主机"),
    },
    ({ id, name, key, meta }) => {
      const session = hub.connect({ id, name, key, meta });
      const plugin = link();
      return {
        event: "bind",
        id: session.id,
        name: session.name,
        ...(plugin && { plugin }),
        project: project.info(),
        instruction: "已接入。立即执行 nextCall 挂起等待用户的指令；之后所有项目工具调用都带上 session 参数（即这里的 id）。",
        nextCall: nextWait(session.id),
        shellWait: shellWait(session.id, true),
      };
    },
  );

  sessionTool(
    "wait_message",
`挂起等待用户的下一条指令，最长约 ${duration(config.waitMs)}。event=message：message 是用户交给你的任务，完成后调用 reply_message。event=idle：暂时没有消息（不是错误），立即再次调用 wait_message，无论重复多少次。event=disconnected：用户已明确结束会话，停止等待。`,
    { id: idArg },
    async ({ id }, { signal, _meta, sendNotification }) => {
      const progressToken = _meta?.progressToken;
      let progress = 0;
      // Progress notifications keep clients that reset their timeout on progress from giving up early.
      const heartbeat = progressToken !== undefined && setInterval(() => {
        void sendNotification({ method: "notifications/progress", params: { progressToken, progress: ++progress } }).catch(() => {});
      }, heartbeatMs);
      try {
        return waitResult(id, await hub.wait(id, { signal, holdMs: config.waitMs, via: "mcp" }), "mcp", link());
      } finally {
        clearInterval(heartbeat);
      }
    },
  );

  sessionTool(
    "reply_message",
    "把任务结果或对用户问题的答复发给用户。随后立刻执行返回的 nextCall 继续等待下一条消息。",
    {
      id: idArg,
      text: z.string().trim().min(1).max(100000).describe("发给用户的内容，支持 Markdown"),
    },
    ({ id, text }) => {
      const result = hub.reply(id, text);
      if (result.event === "disconnected") return waitResult(id, result);
      const viaShell = shellWait(id, false);
      return {
        event: "replied",
        id,
        sent: true,
        queued: result.queued,
        instruction: result.queued ? `还有 ${result.queued} 条消息在排队。立刻执行 nextCall 领取下一条。`
          : viaShell ? "现在立刻继续等待，方式和你上一次等待相同：在 Shell 工具里执行 shellWait.command，或执行 nextCall。"
            : "现在立刻执行 nextCall 继续等待。",
        nextCall: nextWait(id),
        shellWait: viaShell,
      };
    },
  );

  sessionTool(
    "report_progress",
    "任务耗时较长时，把当前进展发给用户看。它不结束任务，也不需要等待回复。",
    { id: idArg, text: z.string().trim().min(1).max(20000).describe("进展说明") },
    ({ id, text }) => {
      const result = hub.progress(id, text);
      if (result.event === "disconnected") return waitResult(id, result);
      return { event: "progress", id, sent: true, ...(result.queued && { note: `用户又发来 ${result.queued} 条消息，当前任务回复后会在 wait_message 收到。` }) };
    },
  );

  sessionTool(
    "disconnect_session",
    "结束这个会话的等待。只在用户明确要求结束时调用。",
    { id: idArg },
    ({ id }) => {
      hub.disconnect(id, "agent");
      return { event: "disconnected", id, disconnected: true };
    },
  );

  projectTool(
    "project_info",
    "查看用户本地项目的环境：根目录、操作系统、可用的 shell、命令策略、文件编码和路径约定。不确定环境时调用。",
    {},
    () => ({ text: project.info() }),
    readOnly,
  );

  projectTool(
    "list_dir",
    "列出目录内容：目录在前，文件带大小。depth 大于 1 时展开子目录（.git 和 node_modules 不展开）。",
    {
      path: pathArg("目录路径").default("."),
      depth: z.number().int().min(1).max(5).default(1).describe("展开的层数，默认 1"),
    },
    (args) => files.listDir(args),
    readOnly,
  );

  projectTool(
    "find_files",
    "按 glob 模式查找文件，结果按修改时间从新到旧排列。不含 / 的模式在任意层级匹配（*.ts 等同于 **/*.ts）。git 仓库里遵守 .gitignore，其他目录跳过 node_modules 等常见的依赖目录。",
    {
      pattern: z.string().min(1).describe("glob 模式，例如 *.ts、src/**/*.{js,jsx}"),
      path: pathArg("只在这个目录下查找").default("."),
      limit: z.number().int().min(1).max(2000).default(200).describe("最多返回多少个文件"),
      includeIgnored: z.boolean().default(false).describe("是否包含被 .gitignore 忽略的文件和依赖目录"),
    },
    (args) => search.findFiles(args),
    readOnly,
  );

  projectTool(
    "search_text",
    "在项目文件中逐行搜索文本，pattern 是 JavaScript 正则。输出按文件分组，匹配行为“行号:内容”，上下文行为“行号-内容”。能读 UTF-8、UTF-16 和系统代码页（如 GBK）的文件，跳过二进制文件。",
    {
      pattern: z.string().min(1).describe("正则表达式；要按字面搜索时设置 literal: true"),
      path: pathArg("只搜索这个目录或文件").default("."),
      glob: z.string().min(1).optional().describe("只搜索匹配这个 glob 的文件，例如 *.py"),
      literal: z.boolean().default(false).describe("把 pattern 当作普通文本而不是正则"),
      ignoreCase: z.boolean().default(false).describe("忽略大小写"),
      context: z.number().int().min(0).max(10).default(0).describe("每处匹配前后各显示多少行"),
      limit: z.number().int().min(1).max(1000).default(100).describe("最多返回多少处匹配"),
      includeIgnored: z.boolean().default(false).describe("是否包含被 .gitignore 忽略的文件和依赖目录"),
    },
    (args) => search.searchText(args),
    readOnly,
  );

  projectTool(
    "read_file",
    "读取文本文件。每行输出为“行号|内容”，行号前缀只是标记，不是文件内容。默认最多返回 2000 行，可用 offset 和 limit 分段读取。",
    {
      path: pathArg("文件路径"),
      offset: z.number().int().optional().describe("从第几行开始（从 1 起）；负数表示从末尾往前数"),
      limit: z.number().int().min(1).max(5000).optional().describe("最多读取多少行，默认 2000"),
    },
    (args) => files.readFile(args),
    readOnly,
  );

  projectTool(
    "write_file",
    "创建文件或整体覆盖文件，会自动创建上级目录。覆盖已有文件时沿用它原来的编码和换行符（CRLF/LF），新文件用 UTF-8。只改已有文件的一部分时请用 edit_file。",
    {
      path: pathArg("文件路径"),
      content: z.string().max(3_000_000).describe("完整的文件内容"),
      encoding: z.enum(["utf8", "utf8-bom", "utf16le", "utf16be", "ansi", ...legacyEncodings]).optional()
        .describe("要强制使用的编码；ansi 表示系统代码页。不填则沿用原文件编码，新文件用 UTF-8"),
    },
    (args) => files.writeFile(args),
  );

  projectTool(
    "edit_file",
    "精确替换文件中的一段文本。old_string 必须和文件内容完全一致（包括缩进，不要带行号前缀），并且只出现一次；出现多次时补充上下文，或设置 replace_all。CRLF/LF 的差异会自动处理，文件的其余部分保持原样。",
    {
      path: pathArg("文件路径"),
      old_string: z.string().describe("要被替换的原文"),
      new_string: z.string().describe("替换成的新文本"),
      replace_all: z.boolean().default(false).describe("替换所有出现的位置"),
    },
    (args) => files.editFile(args),
  );

  projectTool(
    "delete_path",
    "删除文件、链接或目录。非空目录需要 recursive: true。",
    {
      path: pathArg("要删除的路径"),
      recursive: z.boolean().default(false).describe("连同目录里的内容一起删除"),
    },
    (args) => files.deletePath(args),
    { destructiveHint: true },
  );

  projectTool(
    "move_path",
    "移动或重命名文件、目录，会自动创建目标的上级目录。目标已存在时需要 overwrite: true。",
    {
      from: pathArg("原路径"),
      to: pathArg("新路径"),
      overwrite: z.boolean().default(false).describe("目标已存在时覆盖它"),
    },
    (args) => files.movePath(args),
  );

  const commandWaitSeconds = Math.round(config.commandWaitMs / 1000);
  // Before the user's side of a relay has connected, the shells of that machine are not known yet.
  const shellNames = Object.keys(commands.shells);
  const defaultShell = commands.defaultShell ? `${commands.defaultShell}（${commands.shells[commands.defaultShell]}）` : "由用户的电脑决定（用 project_info 查看）";
  const jobRules = `一次调用最多等待约 ${commandWaitSeconds} 秒：到时还没结束，就返回已有输出和编号，再用 command_status 继续等待。命令策略是“每次确认”时，要先由用户在本地批准，期间按返回的提示调用 command_status。结束时返回退出码、按时间合并的输出、单独列出的 stderr 部分（stderr 为空就没有这一段）和运行期间的文件变更。标准输入是关闭的，不要运行需要键盘交互的程序。`;
  const timeoutArg = (seconds) => z.number().int().min(1).max(86_400).default(seconds).describe(`超过这个时间就终止整个进程树，默认 ${seconds} 秒`);

  projectTool(
    "run_command",
    `在用户本地电脑的项目目录里执行一行 shell 命令，默认 shell 是 ${defaultShell}。只是启动某个程序或跑测试时，优先用 run_program 和 run_tests，不用自己处理引号和转义。${jobRules}开发服务器这类不会自己结束的进程，要设置足够大的 timeoutSeconds，用完后用 stop_command 终止。`,
    {
      command: z.string().trim().min(1).describe("要执行的命令行"),
      cwd: pathArg("工作目录").default("."),
      shell: (shellNames.length ? z.enum(shellNames) : z.string()).optional().describe(`使用哪个 shell，默认 ${commands.defaultShell ?? "用户电脑的默认 shell"}`),
      timeoutSeconds: timeoutArg(600),
    },
    async (args, { signal }, session) => ({ text: await commands.report(await commands.request({ ...args, session }), { signal }) }),
    { destructiveHint: true, openWorldHint: true },
  );

  projectTool(
    "run_program",
    `在用户本地电脑上启动一个程序，参数用数组给出，不经过 shell：每个参数原样传给程序，不需要引号和转义，也不会被解释成管道、重定向或变量。适合运行编译器、脚本解释器、包管理器、构建工具和项目自己的可执行文件。Windows 上程序名会按 PATHEXT 匹配 .exe、.cmd、.bat（例如 npm、gradlew）。需要管道或重定向时改用 run_command。${jobRules}`,
    {
      program: z.string().trim().min(1).describe("程序名（在工作目录和 PATH 里查找），或相对工作目录的路径"),
      args: z.array(z.string()).max(200).default([]).describe("参数数组，每个元素是一个完整的参数"),
      cwd: pathArg("工作目录").default("."),
      env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional().describe("额外的环境变量"),
      timeoutSeconds: timeoutArg(600),
    },
    async (args, { signal }, session) => ({ text: await commands.report(await project.programs.run({ ...args, session }), { signal }) }),
    { destructiveHint: true, openWorldHint: true },
  );

  projectTool(
    "run_tests",
    `运行用户项目的测试。测试命令由本地决定：用户在本地设置里指定的命令优先，否则按项目文件自动识别（package.json 的 test 脚本、Cargo.toml、go.mod、.NET 项目、pom.xml、build.gradle、pytest、Makefile 的 test 目标），结果的第一行会写明实际执行的命令。${jobRules}`,
    {
      cwd: pathArg("在哪个目录里找测试并运行").default("."),
      args: z.array(z.string()).max(100).default([]).describe("追加给测试命令的参数，例如只跑某个文件或用例的过滤条件"),
      timeoutSeconds: timeoutArg(1800),
    },
    async (args, { signal }, session) => {
      const { id, note } = await project.tests.run({ ...args, session });
      return { text: `${note}\n${await commands.report(id, { signal })}` };
    },
    { destructiveHint: true, openWorldHint: true },
  );

  const jobArg = z.string().regex(/^c\d+$/, "命令编号形如 c1").describe("run_command、run_program 或 run_tests 返回的编号，例如 c1");
  projectTool(
    "command_status",
    `继续等待一条命令、程序或测试（最多约 ${commandWaitSeconds} 秒），返回它的状态和 offset 之后的输出。`,
    {
      jobId: jobArg,
      offset: z.number().int().min(0).default(0).describe("从输出的第几个字符开始返回；按上一次结果里给出的值填写"),
    },
    async ({ jobId, offset }, { signal }) => ({ text: await commands.report(jobId, { offset, signal }) }),
    readOnly,
  );

  projectTool(
    "stop_command",
    "终止一条正在运行或等待确认的命令、程序或测试，连同它启动的整个进程树。",
    { jobId: jobArg },
    async ({ jobId }, { signal }) => {
      commands.stop(jobId);
      return { text: await commands.report(jobId, { offset: Number.MAX_SAFE_INTEGER, signal }) };
    },
  );

  return server;
}
