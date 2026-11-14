import assert from "node:assert/strict";
import fs from "node:fs/promises";
import nodePath from "node:path";
import test from "node:test";
import { createPathGuard, PathError, resolveInside } from "../src/project/paths.mjs";
import { tempDir, trySymlink, windows, writeTree } from "./helpers.mjs";

const win = nodePath.win32;
const posix = nodePath.posix;
const inWin = (input, root = "D:\\proj") => resolveInside(root, input, win);
const rejected = (run, pattern) => assert.throws(run, (error) => error instanceof PathError && pattern.test(error.message));

test("Windows: paths inside the root resolve to root-relative paths", () => {
  assert.deepEqual(inWin("src\\a.ts"), { abs: "D:\\proj\\src\\a.ts", rel: "src/a.ts" });
  assert.equal(inWin("src/sub/../a.ts").rel, "src/a.ts");
  assert.equal(inWin("D:\\proj\\src\\a.ts").rel, "src/a.ts");
  assert.equal(inWin("d:/PROJ/Src/a.ts").rel, "Src/a.ts");
  assert.equal(inWin("").rel, "");
  assert.equal(inWin(".").rel, "");
  assert.equal(inWin("D:\\proj\\").rel, "");
  assert.equal(inWin("D:x").rel, "x");
  assert.equal(inWin("..foo").rel, "..foo");
  assert.equal(inWin("中文 目录\\文件.txt").rel, "中文 目录/文件.txt");
  assert.equal(inWin("x", "D:\\").rel, "x");
  assert.equal(inWin("a\\b", "\\\\srv\\share\\proj").rel, "a/b");
});

test("Windows: traversal, other drives and UNC paths are rejected", () => {
  for (const input of [
    "..", "..\\x", "src\\..\\..\\x", "../x", "\\Windows\\win.ini", "/etc/passwd",
    "C:\\Windows\\win.ini", "C:foo", "D:..\\x", "D:\\project2\\x", "D:\\proj2",
    "\\\\server\\share\\x", "//server/share/x",
  ]) {
    rejected(() => inWin(input), /项目根目录之外/);
  }
  rejected(() => inWin("..\\other", "\\\\srv\\share\\proj"), /项目根目录之外/);
  rejected(() => inWin("\\\\srv\\other\\proj\\a", "\\\\srv\\share\\proj"), /项目根目录之外/);
});

test("Windows: device paths, data streams, trailing dots and reserved names are rejected", () => {
  for (const input of ["\\\\?\\D:\\proj\\a", "\\\\.\\D:\\proj\\a", "//?/D:/proj/a", "\\\\.\\pipe\\x"]) {
    rejected(() => inWin(input), /设备路径/);
  }
  for (const input of ["a.txt:stream", "a.txt::$DATA", ".git::$INDEX_ALLOCATION\\config", "dir:x\\a"]) {
    rejected(() => inWin(input), /冒号/);
  }
  for (const input of ["foo.", "foo \\bar", ".git.\\config", ".git \\config", "a\\b...", "x\\ "]) {
    rejected(() => inWin(input), /点或空格结尾/);
  }
  for (const input of ["NUL", "nul", "con.txt", "src\\COM1", "LPT9.log", "aux.c", "PRN", "CONIN$", "conout$", "COM\u00b9"]) {
    rejected(() => inWin(input), /保留的设备名/);
  }
  for (const input of ["console.log", "nulls.txt", "com10", "auxiliary\\a", "lpt", "com0.txt"]) {
    assert.doesNotThrow(() => inWin(input));
  }
  rejected(() => inWin("a\0b"), /空字符/);
});

test("POSIX: traversal is rejected and backslashes are ordinary characters", () => {
  assert.deepEqual(resolveInside("/proj", "src/a.ts", posix), { abs: "/proj/src/a.ts", rel: "src/a.ts" });
  assert.equal(resolveInside("/proj", "/proj/src/../b", posix).rel, "b");
  assert.equal(resolveInside("/proj", "a\\..\\b", posix).rel, "a\\..\\b");
  assert.equal(resolveInside("/proj", "NUL", posix).rel, "NUL");
  for (const input of ["..", "../x", "a/../../x", "/etc/passwd", "/proj2/x", "/"]) {
    rejected(() => resolveInside("/proj", input, posix), /项目根目录之外/);
  }
});

test("guard: the root must be an existing directory", async (t) => {
  const dir = await tempDir(t);
  await writeTree(dir, { "file.txt": "x" });
  await assert.rejects(createPathGuard(nodePath.join(dir, "missing")), PathError);
  await assert.rejects(createPathGuard(nodePath.join(dir, "file.txt")), PathError);
  assert.equal((await createPathGuard(dir)).root, dir);
});

