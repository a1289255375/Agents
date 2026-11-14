import assert from "node:assert/strict";
import test from "node:test";
import { lineDiff } from "../src/project/diff.mjs";
import {
  decodeBuffer, decodeOutputLine, encodeText, encodingOfCodePage, eolOf, replaceExact, splitLines, TextError, withEol,
} from "../src/project/text.mjs";

const gbk = (text) => encodeText(text, "gbk");

test("code pages map to decoder labels", () => {
  assert.equal(encodingOfCodePage(936), "gbk");
  assert.equal(encodingOfCodePage(950), "big5");
  assert.equal(encodingOfCodePage(1252), "windows-1252");
  assert.equal(encodingOfCodePage(437), undefined);
});

test("decodeBuffer detects BOMs, UTF-8 and the legacy code page", () => {
  assert.deepEqual(decodeBuffer(Buffer.from("héllo 中文"), "gbk"), { text: "héllo 中文", encoding: "utf8" });
  assert.deepEqual(decodeBuffer(Buffer.from([0xef, 0xbb, 0xbf, 0x61]), "gbk"), { text: "a", encoding: "utf8-bom" });
  assert.deepEqual(decodeBuffer(Buffer.from([0xff, 0xfe, 0x2d, 0x4e, 0x0a, 0x00]), "gbk"), { text: "中\n", encoding: "utf16le" });
  assert.deepEqual(decodeBuffer(Buffer.from([0xfe, 0xff, 0x4e, 0x2d]), "gbk"), { text: "中", encoding: "utf16be" });
  assert.deepEqual(decodeBuffer(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), "gbk"), { text: "中文", encoding: "gbk" });
  assert.deepEqual(decodeBuffer(Buffer.alloc(0), "gbk"), { text: "", encoding: "utf8" });
  assert.throws(() => decodeBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), "gbk"), /二进制/);
  assert.throws(() => decodeBuffer(Buffer.from([0xff, 0xff, 0xff]), "gbk"), /无法识别文件编码/);
  assert.throws(() => decodeBuffer(Buffer.from([0xff, 0xfe, 0x00]), "gbk"), /BOM/);
});

test("every encoding round-trips byte for byte", () => {
  const samples = {
    "utf8": "中文 abc 😀\r\n",
    "utf8-bom": "中文 abc 😀\n",
    "utf16le": "中文 abc 😀\r\n",
    "utf16be": "中文 abc 😀\r\n",
    "gbk": "简体中文，标点。！“”…—￥ ①ⅡАБαβ ぁア 丂狛 €\r\n",
    "big5": "繁體中文測試，標點。\r\n",
    "shift_jis": "日本語テスト ｶﾀｶﾅ\r\n",
    "euc-kr": "한국어 테스트\r\n",
    "windows-1252": "café über €\r\n",
    "windows-1251": "Привет\r\n",
  };
  for (const [encoding, text] of Object.entries(samples)) {
    const bytes = encodeText(text, encoding);
    const decoded = decodeBuffer(bytes, encoding.startsWith("utf") ? "gbk" : encoding);
    assert.deepEqual(decoded, { text, encoding }, encoding);
    assert.ok(encodeText(decoded.text, decoded.encoding).equals(bytes), encoding);
  }
  assert.ok(gbk("中文").equals(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])));
});

test("characters outside the legacy code page are refused instead of being replaced", () => {
  assert.throws(() => gbk("ok 😀"), (error) => error instanceof TextError && /无法用 gbk 编码/.test(error.message));
  assert.throws(() => encodeText("中文", "windows-1252"), TextError);
});

test("line ending helpers", () => {
  assert.equal(eolOf("a\r\nb\r\n"), "\r\n");
  assert.equal(eolOf("a\nb\n"), "\n");
  assert.equal(eolOf("a\r\nb\nc\n"), "\n");
  assert.equal(eolOf("a\r\nb\n"), "\r\n");
  assert.equal(eolOf("no line break"), undefined);
  assert.equal(withEol("a\nb\r\nc", "\r\n"), "a\r\nb\r\nc");
  assert.equal(withEol("a\r\nb\n", "\n"), "a\nb\n");
  assert.deepEqual(splitLines("a\r\nb\n\nc\n"), ["a", "b", "", "c"]);
  assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
  assert.deepEqual(splitLines(""), []);
});

