import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import nodePath from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const windows = process.platform === "win32";

export async function until(check, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`timed out waiting for: ${message}`);
}

// Plays Cursor's Cloud Agents API. Each request is answered by the next handler in `handlers`;
// once they run out, the stream opens and stays silent.
export async function fakeCursorApi(t, handlers) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers, closed: new Promise((resolve) => { res.once("close", resolve); }) });
    const handle = handlers.shift() ?? ((_, silent) => silent.writeHead(200, { "Content-Type": "text/event-stream" }).flushHeaders());
    handle(req, res);
  });
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { base: `http://127.0.0.1:${server.address().port}`, requests };
}

export const sse = (event, data, id) => `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

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
