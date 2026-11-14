import fs from "node:fs/promises";
import os from "node:os";
import { createChangeTracker } from "./changes.mjs";
import { CommandError, createCommandRunner } from "./commands.mjs";
import { createFileTools } from "./files.mjs";
import { createPathGuard } from "./paths.mjs";
import { displayArgv } from "./programs.mjs";
import { createSearchTools } from "./search.mjs";
import { detectTestCommand } from "./tests.mjs";

export const policyLabels = {
  ask: "每次确认（每条命令都要用户在网页上批准）",
  allow: "全部允许",
  deny: "禁止（不能执行任何命令）",
};

// Everything the MCP tools need to work on one project root.
// `testCommand` is the user's own command line for running the tests; without it the command is detected.
export async function createProject({
  root, legacyEncoding, consoleEncoding, policy, commandWaitMs, onJobChange, platform = process.platform,
  testCommand, trackChanges = true, approvalPlace,
}) {
  const guard = await createPathGuard(root);
  const search = createSearchTools({ guard, legacyEncoding, platform });
  const commands = createCommandRunner({
    guard, platform, consoleEncoding, policy, waitMs: commandWaitMs, onChange: onJobChange, approvalPlace,
    tracker: trackChanges ? createChangeTracker({ root: guard.root, listFiles: search.listFiles }) : undefined,
  });
  const otherShells = Object.keys(commands.shells).filter((name) => name !== commands.defaultShell);
  const labels = approvalPlace ? { ...policyLabels, ask: `每次确认（每条命令都要用户在${approvalPlace}批准）` } : policyLabels;

  return {
    guard,
    platform,
    commands,
    search,
    files: createFileTools({ guard, legacyEncoding }),

    programs: {
      run: ({ program, args = [], ...rest }) => commands.request({ ...rest, argv: [program, ...args], tool: "run_program" }),
    },

    tests: {
      // Resolves to the job id plus a line telling the agent which command was chosen and why.
      async run({ cwd = ".", args = [], ...rest }) {
        if (testCommand) {
          const command = args.length ? `${testCommand} ${displayArgv(args)}` : testCommand;
          return { id: await commands.request({ ...rest, cwd, command, tool: "run_tests" }), note: `测试命令：${command}（用户在本地设置里指定）` };
        }
        const where = await guard.locate(cwd);
        if (!(await fs.stat(where.abs)).isDirectory()) throw new CommandError(`cwd 不是目录：${where.rel}`);
        const found = await detectTestCommand(where.abs, { platform, args });
        if (!found) {
          throw new CommandError(`在 ${where.rel || "."} 里没有识别出测试命令（找过 package.json 的 test 脚本、Cargo.toml、go.mod、.NET 项目文件、pom.xml、build.gradle、pytest 配置、Makefile 的 test 目标）。请让用户在本地设置里填写测试命令，或改用 run_program / run_command 指定`);
        }
        return {
          id: await commands.request({ ...rest, cwd, argv: found.argv, tool: "run_tests" }),
          note: `测试命令：${displayArgv(found.argv)}（依据 ${found.source}）`,
        };
      },
    },

    info: () => [
      `项目根目录：${guard.root}`,
      `系统：${os.type()} ${os.release()}（${platform}，${os.arch()}）`,
      `默认 shell：${commands.defaultShell}，${commands.shells[commands.defaultShell]}${otherShells.length ? `；还可以用 ${otherShells.join("、")}` : ""}`,
      `命令策略：${labels[commands.policy]}`,
      `测试命令：${testCommand ? `${testCommand}（用户指定）` : "run_tests 按项目文件自动识别"}`,
      `文件编码：新文件默认 UTF-8；已有文件保持原来的编码（UTF-8、UTF-16 或系统代码页 ${legacyEncoding}）和换行符`,
      `路径：使用相对项目根目录的路径${platform === "win32" ? "，/ 和 \\ 都可以" : "，用 / 分隔"}；根目录之外的路径会被拒绝`,
    ].join("\n"),
  };
}
