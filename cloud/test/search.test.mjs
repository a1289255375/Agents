import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import nodePath from "node:path";
import test from "node:test";
import { createPathGuard } from "../src/project/paths.mjs";
import { createSearchTools, globToRegExp } from "../src/project/search.mjs";
import { encodeText } from "../src/project/text.mjs";
import { tempDir, trySymlink, windows, writeTree } from "./helpers.mjs";

const tree = {
  "src/app.js": "const greeting = 'hello';\nfunction main() {\n  return greeting;\n}\n",
  "src/util/helper.ts": "export const helper = () => 'Hello';\n",
  "src/中文.txt": "第一行\r\n包含 关键字 的行\r\n第三行\r\n",
  "legacy/gbk.txt": encodeText("旧文件\r\n这里也有 关键字\r\n", "gbk"),
  "docs/readme.md": "# Title\nhello world\n",
  "node_modules/pkg/index.js": "module.exports = 'hello';\n",
  "build/out.js": "var hello;\n",
  "image.bin": Buffer.from([0, 1, 2, 104, 101, 108, 108, 111]),
  ".gitignore": "build/\nnode_modules/\n",
};

async function setup(t, { git = false } = {}) {
  const root = await tempDir(t);
  await writeTree(root, tree);
  if (git) execFileSync("git", ["init", "-q"], { cwd: root });
  const guard = await createPathGuard(root);
  return { root, tools: createSearchTools({ guard, legacyEncoding: "gbk" }) };
}

test("globs translate to path matchers", () => {
  const matches = (glob, path, ignoreCase) => globToRegExp(glob, ignoreCase).test(path);
  assert.ok(matches("*.js", "src/app.js"));
  assert.ok(matches("*.js", "app.js"));
  assert.ok(!matches("*.js", "src/app.jsx"));
  assert.ok(matches("src/*.js", "src/app.js"));
  assert.ok(!matches("src/*.js", "src/util/x.js"));
  assert.ok(matches("src/**/*.ts", "src/util/helper.ts"));
  assert.ok(matches("src/**/*.ts", "src/helper.ts"));
  assert.ok(matches("**/util/**", "src/util/deep/x.ts"));
  assert.ok(matches("*.{js,ts}", "src/util/helper.ts"));
  assert.ok(!matches("*.{js,ts}", "docs/readme.md"));
  assert.ok(matches("file?.txt", "file1.txt"));
  assert.ok(!matches("file?.txt", "file12.txt"));
  assert.ok(matches("[a-c]*.md", "docs/build.md"));
  assert.ok(!matches("[!a-c]*.md", "docs/build.md"));
  assert.ok(matches("src\\util\\*.ts", "src/util/helper.ts"));
  assert.ok(matches("./src/app.js", "src/app.js"));
  assert.ok(matches("a+b(1).txt", "a+b(1).txt"));
  assert.ok(!matches("README.md", "readme.md"));
  assert.ok(matches("README.md", "docs/readme.md", true));
});

