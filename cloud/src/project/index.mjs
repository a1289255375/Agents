import os from "node:os";
import { createCommandRunner } from "./commands.mjs";
import { createFileTools } from "./files.mjs";
import { createPathGuard } from "./paths.mjs";
import { createSearchTools } from "./search.mjs";

export const policyLabels = {
  ask: "每次确认（每条命令都要用户在网页上批准）",
  allow: "全部允许",
  deny: "禁止（不能执行任何命令）",
};

// Everything the MCP tools need to work on one project root.
export async function createProject({ root, legacyEncoding, consoleEncoding, policy, commandWaitMs, onJobChange, platform = process.platform }) {
  const guard = await createPathGuard(root);
  const commands = createCommandRunner({ guard, platform, consoleEncoding, policy, waitMs: commandWaitMs, onChange: onJobChange });
  const otherShells = Object.keys(commands.shells).filter((name) => name !== commands.defaultShell);

  return {
    guard,
    platform,
    commands,
    files: createFileTools({ guard, legacyEncoding }),
    search: createSearchTools({ guard, legacyEncoding, platform }),

    info: () => [
      `项目根目录：${guard.root}`,
      `系统：${os.type()} ${os.release()}（${platform}，${os.arch()}）`,
      `默认 shell：${commands.defaultShell}，${commands.shells[commands.defaultShell]}${otherShells.length ? `；还可以用 ${otherShells.join("、")}` : ""}`,
      `命令策略：${policyLabels[commands.policy]}`,
      `文件编码：新文件默认 UTF-8；已有文件保持原来的编码（UTF-8、UTF-16 或系统代码页 ${legacyEncoding}）和换行符`,
      `路径：使用相对项目根目录的路径${platform === "win32" ? "，/ 和 \\ 都可以" : "，用 / 分隔"}；根目录之外的路径会被拒绝`,
    ].join("\n"),
  };
}
