import assert from "node:assert/strict";
import fs from "node:fs/promises";
import nodePath from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createCommandRunner } from "../src/project/commands.mjs";
import { createPathGuard } from "../src/project/paths.mjs";
import { tempDir, windows, writeTree } from "./helpers.mjs";

// Small Node scripts behave the same under bash, PowerShell and cmd, with no quoting differences.
const scripts = {
  "echo.js": "console.log('out ' + process.argv[2]); console.error('err ' + process.argv[2]); process.exit(Number(process.argv[3] ?? 0));",
  "encodings.js": "process.stdout.write(Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0d, 0x0a])); process.stdout.write('utf8 中文\\r\\n10%\\r100%\\n');",
  "ticks.js": "let n = 0; const timer = setInterval(() => { console.log('tick ' + ++n); if (n === Number(process.argv[2])) clearInterval(timer); }, 100);",
  "prompt.js": "process.stdout.write('continue? [y/N] '); setTimeout(() => {}, 20000);",
  "big.js": "for (let i = 1; i <= 20000; i++) console.log('line ' + i);",
  "cwd.js": "console.log(process.cwd());",
  "env.js": "console.log('token=' + (process.env.CLOUD_BRIDGE_TOKEN ?? 'unset'));",
  "sleeper.js": "require('fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 60000);",
  "tree.js": [
    "const { spawn } = require('child_process');",
    "require('fs').writeFileSync('parent.pid', String(process.pid));",
    "spawn(process.execPath, ['sleeper.js', 'child.pid'], { stdio: 'inherit' });",
    "setTimeout(() => {}, 60000);",
  ].join("\n"),
  "sub/.keep": "",
};

async function setup(t, options = {}) {
  const root = await tempDir(t);
  await writeTree(root, scripts);
  const changes = [];
  const runner = createCommandRunner({
    guard: await createPathGuard(root), consoleEncoding: "gbk", policy: "allow", waitMs: 20_000,
    onChange: (job) => changes.push(job), ...options,
  });
  t.after(() => runner.shutdown());
  const run = async (command, args = {}) => runner.report(await runner.request({ command, ...args }));
  return { root, runner, run, changes };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function pidFrom(root, name) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const text = await fs.readFile(nodePath.join(root, name), "utf8").catch(() => "");
    if (text) return Number(text);
    await sleep(100);
  }
  throw new Error(`${name} was never written`);
}

async function gone(pid) {
  for (let attempt = 0; attempt < 50 && alive(pid); attempt++) await sleep(100);
  return !alive(pid);
}

test("a command returns its output and exit code", async (t) => {
  const { root, run, runner } = await setup(t);
  const ok = await run("node echo.js hello");
  assert.match(ok, /^\[c1\] 已结束，退出码 0，用时 [\d.]+ 秒（\w+，目录 \.）\n/);
  assert.match(ok, /^out hello$/m);
  assert.match(ok, /^err hello$/m);
  assert.match(await run("node echo.js bye 3"), /^\[c2\] 已结束，退出码 3，/);

  assert.match(await run("node ../cwd.js", { cwd: "sub" }), new RegExp(`${nodePath.join(root, "sub").replaceAll("\\", "\\\\")}\\s*$`));
  await assert.rejects(runner.request({ command: "node cwd.js", cwd: ".." }), /项目根目录之外/);
  await assert.rejects(runner.request({ command: "node cwd.js", cwd: "echo.js" }), /cwd 不是目录/);
  await assert.rejects(runner.request({ command: "x", shell: "fish" }), /不支持 shell "fish"/);
  await assert.rejects(runner.request({ command: "x".repeat(9000) }), /超过 8000 的上限/);
  await assert.rejects(runner.report("c99"), /没有编号为 c99 的命令/);
});

test("output is decoded line by line and the bridge token is not inherited", async (t) => {
  process.env.CLOUD_BRIDGE_TOKEN = "secret-for-test";
  t.after(() => { delete process.env.CLOUD_BRIDGE_TOKEN; });
  const { run } = await setup(t);
  assert.match(await run("node encodings.js"), /\n中文\nutf8 中文\n100%\n$/);
  assert.match(await run("node env.js"), /\ntoken=unset\n$/);
});

