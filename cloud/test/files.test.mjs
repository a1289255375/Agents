import assert from "node:assert/strict";
import fs from "node:fs/promises";
import nodePath from "node:path";
import test from "node:test";
import { createFileTools, describeError } from "../src/project/files.mjs";
import { createPathGuard } from "../src/project/paths.mjs";
import { encodeText } from "../src/project/text.mjs";
import { tempDir, windows, writeTree } from "./helpers.mjs";

async function setup(t, files = {}) {
  const root = await tempDir(t);
  await writeTree(root, files);
  const guard = await createPathGuard(root);
  const tools = createFileTools({ guard, legacyEncoding: "gbk" });
  const bytes = (name) => fs.readFile(nodePath.join(root, name));
  const fails = async (promise, pattern) => {
    await assert.rejects(promise, (error) => {
      assert.match(describeError(error, root), pattern);
      return true;
    });
  };
  return { root, tools, bytes, fails };
}

test("read_file numbers lines and reports encoding and line endings", async (t) => {
  const { tools, fails } = await setup(t, {
    "a.txt": "one\r\ntwo\r\nthree\r\n",
    "gbk.txt": encodeText("第一行\r\n第二行\r\n", "gbk"),
    "empty.txt": "",
    "bin.dat": Buffer.from([0, 1, 2, 3]),
    "long.txt": `${"x".repeat(2500)}\nshort\n`,
    "dir/x.txt": "x",
  });
  const read = await tools.readFile({ path: "a.txt" });
  assert.equal(read.text, "a.txt（共 3 行，utf8，CRLF）\n     1|one\n     2|two\n     3|three");
  assert.deepEqual(read.record, { target: "a.txt", summary: "第 1-3 行 / 共 3 行" });

  assert.equal((await tools.readFile({ path: "a.txt", offset: 2, limit: 1 })).text,
    "a.txt（共 3 行，utf8，CRLF）\n     2|two\n……第 2-2 行之后还有 1 行，用 offset: 3 继续读取");
  assert.match((await tools.readFile({ path: "a.txt", offset: -1 })).text, /\n     3\|three$/);
  assert.match((await tools.readFile({ path: "a.txt", offset: -99 })).text, /\n     1\|one\n/);
  assert.equal((await tools.readFile({ path: "gbk.txt" })).text, "gbk.txt（共 2 行，gbk，CRLF）\n     1|第一行\n     2|第二行");
  assert.equal((await tools.readFile({ path: "empty.txt" })).text, "empty.txt（共 0 行，utf8，无换行）\n（空文件）");
  assert.match((await tools.readFile({ path: "long.txt" })).text, /x…\[本行另有 500 个字符未显示\]\n     2\|short$/);

  await fails(tools.readFile({ path: "a.txt", offset: 9 }), /超出文件末尾/);
  await fails(tools.readFile({ path: "bin.dat" }), /bin\.dat：这是二进制文件/);
  await fails(tools.readFile({ path: "missing.txt" }), /^missing\.txt：不存在$/);
  await fails(tools.readFile({ path: "dir" }), /^dir：是目录，不是文件$/);
  await fails(tools.readFile({ path: "../x" }), /项目根目录之外/);
});

