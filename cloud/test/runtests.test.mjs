import assert from "node:assert/strict";
import test from "node:test";
import { createProject } from "../src/project/index.mjs";
import { detectTestCommand } from "../src/project/tests.mjs";
import { tempDir, writeTree } from "./helpers.mjs";

async function detect(t, files, options) {
  const root = await tempDir(t);
  await writeTree(root, files);
  return detectTestCommand(root, { platform: "linux", ...options });
}

test("the test command is read off the project files", async (t) => {
  const script = (test) => JSON.stringify({ scripts: { test } });
  const argv = async (files, options) => (await detect(t, files, options))?.argv;

  assert.deepEqual(await argv({ "package.json": script("vitest run") }), ["npm", "test"]);
  assert.deepEqual(await argv({ "package.json": script("vitest run") }, { args: ["-t", "login"] }), ["npm", "test", "--", "-t", "login"]);
  assert.deepEqual(await argv({ "package.json": script("jest"), "pnpm-lock.yaml": "" }, { args: ["a.test.js"] }), ["pnpm", "test", "a.test.js"]);
  assert.deepEqual(await argv({ "package.json": script("jest"), "yarn.lock": "" }), ["yarn", "test"]);
  assert.deepEqual(await argv({ "package.json": script("x"), "bun.lock": "" }), ["bun", "run", "test"]);
  assert.deepEqual(await argv({ "Cargo.toml": "" }), ["cargo", "test"]);
  assert.deepEqual(await argv({ "go.mod": "" }, { args: ["-run", "TestX"] }), ["go", "test", "./...", "-run", "TestX"]);
  assert.deepEqual(await argv({ "App.sln": "" }), ["dotnet", "test"]);
  assert.deepEqual(await argv({ "lib.csproj": "" }), ["dotnet", "test"]);
  assert.deepEqual(await argv({ "pom.xml": "" }), ["mvn", "test"]);
  assert.deepEqual(await argv({ "pom.xml": "", mvnw: "", "mvnw.cmd": "" }), ["./mvnw", "test"]);
  assert.deepEqual(await argv({ "pom.xml": "", mvnw: "", "mvnw.cmd": "" }, { platform: "win32" }), ["mvnw.cmd", "test"]);
  assert.deepEqual(await argv({ "build.gradle.kts": "", gradlew: "", "gradlew.bat": "" }, { platform: "win32" }), ["gradlew.bat", "test"]);
  assert.deepEqual(await argv({ "build.gradle": "" }), ["gradle", "test"]);
  assert.deepEqual(await argv({ "pytest.ini": "" }), ["python3", "-m", "pytest"]);
  assert.deepEqual(await argv({ "pyproject.toml": "[tool.pytest.ini_options]\n" }, { platform: "win32" }), ["python", "-m", "pytest"]);
  assert.deepEqual(await argv({ "tests/test_api.py": "" }, { args: ["-k", "api"] }), ["python3", "-m", "pytest", "-k", "api"]);
  assert.deepEqual(await argv({ Makefile: "build:\n\tcc x.c\ntest: build\n\t./x\n" }), ["make", "test"]);
});