test("a slow command reports progress and can be polled from an offset", async (t) => {
  const { runner, changes } = await setup(t, { waitMs: 450 });
  const id = await runner.request({ command: "node ticks.js 12" });
  const first = await runner.report(id);
  assert.match(first, /^\[c1\] 仍在运行，已 [\d.]+ 秒/);
  const offset = Number(/command_status\(\{"jobId":"c1","offset":(\d+)\}\)/.exec(first)[1]);
  let rest = "";
  for (let next = offset, state = "running"; state === "running";) {
    const report = await runner.report(id, { offset: next });
    state = report.startsWith("[c1] 仍在运行") ? "running" : "done";
    rest += report.split("\n").slice(1).join("\n");
    next = Number(/"offset":(\d+)/.exec(report)?.[1] ?? next);
  }
  const seen = `${first}\n${rest}`.match(/tick \d+/g);
  assert.deepEqual(seen, Array.from({ length: 12 }, (_, index) => `tick ${index + 1}`));
  assert.match(await runner.report(id, { offset: 10_000 }), /已结束，退出码 0.*\n（没有新的输出）$/);
  assert.equal(changes.at(-1).state, "exited");
  assert.match(changes.at(-1).outputTail, /tick 12\n$/);
});

test("a prompt without a trailing newline becomes visible", async (t) => {
  const { runner } = await setup(t, { waitMs: 1000 });
  const id = await runner.request({ command: "node prompt.js" });
  let report = await runner.report(id);
  // A cold PowerShell start on Windows can take several seconds.
  for (let attempt = 0; attempt < 15 && !report.includes("continue?"); attempt++) report = await runner.report(id);
  assert.match(report, /仍在运行.*\ncontinue\? \[y\/N\] $/s);
  runner.stop(id);
  assert.match(await runner.report(id), /^\[c1\] 已被终止/);
});

test("long output keeps its head and tail", async (t) => {
  const { run, runner } = await setup(t);
  const report = await run("node big.js");
  assert.ok(report.length < 31_000);
  assert.match(report, /\nline 1\nline 2\n/);
  assert.match(report, /\nline 20000\n$/);
  const omitted = /此处省略 (\d+) 个字符，可用 command_status\(\{"jobId":"c1","offset":(\d+)\}\) 读取/.exec(report);
  assert.ok(Number(omitted[1]) > 100_000);
  assert.match(await runner.report("c1", { offset: Number(omitted[2]) }), /^\[c1\] 已结束.*\n.*line \d+\n/s);
});

test("timeout kills the whole process tree", async (t) => {
  const { root, runner } = await setup(t);
  // Long enough for a cold PowerShell start on Windows to get both processes running first.
  const timeoutSeconds = windows ? 10 : 3;
  const id = await runner.request({ command: "node tree.js", timeoutSeconds });
  const [parent, child] = [await pidFrom(root, "parent.pid"), await pidFrom(root, "child.pid")];
  assert.ok(alive(parent) && alive(child));
  assert.match(await runner.report(id), new RegExp(`^\\[c1\\] 超过 ${timeoutSeconds} 秒仍未结束，已终止整个进程树`));
  assert.ok(await gone(parent), "parent process still alive");
  assert.ok(await gone(child), "grandchild process still alive");
});

test("stop_command and shutdown kill the whole process tree", async (t) => {
  const { root, runner } = await setup(t, { waitMs: 10_000 });
  const id = await runner.request({ command: "node tree.js" });
  const [parent, child] = [await pidFrom(root, "parent.pid"), await pidFrom(root, "child.pid")];
  runner.stop(id);
  assert.match(await runner.report(id), /^\[c1\] 已被终止/);
  assert.ok(await gone(parent) && await gone(child));

  await fs.rm(nodePath.join(root, "child.pid"));
  await runner.request({ command: "node sleeper.js child.pid" });
  const sleeper = await pidFrom(root, "child.pid");
  runner.shutdown();
  assert.ok(await gone(sleeper));
});

