import assert from "node:assert/strict";
import nodePath from "node:path";
import test from "node:test";
import { createCommandRunner } from "../src/project/commands.mjs";
import { createPathGuard } from "../src/project/paths.mjs";
import { cmdLine, displayArgv, programLaunch, resolveWindowsProgram } from "../src/project/programs.mjs";
import { tempDir, windows, writeTree } from "./helpers.mjs";

const awkward = ["a b", 'q"uote', "back\\slash\\", "&|<>^", "100%", "(x);y,z", "中文 参数", ""];

async function setup(t, options = {}) {
  const root = await tempDir(t);
  await writeTree(root, {
    "argv.js": "console.log(JSON.stringify(process.argv.slice(2)));",
    "exit.js": "console.error('failing'); process.exit(Number(process.argv[2]));",
    "sub/.keep": "",
  });
  const runner = createCommandRunner({ guard: await createPathGuard(root), consoleEncoding: "gbk", policy: "allow", waitMs: 20_000, ...options });
  t.after(() => runner.shutdown());
  const run = async (argv, args = {}) => runner.report(await runner.request({ argv, ...args }));
  return { root, runner, run };
}

test("an argument list is shown with quotes only where they are needed", () => {
  assert.equal(displayArgv(["npm", "run", "build"]), "npm run build");
  assert.equal(displayArgv(["node", "a b.js", 'say "hi"', "C:\\dir\\x.js", "C:\\Program Files\\x.exe", ""]), 'node "a b.js" "say \\"hi\\"" C:\\dir\\x.js "C:\\Program Files\\x.exe" ""');
});

