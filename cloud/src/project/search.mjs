// File and text search. In a git work tree the file list comes from git, so .gitignore is honoured
// without reimplementing it; elsewhere the tree is walked and well-known heavy directories are skipped.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { promisify } from "node:util";
import { formatSize } from "./files.mjs";
import { decodeBuffer, splitLines, TextError } from "./text.mjs";

const run = promisify(execFile);
const walkSkipped = new Set([".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", ".vs", ".idea"]);
const maxListedFiles = 50_000;
const maxSearchFileBytes = 4 * 1024 * 1024;
const maxTestedLineChars = 5000;
const maxShownLineChars = 300;
const searchBudgetMs = 30_000;
const readBatch = 16;

export function globToRegExp(glob, ignoreCase) {
  let pattern = glob.replaceAll("\\", "/").replace(/^\.\//, "");
  // Like Cursor's Glob tool, a pattern without a directory part matches at any depth.
  if (!pattern.includes("/")) pattern = `**/${pattern}`;
  let source = "";
  let braces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        i++;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[" && pattern.indexOf("]", i + 2) !== -1) {
      const close = pattern.indexOf("]", i + 2);
      const body = pattern.slice(i + 1, close);
      const negated = body[0] === "!" || body[0] === "^";
      source += `[${negated ? "^" : ""}${(negated ? body.slice(1) : body).replace(/[\\^]/g, "\\$&")}]`;
      i = close;
    } else if (char === "{") {
      braces++;
      source += "(?:";
    } else if (char === "}" && braces) {
      braces--;
      source += ")";
    } else if (char === "," && braces) {
      source += "|";
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}${")".repeat(braces)}$`, ignoreCase ? "i" : "");
}

export function createSearchTools({ guard, legacyEncoding, platform = process.platform }) {
  const ignoreCase = platform === "win32";

  async function walk(abs, rel, skipped, files) {
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (files.length >= maxListedFiles) return;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      // Links are not followed: a junction could lead out of the project or loop forever.
      if (entry.isDirectory()) {
        if (!skipped.has(entry.name)) await walk(nodePath.join(abs, entry.name), child, skipped, files);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  }

  // Files under `path` as root-relative paths, plus the base that glob patterns are relative to.
  async function listFiles(path, includeIgnored) {
    const { abs, rel } = await guard.locate(path);
    if (!(await fs.stat(abs)).isDirectory()) return { files: [rel], base: nodePath.posix.dirname(rel).replace(/^\.$/, "") };

    if (!includeIgnored) {
      try {
        const { stdout } = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", rel || "."], {
          cwd: guard.root, maxBuffer: 256 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" },
        });
        return { files: [...new Set(stdout.split("\0").filter(Boolean))].slice(0, maxListedFiles), base: rel, viaGit: true };
      } catch {
        // Not a git work tree, or git is not installed.
      }
    }
    const files = [];
    await walk(abs, rel, includeIgnored ? new Set([".git"]) : walkSkipped, files);
    return { files, base: rel };
  }

  const insideBase = (file, base) => base ? file.slice(base.length + 1) : file;
  const noFilesHint = (viaGit) => viaGit ? "（被 .gitignore 忽略的文件不在范围内，需要时设置 includeIgnored: true）" : "";

  return {
    async findFiles({ pattern, path = ".", limit = 200, includeIgnored = false }) {
      const matcher = globToRegExp(pattern, ignoreCase);
      const { files, base, viaGit } = await listFiles(path, includeIgnored);
      const matched = files.filter((file) => matcher.test(insideBase(file, base)));
      const dated = [];
      for (const file of matched.slice(0, 5000)) {
        const stat = await fs.lstat(nodePath.join(guard.root, file)).catch(() => undefined);
        if (stat) dated.push({ file, time: stat.mtimeMs });
      }
      dated.sort((a, b) => b.time - a.time);
      const target = `${pattern}${base ? `（在 ${base}/ 下）` : ""}`;
      if (!dated.length) return { text: `没有匹配 ${target} 的文件${noFilesHint(viaGit)}`, record: { target, summary: "0 个文件" } };
      const shown = dated.slice(0, limit).map(({ file }) => file);
      const more = matched.length > shown.length ? `\n……另有 ${matched.length - shown.length} 个未显示，请缩小范围` : "";
      return {
        text: `找到 ${matched.length} 个文件（按修改时间从新到旧）：\n${shown.join("\n")}${more}`,
        record: { target, summary: `${matched.length} 个文件`, detail: shown.join("\n") },
      };
    },

    async searchText({ pattern, path = ".", glob, literal = false, ignoreCase: insensitive = false, context = 0, limit = 100, includeIgnored = false }) {
      let regex;
      try {
        regex = new RegExp(literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern, insensitive ? "i" : "");
      } catch (error) {
        throw new TextError(`正则表达式无效：${error.message}。按字面搜索请设置 literal: true`);
      }
      const matcher = glob && globToRegExp(glob, ignoreCase);
      const { files, base, viaGit } = await listFiles(path, includeIgnored);
      const candidates = matcher ? files.filter((file) => matcher.test(insideBase(file, base))) : files;

      const blocks = [];
      let matches = 0;
      let matchedFiles = 0;
      let skipped = 0;
      let stopped = "";
      const deadline = Date.now() + searchBudgetMs;
      for (let at = 0; at < candidates.length && !stopped; at += readBatch) {
        const batch = await Promise.all(candidates.slice(at, at + readBatch).map(async (file) => {
          const abs = nodePath.join(guard.root, file);
          try {
            // git lists links as files. Reading through one could return content from outside the project.
            const stat = await fs.lstat(abs);
            if (!stat.isFile()) return { file };
            if (stat.size > maxSearchFileBytes) return { file, skipped: true };
            return { file, lines: splitLines(decodeBuffer(await fs.readFile(abs), legacyEncoding).text) };
          } catch (error) {
            // Deleted since listing counts as absent; binary or unreadable files are reported as skipped.
            return { file, skipped: error.code !== "ENOENT" };
          }
        }));
        for (const { file, lines, skipped: wasSkipped } of batch) {
          if (wasSkipped) skipped++;
          if (!lines) continue;
          const hits = [];
          for (let index = 0; index < lines.length && matches + hits.length < limit; index++) {
            if (regex.test(lines[index].slice(0, maxTestedLineChars))) hits.push(index);
          }
          if (!hits.length) continue;
          matches += hits.length;
          matchedFiles++;
          blocks.push(formatHits(file, lines, hits, context, regex));
          if (matches >= limit) {
            stopped = `已达到 limit=${limit}，结果不完整，请缩小范围或提高 limit`;
            break;
          }
        }
        if (!stopped && Date.now() > deadline) stopped = "搜索超过 30 秒已停止，结果不完整，请缩小范围";
      }

      const target = `${pattern}${base ? `（在 ${base}/ 下）` : ""}${glob ? `（${glob}）` : ""}`;
      const notes = [`${matches} 处匹配，${matchedFiles} 个文件`];
      if (stopped) notes.push(stopped);
      if (skipped) notes.push(`跳过 ${skipped} 个二进制、无法读取或超过 ${formatSize(maxSearchFileBytes)} 的文件`);
      if (!matches) notes.push(`共检查 ${candidates.length} 个文件${noFilesHint(viaGit)}`);
      return {
        text: [...blocks, notes.join("；")].join("\n\n"),
        record: { target, summary: notes[0], detail: blocks.join("\n\n").slice(0, 4000) },
      };
    },
  };
}

function formatHits(file, lines, hits, context, regex) {
  const out = [file];
  const hitSet = new Set(hits);
  let last = -1;
  for (const hit of hits) {
    const from = Math.max(last + 1, hit - context);
    const to = Math.min(lines.length - 1, hit + context);
    if (context && last !== -1 && from > last + 1) out.push("  --");
    for (let index = from; index <= to; index++) {
      out.push(`  ${index + 1}${hitSet.has(index) ? ":" : "-"}${clip(lines[index], regex)}`);
    }
    last = to;
  }
  return out.join("\n");
}

// Long lines (minified code) are cut to a window around the first match.
function clip(line, regex) {
  if (line.length <= maxShownLineChars) return line;
  const at = Math.max(0, line.slice(0, maxTestedLineChars).search(regex));
  const from = Math.max(0, at - 80);
  return `${from ? "…" : ""}${line.slice(from, from + maxShownLineChars)}…`;
}