for (const git of [false, true]) {
  const mode = git ? "git work tree" : "plain directory";

  test(`find_files in a ${mode}`, async (t) => {
    const { root, tools } = await setup(t, { git });
    const now = Date.now() / 1000;
    await fs.utimes(nodePath.join(root, "build/out.js"), now - 200, now - 200);
    await fs.utimes(nodePath.join(root, "src/app.js"), now - 100, now - 100);
    await fs.utimes(nodePath.join(root, "src/util/helper.ts"), now, now);

    // node_modules is skipped either way; build/ is skipped only where .gitignore is honoured.
    const found = await tools.findFiles({ pattern: "*.{js,ts}" });
    assert.equal(found.text, [
      `找到 ${git ? 2 : 3} 个文件（按修改时间从新到旧）：`, "src/util/helper.ts", "src/app.js", ...(git ? [] : ["build/out.js"]),
    ].join("\n"));

    assert.equal((await tools.findFiles({ pattern: "*.ts", path: "src" })).text, "找到 1 个文件（按修改时间从新到旧）：\nsrc/util/helper.ts");
    assert.equal((await tools.findFiles({ pattern: "util/*.ts", path: "src" })).text, "找到 1 个文件（按修改时间从新到旧）：\nsrc/util/helper.ts");
    assert.match((await tools.findFiles({ pattern: "*.py" })).text, /^没有匹配 \*\.py 的文件/);
    assert.match((await tools.findFiles({ pattern: "*.js", includeIgnored: true })).text, /node_modules\/pkg\/index\.js/);
    assert.match((await tools.findFiles({ pattern: "*", limit: 2 })).text, /……另有 \d+ 个未显示/);
    await assert.rejects(tools.findFiles({ pattern: "*", path: "../.." }), /项目根目录之外/);
  });

  test(`search_text in a ${mode}`, async (t) => {
    const { tools } = await setup(t, { git });

    const hello = (await tools.searchText({ pattern: "hello" })).text;
    assert.match(hello, /^docs\/readme\.md\n {2}2:hello world$/m);
    assert.match(hello, /^src\/app\.js\n {2}1:const greeting = 'hello';$/m);
    assert.doesNotMatch(hello, /node_modules|image\.bin|helper\.ts/);
    assert.equal(/build\/out\.js/.test(hello), !git);
    assert.match(hello, /跳过 1 个二进制/);

    assert.match((await tools.searchText({ pattern: "hello", ignoreCase: true })).text, /src\/util\/helper\.ts\n {2}1:export const helper/);
    const keyword = (await tools.searchText({ pattern: "关键字" })).text;
    assert.match(keyword, /legacy\/gbk\.txt\n {2}2:这里也有 关键字/);
    assert.match(keyword, /src\/中文\.txt\n {2}2:包含 关键字 的行/);
    assert.match(keyword, /2 处匹配，2 个文件/);

    assert.equal((await tools.searchText({ pattern: "return", path: "src/app.js", context: 1 })).text,
      "src/app.js\n  2-function main() {\n  3:  return greeting;\n  4-}\n\n1 处匹配，1 个文件");
    assert.match((await tools.searchText({ pattern: "hello", glob: "*.md" })).text, /1 处匹配，1 个文件/);
    assert.match((await tools.searchText({ pattern: "main()", literal: true })).text, /src\/app\.js\n {2}2:function main\(\) \{/);
    assert.match((await tools.searchText({ pattern: "^function \\w+\\(" })).text, /2:function main/);
    assert.match((await tools.searchText({ pattern: "zzz-not-there" })).text, /^0 处匹配，0 个文件；.*共检查 \d+ 个文件/);
    assert.match((await tools.searchText({ pattern: "hello", includeIgnored: true })).text, /node_modules\/pkg\/index\.js/);
    assert.match((await tools.searchText({ pattern: "e", limit: 3 })).text, /3 处匹配.*已达到 limit=3/);
    await assert.rejects(tools.searchText({ pattern: "(" }), /正则表达式无效/);
  });
}

test("search clips very long lines around the match", async (t) => {
  const root = await tempDir(t);
  await writeTree(root, { "min.js": `${"a".repeat(1000)}NEEDLE${"b".repeat(1000)}\n` });
  const tools = createSearchTools({ guard: await createPathGuard(root), legacyEncoding: "gbk" });
  const line = (await tools.searchText({ pattern: "NEEDLE" })).text.split("\n")[1];
  assert.ok(line.length < 320);
  assert.match(line, /^ {2}1:…a+NEEDLEb+…$/);
});

test("search does not follow links out of the project", async (t) => {
  const base = await tempDir(t);
  await writeTree(base, { "project/a.txt": "inside secret\n", "outside/b.txt": "outside secret\n" });
  await fs.symlink(nodePath.join(base, "outside"), nodePath.join(base, "project", "link"), windows ? "junction" : "dir");
  const tools = createSearchTools({ guard: await createPathGuard(nodePath.join(base, "project")), legacyEncoding: "gbk" });
  const found = (await tools.searchText({ pattern: "secret", includeIgnored: true })).text;
  assert.match(found, /a\.txt/);
  assert.doesNotMatch(found, /b\.txt/);
  assert.doesNotMatch((await tools.findFiles({ pattern: "*.txt", includeIgnored: true })).text, /b\.txt/);
  await assert.rejects(tools.searchText({ pattern: "secret", path: "link" }), /指向项目根目录之外/);

  // Git for Windows lists the files behind a junction as if they were in the project.
  execFileSync("git", ["init", "-q"], { cwd: nodePath.join(base, "project") });
  const viaGit = (await tools.searchText({ pattern: "secret" })).text;
  assert.match(viaGit, /a\.txt/);
  assert.doesNotMatch(viaGit, /b\.txt|outside secret/);
  assert.doesNotMatch((await tools.findFiles({ pattern: "*.txt" })).text, /b\.txt/);

  // git lists a link to a file like any other file; its target must still not be read.
  if (await trySymlink(t, nodePath.join(base, "outside", "b.txt"), nodePath.join(base, "project", "leak.txt"), "file")) {
    const withLink = (await tools.searchText({ pattern: "secret" })).text;
    assert.match(withLink, /a\.txt/);
    assert.doesNotMatch(withLink, /outside secret/);
    await assert.rejects(tools.searchText({ pattern: "secret", path: "leak.txt" }), /指向项目根目录之外/);
  }

  // A junction that stays inside the project is searched like any directory.
  await writeTree(base, { "project/real/c.txt": "nested secret\n" });
  await fs.symlink(nodePath.join(base, "project", "real"), nodePath.join(base, "project", "alias"), windows ? "junction" : "dir");
  const nested = (await tools.searchText({ pattern: "secret" })).text;
  assert.match(nested, /real\/c\.txt\n {2}1:nested secret/);
  if (windows) assert.match(nested, /alias\/c\.txt\n {2}1:nested secret/);
});
