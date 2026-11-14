import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import nodePath from "node:path";
import test from "node:test";
import { createChangeTracker, formatChanges } from "../src/project/changes.mjs";
import { createProject } from "../src/project/index.mjs";
import { createPathGuard } from "../src/project/paths.mjs";
import { createSearchTools } from "../src/project/search.mjs";
import { tempDir, writeTree } from "./helpers.mjs";

const scripts = {
  "touch.js": [
    "const fs = require('fs');",
    "fs.writeFileSync('made.txt', 'new');",
    "fs.appendFileSync('kept.txt', ' and more');",
    "fs.rmSync('doomed.txt');",
    "fs.mkdirSync('node_modules/pkg', { recursive: true });",
    "fs.writeFileSync('node_modules/pkg/index.js', '');",
    "fs.writeFileSync('ignored.log', 'noise');",
    "console.log('touched');",
  ].join("\n"),
  "both.js": "console.log('to stdout'); console.error('to stderr'); process.exit(Number(process.argv[2] ?? 0));",
  "quiet.js": "",
  "kept.txt": "kept",
  "doomed.txt": "bye",
  ".gitignore": "*.log\nnode_modules/\n",
};

async function tracked(t) {
  const root = await tempDir(t);
  await writeTree(root, scripts);
  const guard = await createPathGuard(root);
  const tracker = createChangeTracker({ root, listFiles: createSearchTools({ guard, legacyEncoding: "gbk" }).listFiles });
  return { root, tracker };
}

async function project(t, options = {}) {
  const root = await tempDir(t);
  await writeTree(root, scripts);
  const jobs = [];
  const created = await createProject({
    root, legacyEncoding: "gbk", consoleEncoding: "gbk", policy: "allow", commandWaitMs: 20_000, onJobChange: (job) => jobs.push(job), ...options,
  });
  t.after(() => created.commands.shutdown());
  const run = async (command) => created.commands.report(await created.commands.request({ command }));
  return { root, run, jobs, commands: created.commands };
}

test("two listings of the project tell which files were added, modified and deleted", async (t) => {
  const { root, tracker } = await tracked(t);
  const before = await tracker.snapshot();
  await fs.writeFile(nodePath.join(root, "made.txt"), "new");
  await fs.appendFile(nodePath.join(root, "kept.txt"), " and more");
  await fs.rm(nodePath.join(root, "doomed.txt"));
  await fs.mkdir(nodePath.join(root, "node_modules"));
  await fs.writeFile(nodePath.join(root, "node_modules", "x.js"), "");
  const changes = tracker.diff(before, await tracker.snapshot());
  assert.deepEqual(changes, { added: ["made.txt"], modified: ["kept.txt"], deleted: ["doomed.txt"] });
  assert.equal(formatChanges(changes), "+ made.txt\n~ kept.txt\n- doomed.txt");
  assert.deepEqual(tracker.diff(before, before), { added: [], modified: [], deleted: [] });
  assert.match(formatChanges(tracker.diff(undefined, before)), /没有统计文件变更/);
});

test("in a git work tree, ignored files are not counted as changes", async (t) => {
  const { root, tracker } = await tracked(t);
  execFileSync("git", ["init", "-q"], { cwd: root });
  const before = await tracker.snapshot();
  await fs.writeFile(nodePath.join(root, "debug.log"), "noise");
  await fs.writeFile(nodePath.join(root, "src.js"), "code");
  assert.deepEqual(tracker.diff(before, await tracker.snapshot()), { added: ["src.js"], modified: [], deleted: [] });
});

test("a finished command reports the files it touched", async (t) => {
  const { root, run, jobs } = await project(t);
  execFileSync("git", ["init", "-q"], { cwd: root });
  const report = await run("node touch.js");
  assert.match(report, /^\[c1\] 已结束，退出码 0，用时 [\d.]+ 秒/);
  assert.match(report, /\ntouched\n── 文件变更：新增 1，修改 1，删除 1（.*） ──\n\+ made\.txt\n~ kept\.txt\n- doomed\.txt$/);
  assert.deepEqual(jobs.at(-1).changes, { added: ["made.txt"], modified: ["kept.txt"], deleted: ["doomed.txt"] });

  const untouched = await run("node quiet.js");
  assert.match(untouched, /^\[c2\] 已结束，退出码 0，.*\n（没有输出）$/);
  assert.deepEqual(jobs.at(-1).changes, { added: [], modified: [], deleted: [] });
});

test("file changes are left out when tracking is switched off", async (t) => {
  const { run, jobs } = await project(t, { trackChanges: false });
  assert.match(await run("node touch.js"), /\ntouched\n$/);
  assert.equal(jobs.at(-1).changes, undefined);
});

test("stderr is listed on its own below the merged output", async (t) => {
  const { run, jobs } = await project(t);
  const both = await run("node both.js 3");
  assert.match(both, /^\[c1\] 已结束，退出码 3，/);
  assert.match(both, /\nto stdout\n/);
  assert.match(both, /\n── stderr 部分（共 10 个字符；上面的输出按时间合并了 stdout 和 stderr） ──\nto stderr$/);
  const view = jobs.at(-1);
  assert.deepEqual([view.exitCode, view.stdoutTail, view.stderrTail, view.stdoutChars, view.stderrChars], [3, "to stdout\n", "to stderr\n", 10, 10]);
  assert.match(view.outputTail, /to stdout/);
  assert.match(view.outputTail, /to stderr/);

  const onlyErr = await run("node -e \"console.error('oops')\"");
  assert.match(onlyErr, /\noops\n── 以上输出全部来自 stderr，stdout 为空 ──$/);
  const onlyOut = await run("node -e \"console.log('fine')\"");
  assert.match(onlyOut, /\nfine\n$/);
});

test("a command stopped while the project is still being listed never starts", async (t) => {
  const { root, commands } = await project(t);
  const id = await commands.request({ command: "node touch.js" });
  commands.stop(id);
  assert.match(await commands.report(id), /^\[c1\] 已被终止/);
  assert.equal(await fs.readFile(nodePath.join(root, "kept.txt"), "utf8"), "kept");
});
