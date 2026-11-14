import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";

export const windows = process.platform === "win32";

// realpath: macOS and Windows temp dirs are reached through links or 8.3 names.
export async function tempDir(t, prefix = "cloud-bridge-") {
  const dir = await fs.realpath(await fs.mkdtemp(nodePath.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return dir;
}

export async function writeTree(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = nodePath.join(root, name);
    await fs.mkdir(nodePath.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

// Creating symlinks on Windows needs a privilege that not every account has.
export async function trySymlink(t, target, path, type) {
  try {
    await fs.symlink(target, path, type);
    return true;
  } catch (error) {
    if (error.code !== "EPERM") throw error;
    t.diagnostic(`symlink not permitted here, skipped: ${path}`);
    return false;
  }
}
