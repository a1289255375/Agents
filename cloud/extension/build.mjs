// Packs the .vsix. The extension runs the real cloud/src code, so instead of bundling we stage a copy
// of cloud/src, cloud/web and prompt.md beside the extension and install the two runtime deps here,
// then let vsce zip it. Only vsce is a packaging-time tool (run through npx); it is not a runtime dep.
//
//   node cloud/extension/build.mjs [--out <file.vsix>]
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const cloud = nodePath.join(here, "..");
const staged = ["src", "web", "prompt.md", "node_modules", "package-lock.json"];

const outArg = process.argv.indexOf("--out");
const outFile = outArg !== -1 ? nodePath.resolve(process.argv[outArg + 1]) : undefined;

async function run() {
  for (const name of staged) await fs.rm(nodePath.join(here, name), { recursive: true, force: true });
  await fs.cp(nodePath.join(cloud, "src"), nodePath.join(here, "src"), { recursive: true });
  await fs.cp(nodePath.join(cloud, "web"), nodePath.join(here, "web"), { recursive: true });
  await fs.cp(nodePath.join(cloud, "prompt.md"), nodePath.join(here, "prompt.md"));
  console.log("已复制 src、web、prompt.md");

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(npm, ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: here, stdio: "inherit" });
  console.log("已安装运行时依赖");

  const args = ["--yes", "@vscode/vsce@3", "package", "--no-git-tag-version", "--skip-license"];
  if (outFile) args.push("--out", outFile);
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  execFileSync(npx, args, { cwd: here, stdio: "inherit" });
  const vsix = outFile ?? (await fs.readdir(here)).filter((name) => name.endsWith(".vsix")).sort().at(-1);
  console.log(`\n已生成 vsix：${outFile ?? nodePath.join(here, vsix)}`);
}

run().catch((error) => {
  console.error(error.message ?? error);
  process.exitCode = 1;
});