test("replaceExact matches across CRLF and keeps untouched line endings", () => {
  const crlf = "one\r\ntwo\r\nthree\r\nfour\r\n";
  assert.deepEqual(replaceExact(crlf, "two\nthree", "2\n3\n3.5", false), { text: "one\r\n2\r\n3\r\n3.5\r\nfour\r\n", lines: [2] });
  assert.deepEqual(replaceExact(crlf, "two\r\nthree", "x", false).text, "one\r\nx\r\nfour\r\n");
  assert.deepEqual(replaceExact(crlf, "one\n", "", false).text, "two\r\nthree\r\nfour\r\n");
  assert.deepEqual(replaceExact(crlf, "four\n", "four\nfive\n", false).text, "one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n");

  // Mixed endings: only the replaced range changes, and new lines take the dominant style.
  const mixed = "a\r\nb\nc\r\nd\r\n";
  assert.equal(replaceExact(mixed, "c", "C1\nC2", false).text, "a\r\nb\nC1\r\nC2\r\nd\r\n");
  assert.equal(replaceExact("a\nb\n", "b", "b1\r\nb2", false).text, "a\nb1\nb2\n");
  assert.equal(replaceExact("single", "single", "one\ntwo", false).text, "one\ntwo");
});

test("replaceExact requires a unique match unless replace_all is set", () => {
  const text = "x = 1\r\ny = 2\r\nx = 1\r\n";
  assert.throws(() => replaceExact(text, "x = 1", "z", false), /出现了 2 次（第 1、3 行）/);
  assert.deepEqual(replaceExact(text, "x = 1", "z", true), { text: "z\r\ny = 2\r\nz\r\n", lines: [1, 3] });
  assert.throws(() => replaceExact(text, "missing", "z", false), /没有找到 old_string/);
  assert.throws(() => replaceExact(text, "", "z", false), /不能为空/);
  assert.equal(replaceExact("aaa", "aa", "b", true).text, "ba");
});

test("command output lines decode as UTF-8 first, then the console code page", () => {
  assert.equal(decodeOutputLine(Buffer.from("构建成功 ✓"), "gbk"), "构建成功 ✓");
  assert.equal(decodeOutputLine(gbk("系统找不到指定的文件。\r"), "gbk"), "系统找不到指定的文件。");
  assert.equal(decodeOutputLine(Buffer.from("10%\r50%\r100% done"), "gbk"), "100% done");
  assert.equal(decodeOutputLine(Buffer.from("\x1b[31merror\x1b[0m \x1b]0;title\x07text"), "gbk"), "error text");
  assert.equal(decodeOutputLine(Buffer.from("W\0S\0L\0", "latin1"), "gbk"), "WSL");
  // Bytes that are valid in neither encoding still produce text instead of throwing.
  assert.equal(typeof decodeOutputLine(Buffer.from([0x61, 0xff, 0xff, 0x62]), "gbk"), "string");
});

test("lineDiff shows changed lines with context", () => {
  const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
  const after = ["a", "b", "c", "D", "e", "f", "g", "h", "i"].join("\n");
  assert.equal(lineDiff(before, after), ["@@ -2 +2 @@", " b", " c", "-d", "+D", " e", " f", " g", " h", "+i"].join("\n"));
  assert.equal(lineDiff("same\ntext", "same\ntext"), "");
  assert.equal(lineDiff("", "new\nfile"), ["@@ -1 +1 @@", "+new", "+file"].join("\n"));
  // The newline that ends the last line is not a line of its own.
  assert.equal(lineDiff("old\n", ""), ["@@ -1 +1 @@", "-old"].join("\n"));
  assert.equal(lineDiff("a\r\nb\r\n", "a\r\nB\r\n"), ["@@ -1 +1 @@", " a", "-b", "+B"].join("\n"));

  const far = lineDiff(
    Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"),
    Array.from({ length: 30 }, (_, index) => (index === 3 || index === 25 ? `changed ${index}` : `line ${index}`)).join("\n"),
  );
  assert.deepEqual(far.split("\n").filter((line) => line.startsWith("@@")), ["@@ -2 +2 @@", "@@ -24 +24 @@"]);

  const long = lineDiff("", Array.from({ length: 500 }, (_, index) => `n${index}`).join("\n"), { maxLines: 20 });
  assert.equal(long.split("\n").length, 21);
  assert.match(long, /其余改动未显示/);
});
