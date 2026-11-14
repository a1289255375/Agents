// Which files a command touched: the project is listed before and after the command and the two
// listings are compared by size and modification time. Files ignored by git are left out, like in search.
import fs from "node:fs/promises";
import nodePath from "node:path";

const maxTrackedFiles = 20_000;
const statBatch = 64;
const maxShown = 60;

export function createChangeTracker({ root, listFiles }) {
  return {
    // Resolves to undefined when the project is too large to stat twice per command.
    async snapshot() {
      const { files } = await listFiles(".", false);
      if (files.length > maxTrackedFiles) return undefined;
      const seen = new Map();
      for (let at = 0; at < files.length; at += statBatch) {
        const batch = files.slice(at, at + statBatch);
        const stats = await Promise.all(batch.map((file) => fs.lstat(nodePath.join(root, file)).catch(() => undefined)));
        stats.forEach((stat, index) => {
          if (stat) seen.set(batch[index], `${stat.size}:${stat.mtimeMs}`);
        });
      }
      return seen;
    },

    diff(before, after) {
      if (!before || !after) return { skipped: `项目文件超过 ${maxTrackedFiles} 个，没有统计文件变更` };
      const added = [];
      const modified = [];
      for (const [file, stamp] of after) {
        if (!before.has(file)) added.push(file);
        else if (before.get(file) !== stamp) modified.push(file);
      }
      const deleted = [...before.keys()].filter((file) => !after.has(file));
      return { added, modified, deleted };
    },
  };
}

export const changeCount = (changes) => changes?.skipped ? 0 : (changes?.added.length ?? 0) + (changes?.modified.length ?? 0) + (changes?.deleted.length ?? 0);

export function formatChanges(changes) {
  if (changes.skipped) return changes.skipped;
  const lines = [
    ...changes.added.map((file) => `+ ${file}`),
    ...changes.modified.map((file) => `~ ${file}`),
    ...changes.deleted.map((file) => `- ${file}`),
  ];
  const more = lines.length > maxShown ? [`……另有 ${lines.length - maxShown} 个文件未列出`] : [];
  return [...lines.slice(0, maxShown), ...more].join("\n");
}
