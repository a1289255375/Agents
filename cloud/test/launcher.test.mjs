// The Windows launcher (start-cloud.cmd -> scripts/start-cloud.ps1 -> node), run the way a user types it.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import nodePath from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir, windows } from "./helpers.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const launcher = nodePath.join(repo, "start-cloud.cmd");
const script = nodePath.join(repo, "scripts", "start-cloud.ps1");

// Runs a line exactly as typed at a cmd prompt; Node's own argument quoting would hide quoting bugs.
function typed(line) {
  const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
    cwd: repo, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: true,
  });
  const output = { text: "" };
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output.text += chunk.toString("latin1"); });
  const exited = new Promise((resolve) => { child.once("close", resolve); });
  return { child, output, exited };
}

test("launcher: start-cloud.cmd passes its arguments through to the program", { skip: !windows, timeout: 120_000 }, async (t) => {
  const help = typed(`"${launcher}" --help`);
  assert.equal(await help.exited, 0, help.output.text);
  assert.match(help.output.text, /--command-policy/);
  assert.match(help.output.text, /CLOUD_BRIDGE_TOKEN/);

  // A quoted path ending in a backslash is the classic Windows quoting accident.
  const base = await tempDir(t);
  const missing = typed(`"${launcher}" "${base}\\no such dir\\"`);
  assert.equal(await missing.exited, 1, missing.output.text);
  t.diagnostic(`trailing backslash: ${missing.output.text}`);
  assert.match(missing.output.text, /no such dir\r?\n/);

  const followed = typed(`"${launcher}" "${base}\\no such dir\\" --command-policy allow`);
  assert.equal(await followed.exited, 1, followed.output.text);
  t.diagnostic(`trailing backslash, then options: ${followed.output.text}`);
  assert.match(followed.output.text, /no such dir(" --command-policy allow)?\r?\n/);
});

test("launcher: start-cloud.ps1 starts the bridge on a path with spaces and Chinese characters", { skip: !windows, timeout: 120_000 }, async (t) => {
  const base = await tempDir(t);
  const root = nodePath.join(base, "我的 项目");
  const stateDir = nodePath.join(base, "state dir");
  await fs.mkdir(root);

  const { child, output } = typed(
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${script}" "${root}" --state-dir "${stateDir}" --port 0 --mcp-port 0`,
  );
  t.after(() => { spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); });

  let consoleUrl;
  for (let attempt = 0; attempt < 300 && !consoleUrl && child.exitCode === null; attempt++) {
    consoleUrl = /http:\/\/127\.0\.0\.1:\d+\/(?!mcp)/.exec(output.text)?.[0];
    if (!consoleUrl) await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  assert.ok(consoleUrl, `the bridge did not start:\n${output.text}`);

  const view = await (await fetch(`${consoleUrl}api/state?now=1`)).json();
  assert.equal(view.bridge.root, root);
  assert.equal(view.bridge.platform, "win32");
  assert.equal(view.bridge.shell, "powershell");
  const state = JSON.parse(await fs.readFile(nodePath.join(stateDir, "config.json"), "utf8"));
  assert.equal(state.lastRoot, root);
  assert.match(state.token, /^[\w-]{40,}$/);
});
