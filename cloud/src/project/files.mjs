// File tools for the project root. Each returns the text for the agent plus a record for the web console.
import fs from "node:fs/promises";
import nodePath from "node:path";
import { lineDiff } from "./diff.mjs";
import { PathError } from "./paths.mjs";
import { decodeBuffer, encodeText, eolOf, replaceExact, splitLines, TextError, withEol } from "./text.mjs";

const maxFileBytes = 16 * 1024 * 1024;
const maxReadChars = 100_000;
const maxLineChars = 2000;
const defaultReadLines = 2000;
const maxListEntries = 400;
const unlistedDirs = new Set([".git", "node_modules"]);

const fsErrors = {
  ENOENT: "不存在", EACCES: "没有访问权限", EPERM: "操作被系统拒绝（只读、被占用或没有权限）", EBUSY: "正被其他程序占用",
  EISDIR: "是目录，不是文件", ENOTDIR: "不是目录", ENOTEMPTY: "目录非空", EEXIST: "已存在", EXDEV: "不能跨磁盘卷移动",
  ELOOP: "链接层级过多", ENAMETOOLONG: "路径过长", EINVAL: "路径或参数无效", EMFILE: "打开的文件过多", ENOSPC: "磁盘空间不足",
};

// Message an agent can act on, for errors thrown anywhere in the project tools.
export function describeError(error, root) {
  if (error instanceof PathError || error instanceof TextError || !error?.syscall) return String(error?.message ?? error);
  const where = error.path ? nodePath.relative(root, error.path).split(nodePath.sep).join("/") || "." : "";
  return `${where ? `${where}：` : ""}${fsErrors[error.code] ?? error.message}`;
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const directoryError = (rel) => new PathError(`${rel || "."}：是目录，不是文件`);
const eolName = (eol) => eol === "\r\n" ? "CRLF" : eol === "\n" ? "LF" : "无换行";

export function createFileTools({ guard, legacyEncoding }) {
  async function readText(abs, rel) {
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) throw directoryError(rel);
    const { size } = stat;
    if (size > maxFileBytes) throw new TextError(`${rel} 有 ${formatSize(size)}，超过 16 MB 上限。请用 search_text 或命令处理`);
    const buffer = await fs.readFile(abs);
    try {
      return { buffer, ...decodeBuffer(buffer, legacyEncoding) };
    } catch (error) {
      throw new TextError(`${rel}：${error.message}（${formatSize(size)}）`);
    }
  }

  return {
    async readFile({ path, offset, limit = defaultReadLines }) {
      const { abs, rel } = await guard.locate(path);
      const { text, encoding } = await readText(abs, rel);
      const lines = splitLines(text);
      const total = lines.length;
      const header = `${rel}（共 ${total} 行，${encoding}，${eolName(eolOf(text))}）`;
      if (total === 0) return { text: `${header}\n（空文件）`, record: { target: rel, summary: "空文件" } };

      const first = offset === undefined ? 1 : offset < 0 ? Math.max(1, total + offset + 1) : Math.max(1, offset);
      if (first > total) throw new TextError(`offset ${offset} 超出文件末尾，${rel} 只有 ${total} 行`);
      const shown = [];
      let chars = 0;
      let next = first;
      for (; next <= Math.min(total, first + limit - 1) && chars < maxReadChars; next++) {
        const line = lines[next - 1];
        const visible = line.length > maxLineChars
          ? `${line.slice(0, maxLineChars)}…[本行另有 ${line.length - maxLineChars} 个字符未显示]`
          : line;
        shown.push(`${String(next).padStart(6)}|${visible}`);
        chars += visible.length + 8;
      }
      const range = `第 ${first}-${next - 1} 行`;
      const more = next <= total ? `\n……${range}之后还有 ${total - next + 1} 行，用 offset: ${next} 继续读取` : "";
      return { text: `${header}\n${shown.join("\n")}${more}`, record: { target: rel, summary: `${range} / 共 ${total} 行` } };
    },

    async writeFile({ path, content, encoding }) {
      const { abs, rel } = await guard.locate(path, { write: true });
      const existing = await fs.stat(abs).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing?.isDirectory()) throw directoryError(rel);
      const previous = existing && await fs.readFile(abs);
      let before;
      try {
        before = previous && decodeBuffer(previous, legacyEncoding);
      } catch {
        // Replacing a binary or undecodable file: there is no text style to carry over.
      }

      const extension = nodePath.extname(rel).toLowerCase();
      const batch = extension === ".bat" || extension === ".cmd";
      const nonAscii = /[^\x00-\x7f]/.test(content);
      const notes = [];
      let target = encoding === "ansi" ? legacyEncoding : encoding ?? before?.encoding;
      if (!target) {
        // Windows PowerShell 5.1 reads a script without BOM in the ANSI code page and garbles non-ASCII text.
        target = nonAscii && [".ps1", ".psm1", ".psd1"].includes(extension) ? "utf8-bom" : "utf8";
        if (target === "utf8-bom") notes.push("含非 ASCII 字符的 PowerShell 脚本已按 UTF-8 带 BOM 写入，Windows PowerShell 5.1 才能正确读取。");
        if (batch && nonAscii && !/chcp\s+65001/i.test(content)) {
          notes.push(`这个批处理含非 ASCII 字符并按 UTF-8 写入。控制台代码页不是 UTF-8 时会乱码：在脚本开头加 chcp 65001，或用 encoding: "ansi"（${legacyEncoding}）重写。`);
        }
      }
      // cmd.exe mis-parses labels in batch files that use bare LF.
      const eol = (before && eolOf(before.text)) ?? (batch ? "\r\n" : undefined);
      const text = eol ? withEol(content, eol) : content;
      const bytes = encodeText(text, target);
      await fs.mkdir(nodePath.dirname(abs), { recursive: true });
      await fs.writeFile(abs, bytes);

      const lineCount = splitLines(text).length;
      const style = `${target}，${eolName(eolOf(text))}`;
      const summary = previous === undefined
        ? `新建，${lineCount} 行`
        : before ? `覆盖，${splitLines(before.text).length} 行 → ${lineCount} 行` : `覆盖原二进制文件，${lineCount} 行`;
      return {
        text: [`已写入 ${rel}（${summary}，${style}）`, ...notes].join("\n"),
        record: { target: rel, summary, diff: lineDiff(before?.text ?? "", text) },
      };
    },

    async editFile({ path, old_string: oldString, new_string: newString, replace_all: replaceAll = false }) {
      const { abs, rel } = await guard.locate(path, { write: true });
      const { buffer, text, encoding } = await readText(abs, rel);
      // Some legacy byte sequences decode to the same character. Re-encoding such a file would
      // silently change bytes the agent never touched.
      if (!encodeText(text, encoding).equals(buffer)) {
        throw new TextError(`${rel} 按 ${encoding} 解码后无法原样写回，为避免破坏未改动的内容，不能用文本工具修改它`);
      }
      if (oldString === newString) throw new TextError("old_string 和 new_string 相同，没有可改的内容");
      const result = replaceExact(text, oldString, newString, replaceAll);
      await fs.writeFile(abs, encodeText(result.text, encoding));
      const summary = `替换 ${result.lines.length} 处（第 ${result.lines.slice(0, 10).join("、")} 行${result.lines.length > 10 ? " 等" : ""}）`;
      return { text: `已修改 ${rel}：${summary}`, record: { target: rel, summary, diff: lineDiff(text, result.text) } };
    },

    async listDir({ path = ".", depth = 1 }) {
      const { abs, rel } = await guard.locate(path);
      const lines = [];
      let omitted = 0;
      async function list(dir, indent, level) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        entries.sort((a, b) => b.isDirectory() - a.isDirectory() || (a.name < b.name ? -1 : 1));
        for (const entry of entries) {
          if (lines.length >= maxListEntries) {
            omitted++;
            continue;
          }
          const full = nodePath.join(dir, entry.name);
          if (entry.isSymbolicLink()) {
            lines.push(`${indent}${entry.name} -> 链接`);
          } else if (entry.isDirectory()) {
            lines.push(`${indent}${entry.name}/`);
            if (level < depth && !unlistedDirs.has(entry.name)) await list(full, `${indent}  `, level + 1);
          } else {
            const size = await fs.stat(full).then((stat) => `  (${formatSize(stat.size)})`, () => "");
            lines.push(`${indent}${entry.name}${size}`);
          }
        }
      }
      await list(abs, "", 1);
      const name = `${rel || "."}/`;
      const body = lines.length ? lines.join("\n") : "（空目录）";
      const more = omitted ? `\n……至少还有 ${omitted} 项未显示，请列出更具体的子目录` : "";
      return { text: `${name}\n${body}${more}`, record: { target: name, summary: `${lines.length + omitted} 项` } };
    },

    async deletePath({ path, recursive = false }) {
      const { abs, rel } = await guard.locate(path, { followLeaf: false, write: true });
      if (abs === guard.root) throw new PathError("不能删除项目根目录");
      const stat = await fs.lstat(abs);
      if (stat.isDirectory() && !recursive) await fs.rmdir(abs);
      else await fs.rm(abs, { recursive: stat.isDirectory(), maxRetries: 2 });
      const kind = stat.isDirectory() ? "目录" : stat.isSymbolicLink() ? "链接" : "文件";
      return { text: `已删除${kind} ${rel}`, record: { target: rel, summary: `删除${kind}` } };
    },

    async movePath({ from, to, overwrite = false }) {
      const source = await guard.locate(from, { followLeaf: false, write: true });
      const target = await guard.locate(to, { followLeaf: false, write: true });
      if (source.abs === guard.root || target.abs === guard.root) throw new PathError("不能移动或覆盖项目根目录");
      await fs.lstat(source.abs);
      const exists = await fs.lstat(target.abs).then(() => true, () => false);
      if (exists && !overwrite) throw new PathError(`目标已存在：${target.rel}。确认要覆盖请设置 overwrite: true`);
      await fs.mkdir(nodePath.dirname(target.abs), { recursive: true });
      await fs.rename(source.abs, target.abs);
      return { text: `已移动 ${source.rel} → ${target.rel}`, record: { target: `${source.rel} → ${target.rel}`, summary: "移动" } };
    },
  };
}
