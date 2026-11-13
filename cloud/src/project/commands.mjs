// Shell commands run as jobs: a tool call returns within its wait budget while the job keeps running,
// so a slow build never holds one MCP call open longer than the client allows.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import nodePath from "node:path";
import { changeCount, formatChanges } from "./changes.mjs";
import { displayArgv, programLaunch } from "./programs.mjs";
import { decodeOutputLine } from "./text.mjs";

const maxCommandChars = 8000;
const maxOutputChars = 2_000_000;
const keptOutputChars = 1_000_000;
const maxPendingBytes = 64 * 1024;
const partialFlushMs = 500;
const exitGraceMs = 1000;
const outputNotifyMs = 300;
const maxRunning = 16;
const maxFinished = 50;
const reportChars = 30_000;
const reportHeadChars = 5000;
const streamTailChars = 64_000;
const annexChars = 6000;
const directShell = "direct";
const finalStates = new Set(["exited", "timeout", "stopped", "denied", "expired", "failed"]);

export class CommandError extends Error {}

function findOnPath(name) {
  for (const dir of (process.env.PATH ?? "").split(nodePath.delimiter)) {
    if (dir && fs.existsSync(nodePath.join(dir, name))) return nodePath.join(dir, name);
  }
}

// The status of the last statement becomes the exit code, as in other shells. Left alone, PowerShell
// reports 0 or 1 only and writes progress records to stderr as CLIXML.
function powershellScript(command) {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    command,
    "if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } exit 1 }",
  ].join("\n");
}