test("read_file pages through a large file", async (t) => {
  const { tools } = await setup(t, { "big.txt": Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`).join("\n") });
  const first = await tools.readFile({ path: "big.txt" });
  assert.match(first.text, /\n  2000\|line 2000\n……第 1-2000 行之后还有 3000 行，用 offset: 2001 继续读取$/);
  const last = await tools.readFile({ path: "big.txt", offset: 4001 });
  assert.match(last.text, /\n  5000\|line 5000$/);
});

test("write_file creates files as UTF-8 and keeps the style of existing files", async (t) => {
  const { tools, bytes, fails } = await setup(t, {
    "crlf.txt": "a\r\nb\r\n",
    "gbk.txt": encodeText("旧内容\r\n", "gbk"),
    "bom.txt": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x\n")]),
    "u16.txt": encodeText("旧\r\n", "utf16le"),
    "bin.dat": Buffer.from([0, 1, 2]),
  });

  const created = await tools.writeFile({ path: "new/dir/a.txt", content: "中文\nline2\n" });
  assert.equal(created.text, "已写入 new/dir/a.txt（新建，2 行，utf8，LF）");
  assert.equal(created.record.diff, "@@ -1 +1 @@\n+中文\n+line2");
  assert.ok((await bytes("new/dir/a.txt")).equals(Buffer.from("中文\nline2\n")));

  const overwritten = await tools.writeFile({ path: "crlf.txt", content: "a\nB\nc\n" });
  assert.equal(overwritten.text, "已写入 crlf.txt（覆盖，2 行 → 3 行，utf8，CRLF）");
  assert.equal((await bytes("crlf.txt")).toString(), "a\r\nB\r\nc\r\n");
  assert.equal(overwritten.record.diff, "@@ -1 +1 @@\n a\n-b\n+B\n+c");

  await tools.writeFile({ path: "gbk.txt", content: "新内容\n第二行\n" });
  assert.ok((await bytes("gbk.txt")).equals(encodeText("新内容\r\n第二行\r\n", "gbk")));
  await tools.writeFile({ path: "bom.txt", content: "y\n" });
  assert.ok((await bytes("bom.txt")).equals(Buffer.from([0xef, 0xbb, 0xbf, 0x79, 0x0a])));
  await tools.writeFile({ path: "u16.txt", content: "新\n" });
  assert.ok((await bytes("u16.txt")).equals(encodeText("新\r\n", "utf16le")));

  // A character GBK cannot represent must not corrupt or truncate the existing file.
  await fails(tools.writeFile({ path: "gbk.txt", content: "😀\n" }), /无法用 gbk 编码/);
  assert.ok((await bytes("gbk.txt")).equals(encodeText("新内容\r\n第二行\r\n", "gbk")));
  await tools.writeFile({ path: "gbk.txt", content: "😀\n", encoding: "utf8" });
  assert.equal((await bytes("gbk.txt")).toString(), "😀\r\n");

  assert.match((await tools.writeFile({ path: "bin.dat", content: "text\n" })).text, /覆盖原二进制文件，1 行，utf8，LF/);
  await fails(tools.writeFile({ path: "new", content: "x" }), /^new：是目录，不是文件$/);
  await fails(tools.writeFile({ path: "../escape.txt", content: "x" }), /项目根目录之外/);
  await fails(tools.writeFile({ path: ".git/hooks/pre-commit", content: "x" }), /\.git/);
});

test("write_file picks encodings that Windows script hosts read correctly", async (t) => {
  const { tools, bytes } = await setup(t);
  const script = await tools.writeFile({ path: "run.ps1", content: "Write-Host '中文'\n" });
  assert.match(script.text, /utf8-bom，LF/);
  assert.match(script.text, /带 BOM 写入/);
  assert.ok((await bytes("run.ps1")).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
  assert.doesNotMatch((await tools.writeFile({ path: "ascii.ps1", content: "Write-Host 'hi'\n" })).text, /BOM/);

  const batch = await tools.writeFile({ path: "build.bat", content: "@echo off\necho 构建\n" });
  assert.equal((await bytes("build.bat")).toString(), "@echo off\r\necho 构建\r\n");
  assert.match(batch.text, /chcp 65001/);
  assert.doesNotMatch((await tools.writeFile({ path: "utf.cmd", content: "chcp 65001 >nul\necho 构建\n" })).text, /乱码/);

  const ansi = await tools.writeFile({ path: "ansi.bat", content: "echo 构建\n", encoding: "ansi" });
  assert.match(ansi.text, /gbk，CRLF/);
  assert.ok((await bytes("ansi.bat")).equals(encodeText("echo 构建\r\n", "gbk")));
  await tools.writeFile({ path: "wide.txt", content: "宽\n", encoding: "utf16le" });
  assert.ok((await bytes("wide.txt")).equals(encodeText("宽\n", "utf16le")));
});

test("edit_file changes only the matched range", async (t) => {
  const original = encodeText("@echo off\r\nrem 第一步\r\necho 旧\r\nrem 结束\r\n", "gbk");
  const { tools, bytes, fails } = await setup(t, {
    "legacy.bat": original,
    "lf.js": "const a = 1;\nconst b = 2;\nconst a2 = 1;\n",
    "u16.txt": encodeText("甲\r\n乙\r\n", "utf16le"),
    "bin.dat": Buffer.from([0, 1, 2]),
    // 0xA2E3 and 0x80 both decode to the euro sign in GBK, so this file cannot be written back unchanged.
    "ambiguous.txt": Buffer.from([0xa2, 0xe3, 0x0d, 0x0a, 0x61]),
  });

  const edited = await tools.editFile({ path: "legacy.bat", old_string: "echo 旧\nrem 结束", new_string: "echo 新\necho 再来\nrem 结束" });
  assert.equal(edited.text, "已修改 legacy.bat：替换 1 处（第 3 行）");
  assert.equal(edited.record.diff, "@@ -1 +1 @@\n @echo off\n rem 第一步\n-echo 旧\n+echo 新\n+echo 再来\n rem 结束");
  assert.ok((await bytes("legacy.bat")).equals(encodeText("@echo off\r\nrem 第一步\r\necho 新\r\necho 再来\r\nrem 结束\r\n", "gbk")));

  await fails(tools.editFile({ path: "lf.js", old_string: " = 1;", new_string: " = 3;" }), /出现了 2 次（第 1、3 行）/);
  assert.equal((await tools.editFile({ path: "lf.js", old_string: " = 1;", new_string: " = 3;", replace_all: true })).text,
    "已修改 lf.js：替换 2 处（第 1、3 行）");
  assert.equal((await bytes("lf.js")).toString(), "const a = 3;\nconst b = 2;\nconst a2 = 3;\n");

  await tools.editFile({ path: "u16.txt", old_string: "乙", new_string: "丙\n丁" });
  assert.ok((await bytes("u16.txt")).equals(encodeText("甲\r\n丙\r\n丁\r\n", "utf16le")));

  await fails(tools.editFile({ path: "lf.js", old_string: "nope", new_string: "x" }), /没有找到 old_string/);
  await fails(tools.editFile({ path: "lf.js", old_string: "const b", new_string: "const b" }), /相同/);
  await fails(tools.editFile({ path: "legacy.bat", old_string: "echo 新", new_string: "echo 😀" }), /无法用 gbk 编码/);
  await fails(tools.editFile({ path: "bin.dat", old_string: "a", new_string: "b" }), /二进制/);
  await fails(tools.editFile({ path: "ambiguous.txt", old_string: "a", new_string: "b" }), /无法原样写回/);
  await fails(tools.editFile({ path: "missing.txt", old_string: "a", new_string: "b" }), /不存在/);
  await fails(tools.editFile({ path: ".git/config", old_string: "a", new_string: "b" }), /\.git/);
});

test("list_dir lists directories first and can descend", async (t) => {
  const { root, tools, fails } = await setup(t, {
    "b.txt": "12345", "a.txt": "", "src/main.js": "x".repeat(2048), "src/lib/util.js": "u",
    "node_modules/pkg/index.js": "x", "empty/.keep": "",
  });
  await fs.rm(nodePath.join(root, "empty", ".keep"));
  await fs.symlink(nodePath.join(root, "src"), nodePath.join(root, "link"), windows ? "junction" : "dir");

  assert.equal((await tools.listDir({})).text,
    "./\nempty/\nnode_modules/\nsrc/\na.txt  (0 B)\nb.txt  (5 B)\nlink -> 链接");
  assert.equal((await tools.listDir({ path: "src", depth: 2 })).text, "src/\nlib/\n  util.js  (1 B)\nmain.js  (2.0 KB)");
  assert.equal((await tools.listDir({ depth: 3 })).text,
    "./\nempty/\nnode_modules/\nsrc/\n  lib/\n    util.js  (1 B)\n  main.js  (2.0 KB)\na.txt  (0 B)\nb.txt  (5 B)\nlink -> 链接");
  assert.equal((await tools.listDir({ path: "empty" })).text, "empty/\n（空目录）");
  await fails(tools.listDir({ path: "a.txt" }), /^a\.txt：不是目录$/);
  await fails(tools.listDir({ path: "nope" }), /^nope：不存在$/);
});

test("list_dir caps very large directories", async (t) => {
  const { tools } = await setup(t, Object.fromEntries(Array.from({ length: 450 }, (_, index) => [`f${index}.txt`, ""])));
  const listed = await tools.listDir({});
  assert.equal(listed.text.split("\n").length, 402);
  assert.match(listed.text, /至少还有 50 项未显示/);
});

test("delete_path removes files, directories and links without following them", async (t) => {
  const { root, tools, fails } = await setup(t, { "a.txt": "x", "dir/b.txt": "x", "keep/inner.txt": "x", "empty/.keep": "" });
  await fs.rm(nodePath.join(root, "empty", ".keep"));
  await fs.symlink(nodePath.join(root, "keep"), nodePath.join(root, "link"), windows ? "junction" : "dir");
  const exists = (name) => fs.lstat(nodePath.join(root, name)).then(() => true, () => false);

  assert.equal((await tools.deletePath({ path: "a.txt" })).text, "已删除文件 a.txt");
  assert.equal((await tools.deletePath({ path: "empty" })).text, "已删除目录 empty");
  await fails(tools.deletePath({ path: "dir" }), /^dir：目录非空$/);
  assert.equal(await exists("dir/b.txt"), true);
  await tools.deletePath({ path: "dir", recursive: true });
  assert.equal(await exists("dir"), false);

  assert.equal((await tools.deletePath({ path: "link", recursive: true })).text, "已删除链接 link");
  assert.equal(await exists("link"), false);
  assert.equal(await exists("keep/inner.txt"), true);

  await fails(tools.deletePath({ path: "." }), /不能删除项目根目录/);
  await fails(tools.deletePath({ path: "missing" }), /^missing：不存在$/);
  await fails(tools.deletePath({ path: ".git" }), /\.git/);
  await fails(tools.deletePath({ path: ".." }), /项目根目录之外/);
});

test("move_path renames inside the root", async (t) => {
  const { root, tools, fails } = await setup(t, { "a.txt": "A", "b.txt": "B", "dir/c.txt": "C" });
  const read = (name) => fs.readFile(nodePath.join(root, name), "utf8");

  assert.equal((await tools.movePath({ from: "a.txt", to: "moved/deep/a.txt" })).text, "已移动 a.txt → moved/deep/a.txt");
  assert.equal(await read("moved/deep/a.txt"), "A");
  await fails(tools.movePath({ from: "b.txt", to: "moved/deep/a.txt" }), /目标已存在/);
  await tools.movePath({ from: "b.txt", to: "moved/deep/a.txt", overwrite: true });
  assert.equal(await read("moved/deep/a.txt"), "B");
  await tools.movePath({ from: "dir", to: "renamed" });
  assert.equal(await read("renamed/c.txt"), "C");

  await fails(tools.movePath({ from: "missing", to: "x" }), /^missing：不存在$/);
  await fails(tools.movePath({ from: "renamed", to: "../out" }), /项目根目录之外/);
  await fails(tools.movePath({ from: "renamed", to: ".git/x" }), /\.git/);
  await fails(tools.movePath({ from: ".", to: "x" }), /项目根目录/);
});