test("Windows program lookup follows PATHEXT, working directory first", () => {
  // The Windows file system ignores case, and PATHEXT is upper case by default.
  const files = new Set(["c:\\proj\\tool.cmd", "c:\\bin\\tool.exe", "c:\\bin\\npm.cmd", "c:\\bin\\npm", "c:\\proj\\scripts\\build.bat", "c:\\other\\python.exe"]);
  const env = { PATH: "C:\\bin;C:\\other", PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  const find = (program) => resolveWindowsProgram(program, "C:\\proj", env, (file) => files.has(file.toLowerCase()))?.toLowerCase();

  assert.equal(find("tool"), "c:\\proj\\tool.cmd");
  assert.equal(find("tool.exe"), "c:\\bin\\tool.exe");
  // The extensionless npm file is a shell script for other systems and cannot be started.
  assert.equal(find("npm"), "c:\\bin\\npm.cmd");
  assert.equal(find("python"), "c:\\other\\python.exe");
  assert.equal(find("scripts/build"), "c:\\proj\\scripts\\build.bat");
  assert.equal(find(".\\scripts\\build.bat"), "c:\\proj\\scripts\\build.bat");
  assert.equal(find("C:\\other\\python.exe"), "c:\\other\\python.exe");
  assert.equal(find("missing"), undefined);
  assert.equal(find("scripts/missing"), undefined);
});

test("a batch file is started through cmd.exe with every metacharacter escaped", () => {
  assert.equal(
    cmdLine("C:\\Program Files\\nodejs\\npm.cmd", ["run", "a b", 'say "hi"', "a&b", "100%", "tail\\"]),
    'C:\\Program^ Files\\nodejs\\npm.cmd ^"run^" ^"a^ b^" ^"say^ \\^"hi\\^"^" ^"a^&b^" ^"100^%^" ^"tail\\\\^"',
  );
  // Shims in node_modules/.bin hand their arguments to cmd.exe once more.
  assert.equal(cmdLine("C:\\p\\node_modules\\.bin\\eslint.cmd", ["a&b"]), 'C:\\p\\node_modules\\.bin\\eslint.cmd ^^^"a^^^&b^^^"');

  const exists = (file) => ["c:\\bin\\npm.cmd", "c:\\bin\\node.exe"].includes(file.toLowerCase());
  const options = { platform: "win32", cwd: "C:\\proj", env: { PATH: "C:\\bin", ComSpec: "C:\\Windows\\cmd.exe" }, exists };
  assert.deepEqual(programLaunch(["npm", "test"], options), [
    "C:\\Windows\\cmd.exe", ["/d", "/s", "/c", '"C:\\bin\\npm.CMD ^"test^""'], { windowsVerbatimArguments: true },
  ]);
  assert.deepEqual(programLaunch(["node", "a b.js"], options), ["C:\\bin\\node.EXE", ["a b.js"], {}]);
  assert.throws(() => programLaunch(["nope"], options), /找不到程序 nope/);
  assert.deepEqual(programLaunch(["./run.sh", "x"], { platform: "linux", cwd: "/p" }), ["./run.sh", ["x"], { detached: true }]);
});

test("a program gets its arguments exactly as given, with no shell in between", async (t) => {
  const { run, runner } = await setup(t);
  const report = await run([process.execPath, "argv.js", ...awkward, "$HOME", "%PATH%", "`echo x`", "$(echo y)", "*.js"]);
  assert.match(report, /^\[c1\] 已结束，退出码 0，用时 [\d.]+ 秒（直接启动，目录 \.）\n/);
  assert.deepEqual(JSON.parse(report.split("\n")[1]), [...awkward, "$HOME", "%PATH%", "`echo x`", "$(echo y)", "*.js"]);
  assert.equal(runner.list()[0].shell, "direct");
  assert.equal(runner.list()[0].tool, "run_command");

  const failed = await run([process.execPath, "../exit.js", "7"], { cwd: "sub" });
  assert.match(failed, /^\[c2\] 已结束，退出码 7，/);
  assert.match(failed, /以上输出全部来自 stderr/);
});

test("extra environment variables reach the program, the bridge token does not", async (t) => {
  const { run } = await setup(t);
  process.env.CLOUD_BRIDGE_TOKEN = "secret-token-value";
  t.after(() => { delete process.env.CLOUD_BRIDGE_TOKEN; });
  const script = "console.log([process.env.FOO, process.env.CLOUD_BRIDGE_TOKEN ?? 'unset'].join(' '))";
  assert.match(await run([process.execPath, "-e", script], { env: { FOO: "中文 bar" } }), /\n中文 bar unset\n$/);
});

test("a program that does not exist is reported, not thrown", async (t) => {
  const { run } = await setup(t);
  assert.match(await run(["no-such-program-for-test"]), /^\[c1\] 无法执行：找不到程序 no-such-program-for-test/);
});

test("the approval for a program is remembered per argument list", async (t) => {
  const { runner } = await setup(t, { policy: "ask" });
  const first = await runner.request({ argv: [process.execPath, "argv.js", "one"] });
  assert.equal(runner.list()[0].command, `${displayArgv([process.execPath])} argv.js one`);
  runner.decide(first, "always");
  assert.match(await runner.report(first), /已结束，退出码 0/);
  const again = await runner.request({ argv: [process.execPath, "argv.js", "one"] });
  assert.match(await runner.report(again), /已结束，退出码 0/);
  const other = await runner.request({ argv: [process.execPath, "argv.js", "two"] });
  assert.equal(runner.list().find((job) => job.id === other).state, "awaiting_approval");
  runner.stop(other);
});

test("npm starts by name on every platform", async (t) => {
  const { run } = await setup(t);
  assert.match(await run(["npm", "--version"]), /已结束，退出码 0，.*\n\d+\.\d+\.\d+/s);
});

test("a batch shim receives awkward arguments intact", { skip: !windows }, async (t) => {
  const { root, run } = await setup(t);
  await writeTree(root, {
    "shim.cmd": `@echo off\r\n"${process.execPath}" "%~dp0argv.js" %*\r\n`,
    "node_modules/.bin/tool.cmd": `@echo off\r\n"${process.execPath}" "%~dp0..\\..\\argv.js" %*\r\n`,
  });
  // Percent signs and carets are where batch files are lossy by design; everything else must survive.
  const safe = ["a b", 'q"uote', "back\\slash\\", "&|<>", "(x);y,z", "中文 参数"];
  const report = await run(["shim", ...safe]);
  assert.match(report, /^\[c1\] 已结束，退出码 0，/);
  assert.deepEqual(JSON.parse(report.split("\n")[1]), safe);
  const nested = await run([nodePath.join("node_modules", ".bin", "tool"), ...safe]);
  assert.deepEqual(JSON.parse(nested.split("\n")[1]), safe);
});
