// CommonJS entry the IDE loads. It finds the bridge code (the real cloud/src when running from source,
// or the copy packaged next to it in the .vsix), assembles the bridge API, and hands everything to the
// injectable controller. Keeping this shim tiny lets the controller be tested with a fake vscode.
"use strict";
const fs = require("node:fs");
const nodePath = require("node:path");
const { pathToFileURL } = require("node:url");

const importUrl = (file) => import(pathToFileURL(file).href);

// cloud/src is copied beside this file when packaged; running from the repo it sits one level up.
function bridgeDir() {
  for (const dir of [nodePath.join(__dirname, "src"), nodePath.join(__dirname, "..", "src")]) {
    if (fs.existsSync(nodePath.join(dir, "main.mjs"))) return dir;
  }
  throw new Error("找不到云端桥代码（cloud/src）。请先运行 cloud/extension/build.mjs 打包，或从仓库源码运行。");
}

let controller;

async function activate(context) {
  const vscode = require("vscode");
  const dir = bridgeDir();
  const [main, config, auth, { createController }] = await Promise.all([
    importUrl(nodePath.join(dir, "main.mjs")),
    importUrl(nodePath.join(dir, "config.mjs")),
    importUrl(nodePath.join(dir, "auth.mjs")),
    importUrl(nodePath.join(__dirname, "lib", "controller.mjs")),
  ]);
  const bridgeApi = {
    startBridge: main.startBridge,
    openState: config.openState,
    resolveToken: config.resolveToken,
    detectEncodings: config.detectEncodings,
    normalizePublicUrl: config.normalizePublicUrl,
    normalizeRelayUrl: config.normalizeRelayUrl,
    newToken: auth.newToken,
  };
  controller = createController({ vscode, bridgeApi, context });
  await controller.activate();
}

async function deactivate() {
  await controller?.stop();
}

module.exports = { activate, deactivate };
