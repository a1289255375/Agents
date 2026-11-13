// Keeps every file operation inside the project root.
// `resolveInside` is pure (no file system access) so the Windows rules can be unit-tested on any OS.
import fs from "node:fs/promises";
import nodePath from "node:path";

const reservedDeviceName = /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3]|conin\$|conout\$)$/i;

export class PathError extends Error {}

export function resolveInside(root, input, pathApi = nodePath) {
  if (input.includes("\0")) throw new PathError("路径不能包含空字符");
  const windows = pathApi.sep === "\\";
  if (windows && /^[\\/]{2}[?.]/.test(input)) throw new PathError(`不支持设备路径：${input}`);

  const abs = pathApi.resolve(root, input);
  const rel = pathApi.relative(root, abs);
  // Another drive or UNC share comes back from relative() as an absolute path.
  if (rel === ".." || rel.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(rel)) {
    throw new PathError(`路径在项目根目录之外：${input}。请使用相对项目根目录的路径，例如 src/index.js`);
  }
  const segments = rel ? rel.split(pathApi.sep) : [];
  if (windows) for (const segment of segments) checkWindowsSegment(segment, input);
  return { abs, rel: segments.join("/") };
}

// Windows resolves these spellings to a different file than the name suggests, which would let a
// caller slip past name-based rules (the .git write block) or reach devices such as CON.
function checkWindowsSegment(segment, input) {
  if (segment.includes(":")) throw new PathError(`路径段不能包含冒号（NTFS 备用数据流）：${input}`);
  if (/[. ]$/.test(segment)) throw new PathError(`路径段不能以点或空格结尾：${input}`);
  if (reservedDeviceName.test(segment.split(".")[0].trimEnd())) {
    throw new PathError(`${segment} 是 Windows 保留的设备名：${input}`);
  }
}

export async function createPathGuard(rootInput) {
  let root;
  try {
    root = await fs.realpath(nodePath.resolve(rootInput));
    if (!(await fs.stat(root)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new PathError(`项目根目录不存在或不是目录：${rootInput}`);
  }

  function inside(real, input) {
    const rel = nodePath.relative(root, real);
    if (rel === ".." || rel.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(rel)) {
      throw new PathError(`路径经符号链接或目录联接指向项目根目录之外：${input}`);
    }
    return rel.split(nodePath.sep).join("/");
  }

  // Resolves links in the deepest part of the path that exists; the rest is created by the caller.
  async function realOf(abs, input) {
    const missing = [];
    for (let current = abs; ;) {
      try {
        return nodePath.join(await fs.realpath(current), ...missing);
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
        // realpath fails on a link whose target is missing, and writing through it would create that target.
        if (await fs.lstat(current).then((stat) => stat.isSymbolicLink(), () => false)) {
          throw new PathError(`路径中有指向不存在目标的链接：${input}`);
        }
        const parent = nodePath.dirname(current);
        if (parent === current) throw error;
        missing.unshift(nodePath.basename(current));
        current = parent;
      }
    }
  }

  return {
    root,

    // `followLeaf: false` addresses a link itself (delete, move) instead of what it points to.
    // `write: true` also refuses .git, because git runs hooks and config from there on its own.
    async locate(input, { followLeaf = true, write = false } = {}) {
      const { abs } = resolveInside(root, input);
      let real;
      if (followLeaf || abs === root) {
        real = await realOf(abs, input);
      } else {
        real = nodePath.join(await realOf(nodePath.dirname(abs), input), nodePath.basename(abs));
      }
      const rel = inside(real, input);
      if (write && rel.split("/").some((segment) => segment.toLowerCase() === ".git")) {
        throw new PathError(`不允许用文件工具改动 .git 目录：${input}。需要时请用 run_command 执行 git 命令`);
      }
      return { abs: real, rel };
    },
  };
}