test("a project without a recognisable test setup yields nothing", async (t) => {
  assert.equal(await detect(t, { "README.md": "" }), undefined);
  // The script npm init writes is a placeholder, not a test.
  assert.equal(await detect(t, { "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }), undefined);
  assert.equal(await detect(t, { "package.json": "{ not json" }), undefined);
  assert.equal(await detect(t, { "pyproject.toml": "[project]\nname = 'x'\n", "tests/helper.py": "" }), undefined);
  assert.equal(await detect(t, { Makefile: "build:\n\tcc x.c\n" }), undefined);
  const mixed = await detect(t, { "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }), "go.mod": "" });
  assert.deepEqual([mixed.argv, mixed.source], [["go", "test", "./..."], "go.mod"]);
});

async function project(t, files, options = {}) {
  const root = await tempDir(t);
  await writeTree(root, files);
  const created = await createProject({ root, legacyEncoding: "gbk", consoleEncoding: "gbk", policy: "allow", commandWaitMs: 60_000, ...options });
  t.after(() => created.commands.shutdown());
  return created;
}

const suite = {
  "package.json": JSON.stringify({ scripts: { test: "node run-tests.js" } }),
  "run-tests.js": "console.log('ran with ' + JSON.stringify(process.argv.slice(2))); require('fs').writeFileSync('report.txt', 'ok'); process.exit(process.argv.includes('--fail') ? 2 : 0);",
  "pkg/package.json": JSON.stringify({ scripts: { test: "node -e \"console.log('inner suite')\"" } }),
};

test("run_tests finds the suite, runs it and reports output, exit code and changed files", async (t) => {
  const { tests, commands } = await project(t, suite);
  const passed = await tests.run({ session: "s1" });
  assert.equal(passed.note, "测试命令：npm test（依据 package.json 的 test 脚本（npm））");
  const report = await commands.report(passed.id);
  assert.match(report, /^\[c1\] 已结束，退出码 0，用时 [\d.]+ 秒（直接启动，目录 \.）\n/);
  assert.match(report, /\nran with \[\]\n/);
  assert.match(report, /── 文件变更：新增 1，修改 0，删除 0（.*） ──\n\+ report\.txt$/);
  assert.deepEqual(commands.list().map(({ tool, session, command }) => [tool, session, command]), [["run_tests", "s1", "npm test"]]);

  const failed = await tests.run({ args: ["--fail", "two words"] });
  assert.equal(failed.note, '测试命令：npm test -- --fail "two words"（依据 package.json 的 test 脚本（npm））');
  assert.match(await commands.report(failed.id), /^\[c2\] 已结束，退出码 2，.*\nran with \["--fail","two words"\]\n/s);

  const inner = await tests.run({ cwd: "pkg" });
  assert.match(await commands.report(inner.id), /（直接启动，目录 pkg）\n.*inner suite/s);
});

test("the user's own test command wins over detection", async (t) => {
  const { tests, commands, info } = await project(t, suite, { testCommand: "node run-tests.js custom" });
  const { id, note } = await tests.run({ args: ["--fail"] });
  assert.equal(note, "测试命令：node run-tests.js custom --fail（用户在本地设置里指定）");
  assert.match(await commands.report(id), /退出码 2，.*\nran with \["custom","--fail"\]\n/s);
  assert.match(info(), /测试命令：node run-tests\.js custom（用户指定）/);
});

test("run_tests explains what to do when nothing is recognised, and obeys the command policy", async (t) => {
  const bare = await project(t, { "notes.txt": "" });
  await assert.rejects(bare.tests.run({}), /没有识别出测试命令.*填写测试命令/);
  await assert.rejects(bare.tests.run({ cwd: "notes.txt" }), /cwd 不是目录/);
  await assert.rejects(bare.tests.run({ cwd: ".." }), /项目根目录之外/);

  const asking = await project(t, suite, { policy: "ask", approvalPlace: "插件界面" });
  const { id } = await asking.tests.run({});
  assert.match(await asking.commands.report(id, { signal: AbortSignal.abort() }), /^\[c1\] 等待用户在插件界面确认这条命令/);
  assert.match(asking.info(), /命令策略：每次确认（每条命令都要用户在插件界面批准）/);
  asking.commands.decide(id, "deny");
  assert.match(await asking.commands.report(id), /用户拒绝执行/);

  const denied = await project(t, suite, { policy: "deny" });
  await assert.rejects(denied.tests.run({}), /用户已禁用命令执行/);
});

test("run_program goes through the same job machinery", async (t) => {
  const { programs, commands } = await project(t, suite);
  const id = await programs.run({ program: process.execPath, args: ["run-tests.js", "a b"], session: "s2" });
  assert.match(await commands.report(id), /退出码 0，.*\nran with \["a b"\]\n/s);
  assert.deepEqual(commands.list().map(({ tool, session }) => [tool, session]), [["run_program", "s2"]]);
});