test("policy ask: a command waits for the user's decision", async (t) => {
  const { runner, changes } = await setup(t, { policy: "ask", waitMs: 300 });
  const id = await runner.request({ command: "node echo.js asked", session: "s1" });
  assert.match(await runner.report(id), /^\[c1\] 等待用户在网页控制台确认这条命令.*command_status\(\{"jobId":"c1"\}\)/);
  assert.deepEqual(runner.list().map(({ id, state, session }) => ({ id, state, session })), [{ id: "c1", state: "awaiting_approval", session: "s1" }]);
  assert.equal(changes.some((job) => job.state === "running"), false);

  runner.decide(id, "allow");
  let report = await runner.report(id);
  while (report.includes("仍在运行")) report = await runner.report(id);
  assert.match(report, /已结束，退出码 0.*\nout asked\n/s);
  assert.throws(() => runner.decide(id, "allow"), /已经不在等待确认/);

  const denied = await runner.request({ command: "node echo.js denied" });
  const pending = runner.report(denied);
  runner.decide(denied, "deny");
  assert.match(await pending, /^\[c2\] 用户拒绝执行这条命令/);

  // "always" remembers the exact command for the rest of this run only.
  const remembered = await runner.request({ command: "node echo.js again" });
  runner.decide(remembered, "always");
  await runner.report(remembered);
  const repeat = await runner.request({ command: "node echo.js again" });
  assert.notEqual(runner.list().find((job) => job.id === repeat).state, "awaiting_approval");
  const different = await runner.request({ command: "node echo.js again 1" });
  assert.equal(runner.list().find((job) => job.id === different).state, "awaiting_approval");
  runner.stop(different);
  assert.match(await runner.report(different), /已被终止/);
});

test("policy changes apply to pending approvals", async (t) => {
  const { runner } = await setup(t, { policy: "ask", waitMs: 5000 });
  const first = await runner.request({ command: "node echo.js one" });
  runner.setPolicy("allow");
  assert.match(await runner.report(first), /已结束，退出码 0/);
  assert.match(await runner.report(await runner.request({ command: "node echo.js two" })), /已结束，退出码 0/);

  runner.setPolicy("ask");
  const second = await runner.request({ command: "node echo.js three" });
  runner.setPolicy("deny");
  assert.match(await runner.report(second), /用户拒绝执行/);
  await assert.rejects(runner.request({ command: "node echo.js four" }), /用户已禁用命令执行/);
  assert.equal(runner.policy, "deny");
});

test("an approval nobody is waiting for expires instead of running later", async (t) => {
  const { runner } = await setup(t, { policy: "ask", waitMs: 100, approvalStaleMs: 300 });
  const id = await runner.request({ command: "node echo.js late" });
  await runner.report(id);
  await sleep(500);
  assert.throws(() => runner.decide(id, "allow"), /云端已经不再等待这条命令/);
  assert.match(await runner.report(id), /^\[c1\] 等待确认期间.*没有执行/);
});

test("Windows: PowerShell and cmd run with correct exit codes and code pages", { skip: !windows }, async (t) => {
  const { run, runner } = await setup(t);
  assert.deepEqual(Object.keys(runner.shells), ["powershell", "cmd"]);
  assert.equal(runner.defaultShell, "powershell");

  assert.match(await run("Write-Output ('a' + 'b'); Write-Output \"it's `\"quoted`\" & | < > % !\""), /\nab\nit's "quoted" & \| < > % !\n$/);
  assert.match(await run("cmd /c exit 3"), /退出码 3，/);
  assert.match(await run("exit 7"), /退出码 7，/);
  assert.match(await run("Get-Item C:\\no-such-path-for-test"), /退出码 1，/);
  assert.match(await run("cmd /c exit 3; Write-Output 'after'"), /退出码 0，.*\nafter\n$/s);
  assert.match(await run("node echo.js ps 4"), /退出码 4，.*\nout ps\n/s);
  assert.doesNotMatch(await run("Write-Progress -Activity 'working' -Status 'x'; Write-Output done"), /CLIXML/);

  // Console programs on Chinese Windows write GBK; PowerShell writes whatever [Console]::OutputEncoding says.
  assert.match(await run("[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936); Write-Output '中文输出，标点。'"), /\n中文输出，标点。\n$/);
  assert.match(await run("[Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output '中文输出 ✓'"), /\n中文输出 ✓\n$/);
  // cmd picks its output code page when it starts, so the inner cmd is the one that behaves like a Chinese system.
  assert.match(await run("chcp 936 >nul & cmd /d /c echo 中文输出", { shell: "cmd" }), /\n中文输出\n$/);

  assert.match(await run("echo one&& echo two", { shell: "cmd" }), /\none\ntwo\n$/);
  assert.match(await run("exit /b 5", { shell: "cmd" }), /退出码 5，.*（cmd，目录 \.）/s);
  assert.match(await run("echo \"quoted\" ^& 100%", { shell: "cmd" }), /\n"quoted" & 100%\n$/);
  assert.match(await run("cd", { shell: "cmd", cwd: "sub" }), /\\sub\n$/);
});