test("guard: existing and not yet existing paths inside the root", async (t) => {
  const root = await tempDir(t);
  await writeTree(root, { "src/a.txt": "x" });
  const guard = await createPathGuard(root);
  assert.deepEqual(await guard.locate("src/a.txt"), { abs: nodePath.join(root, "src", "a.txt"), rel: "src/a.txt" });
  assert.deepEqual(await guard.locate(nodePath.join(root, "src")), { abs: nodePath.join(root, "src"), rel: "src" });
  assert.deepEqual(await guard.locate("new/deep/file.txt"), { abs: nodePath.join(root, "new", "deep", "file.txt"), rel: "new/deep/file.txt" });
  assert.deepEqual(await guard.locate("src/a.txt/below"), { abs: nodePath.join(root, "src", "a.txt", "below"), rel: "src/a.txt/below" });
  assert.deepEqual(await guard.locate("."), { abs: root, rel: "" });
  await assert.rejects(guard.locate("../outside.txt"), PathError);
});

test("guard: links that lead out of the root are rejected", async (t) => {
  const base = await tempDir(t);
  const root = nodePath.join(base, "project");
  const outside = nodePath.join(base, "outside");
  await writeTree(base, { "project/inner/keep.txt": "in", "outside/secret.txt": "secret" });
  const guard = await createPathGuard(root);

  const dirType = windows ? "junction" : "dir";
  await fs.symlink(outside, nodePath.join(root, "escape"), dirType);
  await fs.symlink(nodePath.join(root, "inner"), nodePath.join(root, "alias"), dirType);
  for (const input of ["escape", "escape/secret.txt", "escape/new.txt", "escape/new/deeper.txt"]) {
    await assert.rejects(guard.locate(input), /指向项目根目录之外/, input);
    await assert.rejects(guard.locate(input, { write: true }), /指向项目根目录之外/, input);
  }
  // The link itself lives inside the root, so it can be deleted or moved without touching its target.
  assert.equal((await guard.locate("escape", { followLeaf: false })).abs, nodePath.join(root, "escape"));
  await assert.rejects(guard.locate("escape/secret.txt", { followLeaf: false }), /指向项目根目录之外/);

  // A link that stays inside the root resolves to its target.
  assert.deepEqual(await guard.locate("alias/keep.txt"), { abs: nodePath.join(root, "inner", "keep.txt"), rel: "inner/keep.txt" });

  if (await trySymlink(t, nodePath.join(outside, "secret.txt"), nodePath.join(root, "file-link.txt"), "file")) {
    await assert.rejects(guard.locate("file-link.txt"), /指向项目根目录之外/);
  }
  if (await trySymlink(t, nodePath.join(outside, "not-there.txt"), nodePath.join(root, "dangling.txt"), "file")) {
    await assert.rejects(guard.locate("dangling.txt", { write: true }), /指向不存在目标的链接/);
    await assert.rejects(guard.locate("dangling.txt/x", { write: true }), /指向不存在目标的链接/);
  }
});

test("guard: file tools cannot write under .git", async (t) => {
  const root = await tempDir(t);
  await writeTree(root, { ".git/config": "[core]", "src/.git/x": "nested", "a.txt": "x" });
  const guard = await createPathGuard(root);
  assert.equal((await guard.locate(".git/config")).rel, ".git/config");
  for (const input of [".git", ".git/config", ".git/hooks/pre-commit", ".GIT/config", "src/.git/x", "src/../.git/config"]) {
    await assert.rejects(guard.locate(input, { write: true }), /\.git/, input);
    await assert.rejects(guard.locate(input, { write: true, followLeaf: false }), /\.git/, input);
  }
  await fs.symlink(nodePath.join(root, ".git"), nodePath.join(root, "gitlink"), windows ? "junction" : "dir");
  await assert.rejects(guard.locate("gitlink/hooks/pre-commit", { write: true }), /\.git/);
  assert.equal((await guard.locate(".gitignore", { write: true })).rel, ".gitignore");
  assert.equal((await guard.locate("a.git/x", { write: true })).rel, "a.git/x");
});

test("guard on Windows: case, separators, 8.3 names and other drives", { skip: !windows }, async (t) => {
  const root = await tempDir(t);
  await writeTree(root, { "Src/File.txt": "x", ".git/config": "[core]" });
  const guard = await createPathGuard(root);
  assert.equal((await guard.locate("src\\file.TXT")).rel, "Src/File.txt");
  assert.equal((await guard.locate(`${root.toLowerCase()}/SRC/file.txt`)).rel, "Src/File.txt");
  await assert.rejects(guard.locate(".GiT\\config", { write: true }), /\.git/);
  await assert.rejects(guard.locate("C:\\Windows\\win.ini"), PathError);
  await assert.rejects(guard.locate("\\\\localhost\\c$\\Windows\\win.ini"), PathError);
  await assert.rejects(guard.locate("Src\\File.txt::$DATA"), /冒号/);
  await assert.rejects(guard.locate("NUL"), /保留的设备名/);

  // Only volumes with short-name generation enabled have GIT~1; where it exists it must not bypass the block.
  if (await fs.stat(nodePath.join(root, "GIT~1")).then(() => true, () => false)) {
    await assert.rejects(guard.locate("GIT~1\\hooks\\pre-commit", { write: true }), /\.git/);
  } else {
    t.diagnostic("no 8.3 short name for .git on this volume, short-name check skipped");
  }
});