export function shellsFor(platform) {
  if (platform !== "win32") {
    const file = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
    // A process group of its own lets the whole tree be killed at once.
    return { defaultShell: "bash", shells: { bash: { label: file, launch: (command) => [file, ["-c", command], { detached: true }] } } };
  }
  const pwsh = findOnPath("pwsh.exe");
  const flags = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"];
  return {
    defaultShell: "powershell",
    shells: {
      powershell: {
        label: pwsh ? "PowerShell 7（pwsh.exe）" : "Windows PowerShell 5.1（powershell.exe，不支持 &&，多条命令用 ; 分隔）",
        // -EncodedCommand takes base64 UTF-16LE, which sidesteps every quoting rule of the Windows command line.
        launch: (command) => [pwsh ?? "powershell.exe", [...flags, Buffer.from(powershellScript(command), "utf16le").toString("base64")], {}],
      },
      cmd: {
        label: "cmd.exe",
        launch: (command) => [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${command}"`], { windowsVerbatimArguments: true }],
      },
    },
  };
}

// Splits a byte stream into lines before decoding, so a multi-byte character is never cut in half.
function lineDecoder(encoding, emit) {
  let pending = Buffer.alloc(0);
  let timer;
  const flush = () => {
    clearTimeout(timer);
    if (!pending.length) return;
    emit(decodeOutputLine(pending, encoding));
    pending = Buffer.alloc(0);
  };
  return {
    flush,
    push(chunk) {
      clearTimeout(timer);
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let from = 0;
      let text = "";
      for (let at = pending.indexOf(0x0a); at !== -1; at = pending.indexOf(0x0a, from)) {
        text += `${decodeOutputLine(pending.subarray(from, at), encoding)}\n`;
        from = at + 1;
      }
      pending = pending.subarray(from);
      if (text) emit(text);
      if (pending.length > maxPendingBytes) flush();
      // A prompt without a newline would otherwise stay invisible while the command waits on it.
      else if (pending.length) timer = setTimeout(flush, partialFlushMs);
    },
  };
}

const seconds = (ms) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`;

// `tracker` (see changes.mjs) is optional: with it, every finished command also reports the files it touched.
export function createCommandRunner({
  guard, platform = process.platform, consoleEncoding, policy: initialPolicy, waitMs, approvalStaleMs = 120_000, onChange = () => {},
  tracker, approvalPlace = "网页控制台",
}) {
  const { defaultShell, shells } = shellsFor(platform);
  const jobs = new Map();
  const alwaysAllowed = new Set();
  let policy = initialPolicy;
  let counter = 0;

  const isFinal = (job) => finalStates.has(job.state);
  const isStale = (job) => job.watchers === 0 && Date.now() - job.polledAt > approvalStaleMs;
  const allowKey = (job) => `${job.shell}\n${job.command}\n${JSON.stringify(job.env ?? {})}`;

  function changed(job) {
    for (const wake of [...job.wakers]) wake();
    onChange(view(job));
  }

  function settle(job, state, detail) {
    if (isFinal(job)) return;
    clearTimeout(job.timeout);
    clearTimeout(job.grace);
    clearTimeout(job.notify);
    for (const decoder of job.decoders ?? []) decoder.flush();
    job.child?.stdout.destroy();
    job.child?.stderr.destroy();
    Object.assign(job, { state, endedAt: Date.now(), ...detail });
    const finished = [...jobs.values()].filter(isFinal);
    for (const old of finished.slice(0, Math.max(0, finished.length - maxFinished))) jobs.delete(old.id);
    changed(job);
  }

  function killTree(pid, sync = false) {
    if (platform !== "win32") {
      try { process.kill(-pid, "SIGKILL"); } catch {}
      return;
    }
    // taskkill /T walks the parent-child tree; killing only the shell would orphan what it started.
    const args = ["/PID", String(pid), "/T", "/F"];
    if (sync) spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
    else spawn("taskkill", args, { stdio: "ignore", windowsHide: true }).on("error", () => {});
  }

  function start(job) {
    if ([...jobs.values()].filter((other) => other.state === "running").length >= maxRunning) {
      settle(job, "failed", { error: `同时运行的命令已达上限 ${maxRunning} 个，请先等待或用 stop_command 终止其中一些` });
      return;
    }
    Object.assign(job, { state: "running", startedAt: Date.now() });
    if (!tracker) {
      launch(job);
      return;
    }
    changed(job);
    // The listing has to be complete before the command can change anything.
    tracker.snapshot().then((before) => { job.before = before; }, () => {}).then(() => {
      if (isFinal(job)) return;
      job.tracked = true;
      launch(job);
    });
  }

  function launch(job) {
    let child;
    try {
      const env = { ...process.env, ...job.env };
      delete env.CLOUD_BRIDGE_TOKEN;
      const [file, args, options] = job.argv
        ? programLaunch(job.argv, { platform, cwd: job.cwd, env })
        : shells[job.shell].launch(job.command);
      child = spawn(file, args, { cwd: job.cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...options });
    } catch (error) {
      settle(job, "failed", { error: error.message });
      return;
    }
    const append = (stream) => (text) => {
      job.output += text;
      if (job.output.length > maxOutputChars) {
        job.dropped += job.output.length - keptOutputChars;
        job.output = job.output.slice(-keptOutputChars);
      }
      stream.chars += text.length;
      stream.tail = (stream.tail + text).slice(-streamTailChars);
      job.notify ??= setTimeout(() => {
        job.notify = undefined;
        onChange(view(job));
      }, outputNotifyMs);
    };
    job.decoders = [[child.stdout, job.stdout], [child.stderr, job.stderr]].map(([pipe, stream]) => {
      const decoder = lineDecoder(consoleEncoding, append(stream));
      pipe.on("data", decoder.push);
      return decoder;
    });
    job.child = child;
    job.timeout = setTimeout(() => {
      job.timedOut = true;
      killTree(child.pid);
    }, job.timeoutMs);

    const exited = (code, signal) => {
      if (job.exiting || isFinal(job)) return;
      job.exiting = true;
      clearTimeout(job.timeout);
      const finish = (changes) => settle(job, job.timedOut ? "timeout" : job.stopRequested ? "stopped" : "exited", { exitCode: code, signal, changes });
      if (!job.tracked) finish();
      else tracker.snapshot().then((after) => finish(tracker.diff(job.before, after)), () => finish());
    };
    child.once("error", (error) => settle(job, "failed", { error: error.code === "ENOENT" ? `找不到程序 ${job.argv?.[0] ?? error.path}` : error.message }));
    child.once("close", exited);
    // A background process started by the command can keep the pipes open long after the shell is gone.
    child.once("exit", (code, signal) => { job.grace = setTimeout(exited, exitGraceMs, code, signal); });
    changed(job);
  }

  function expireLater(job) {
    setTimeout(() => {
      if (job.state === "awaiting_approval" && isStale(job)) settle(job, "expired");
    }, approvalStaleMs + 1000).unref();
  }

  function view(job) {
    const { id, command, shell, cwdRel, session, tool, state, exitCode, error, requestedAt, startedAt, endedAt, timeoutMs, changes } = job;
    return {
      id, command, shell, cwd: cwdRel, session, tool, state, exitCode, error, requestedAt, startedAt, endedAt, timeoutMs, changes,
      waiting: job.watchers > 0, outputTail: job.output.slice(-4000), outputChars: job.dropped + job.output.length,
      stdoutTail: job.stdout.tail.slice(-4000), stdoutChars: job.stdout.chars,
      stderrTail: job.stderr.tail.slice(-4000), stderrChars: job.stderr.chars,
    };
  }

  // What a finished command adds below its output: the stderr part on its own, and the files it touched.
  function annex(job) {
    const parts = [];
    const { stdout, stderr } = job;
    if (stderr.chars && !stdout.chars) {
      parts.push("── 以上输出全部来自 stderr，stdout 为空 ──");
    } else if (stderr.chars) {
      const cut = stderr.chars > annexChars ? `，只显示末尾 ${annexChars} 个` : "";
      parts.push(`── stderr 部分（共 ${stderr.chars} 个字符${cut}；上面的输出按时间合并了 stdout 和 stderr） ──\n${stderr.tail.slice(-annexChars).trimEnd()}`);
    }
    if (job.changes?.skipped || changeCount(job.changes)) {
      const { added = [], modified = [], deleted = [] } = job.changes;
      const counts = job.changes.skipped ? "" : `：新增 ${added.length}，修改 ${modified.length}，删除 ${deleted.length}（+ 新增，~ 修改，- 删除；被 .gitignore 忽略的文件不统计）`;
      parts.push(`── 文件变更${counts} ──\n${formatChanges(job.changes)}`);
    }
    return parts;
  }

  function describe(job, offset) {
    const where = `${job.shell === directShell ? "直接启动" : job.shell}，目录 ${job.cwdRel}`;
    const end = job.dropped + job.output.length;
    const ask = (args) => `command_status(${JSON.stringify({ jobId: job.id, ...args })})`;
    const headline = {
      awaiting_approval: () => `等待用户在${approvalPlace}确认这条命令（命令策略：每次确认）。调用 ${ask()} 继续等待，不要重复发起同一条命令。`,
      running: () => `仍在运行，已 ${seconds(Date.now() - job.startedAt)}（${where}）。调用 ${ask({ offset: end })} 继续等待和获取后续输出；不再需要时用 stop_command 终止。`,
      exited: () => `已结束，退出码 ${job.exitCode ?? `无（被信号 ${job.signal} 终止）`}，用时 ${seconds(job.endedAt - job.startedAt)}（${where}）`,
      timeout: () => `超过 ${job.timeoutMs / 1000} 秒仍未结束，已终止整个进程树（${where}）。确实需要更久时用更大的 timeoutSeconds 重新执行。`,
      stopped: () => "已被终止，进程树已结束。",
      denied: () => "用户拒绝执行这条命令。不要重复请求同一条命令；换一种办法，或在回复里说明为什么需要它。",
      expired: () => "等待确认期间云端超过 2 分钟没有继续查询，这条命令已作废，没有执行。仍然需要时重新调用 run_command。",
      failed: () => `无法执行：${job.error}`,
    }[job.state]();
    if (!job.startedAt || job.state === "failed") return `[${job.id}] ${headline}`;

    const from = Math.max(offset, job.dropped);
    let output = job.output.slice(from - job.dropped);
    const notes = [];
    if (offset < job.dropped) notes.push(`（最早的 ${job.dropped - offset} 个字符已丢弃）`);
    if (output.length > reportChars) {
      const tail = reportChars - reportHeadChars;
      const omitted = output.length - reportChars;
      output = `${output.slice(0, reportHeadChars)}\n…[此处省略 ${omitted} 个字符，可用 ${ask({ offset: from + reportHeadChars })} 读取]…\n${output.slice(-tail)}`;
    }
    const body = output || (offset > 0 ? "（没有新的输出）" : "（没有输出）");
    const tail = isFinal(job) ? annex(job) : [];
    return [`[${job.id}] ${headline}`, ...notes, tail.length ? body.trimEnd() : body, ...tail].join("\n");
  }

  return {
    defaultShell,
    shells: Object.fromEntries(Object.entries(shells).map(([name, { label }]) => [name, label])),
    get policy() { return policy; },

    setPolicy(next) {
      policy = next;
      for (const job of jobs.values()) {
        if (job.state !== "awaiting_approval") continue;
        if (next === "allow") start(job);
        if (next === "deny") settle(job, "denied");
      }
    },

    // Either `command` (a line for one of the shells) or `argv` (a program and its arguments, started
    // without a shell). `tool` names the MCP tool the request came through, for the activity feed.
    async request({ command, argv, env, cwd = ".", shell = defaultShell, timeoutSeconds = 600, session, tool = "run_command" }) {
      if (policy === "deny") {
        throw new CommandError("用户已禁用命令执行（命令策略：禁止）。只能使用文件工具；确实需要执行命令时，请在回复里告诉用户。");
      }
      if (argv) {
        shell = directShell;
        command = displayArgv(argv);
      } else if (!shells[shell]) {
        throw new CommandError(`这台电脑不支持 shell "${shell}"，可用：${Object.keys(shells).join("、")}`);
      }
      if (command.length > maxCommandChars) {
        throw new CommandError(`命令有 ${command.length} 个字符，超过 ${maxCommandChars} 的上限。请用 write_file 写成脚本文件再执行`);
      }
      const where = await guard.locate(cwd);
      if (!(await fs.promises.stat(where.abs)).isDirectory()) throw new CommandError(`cwd 不是目录：${where.rel}`);
      const job = {
        id: `c${++counter}`, command, argv, env, shell, cwd: where.abs, cwdRel: where.rel || ".", timeoutMs: timeoutSeconds * 1000, session, tool,
        state: "awaiting_approval", output: "", dropped: 0, requestedAt: Date.now(), polledAt: Date.now(), watchers: 0, wakers: new Set(),
        stdout: { tail: "", chars: 0 }, stderr: { tail: "", chars: 0 },
      };
      jobs.set(job.id, job);
      if (policy === "allow" || alwaysAllowed.has(allowKey(job))) start(job);
      else changed(job);
      return job.id;
    },

    // Waits for the job to finish, up to the wait budget, and returns its status and output as text.
    async report(jobId, { offset = 0, signal } = {}) {
      const job = jobs.get(jobId);
      if (!job) throw new CommandError(`没有编号为 ${jobId} 的命令（可能已结束很久被清理，或服务重启过）`);
      const deadline = Date.now() + waitMs;
      job.watchers++;
      onChange(view(job));
      try {
        while (!isFinal(job) && Date.now() < deadline && !signal?.aborted) {
          await new Promise((resolve) => {
            const done = () => {
              clearTimeout(timer);
              signal?.removeEventListener("abort", done);
              job.wakers.delete(done);
              resolve();
            };
            const timer = setTimeout(done, deadline - Date.now());
            signal?.addEventListener("abort", done, { once: true });
            job.wakers.add(done);
          });
        }
      } finally {
        job.watchers--;
        job.polledAt = Date.now();
        if (job.state === "awaiting_approval") expireLater(job);
        onChange(view(job));
      }
      return describe(job, offset);
    },

    decide(jobId, decision) {
      const job = jobs.get(jobId);
      if (job?.state !== "awaiting_approval") throw new CommandError("这条命令已经不在等待确认");
      if (isStale(job)) {
        settle(job, "expired");
        throw new CommandError("云端已经不再等待这条命令，已作废");
      }
      if (decision === "deny") {
        settle(job, "denied");
        return;
      }
      if (decision === "always") alwaysAllowed.add(allowKey(job));
      start(job);
    },

    stop(jobId) {
      const job = jobs.get(jobId);
      if (!job) throw new CommandError(`没有编号为 ${jobId} 的命令`);
      if (job.state === "awaiting_approval") settle(job, "stopped");
      if (job.state === "running") {
        job.stopRequested = true;
        // No child yet: the project is still being listed for the file-change report.
        if (job.child) killTree(job.child.pid);
        else settle(job, "stopped");
      }
    },

    list: () => [...jobs.values()].map(view),

    shutdown() {
      for (const job of jobs.values()) {
        if (job.state === "running" && job.child) killTree(job.child.pid, true);
      }
    },
  };
}
