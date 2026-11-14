// Starting a program from an argument list, with no shell in between: nothing in an argument is
// interpreted, so the cloud agent does not have to know the quoting rules of the user's shell.
import fs from "node:fs";
import nodePath from "node:path";

const plainArgument = /^[\w@%+=:,./\\-]+$/;
const cmdMetaChars = /([()\][%!^"`<>&|;, *?])/g;

// How the launch is shown to the user for approval and in the activity feed.
export const displayArgv = (argv) => argv.map((arg) => (plainArgument.test(arg) ? arg : `"${arg.replaceAll('"', '\\"')}"`)).join(" ");

// CreateProcess only finds .exe and .com by itself. Developer tools on Windows are often .cmd shims
// (npm, npx, yarn, gradlew), so the search follows PATHEXT like cmd.exe does: working directory first.
export function resolveWindowsProgram(program, cwd, env = process.env, exists = fs.existsSync) {
  const path = nodePath.win32;
  const extensions = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const names = path.extname(program) ? [program] : extensions.map((extension) => program + extension);
  const named = /[\\/]/.test(program) || /^[a-z]:/i.test(program);
  const dirs = named ? [cwd] : [cwd, ...(env.PATH ?? env.Path ?? "").split(";").filter(Boolean)];
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.resolve(dir, name);
      if (exists(full)) return full;
    }
  }
  return undefined;
}

// Quoting for `cmd.exe /d /s /c "<line>"`, the only way to run a batch file. Backslashes before a quote
// are doubled, then every cmd metacharacter gets a caret — twice. A batch file hands %* (or %1…) to the
// real program through a second cmd.exe parse, so one caret is spent reaching the batch file and the
// other has to survive to protect the metacharacter when the body runs; one caret leaves a bare | or &
// for that second parse (`| was unexpected at this time`). cross-spawn only double-escapes node_modules/
// .bin shims, but any forwarding .cmd/.bat needs it, so every argument is escaped twice here.
function cmdArgument(arg) {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(cmdMetaChars, "^$1").replace(cmdMetaChars, "^$1");
}

// The batch file is the command of that first parse only, so its own path is caret-escaped just once.
export function cmdLine(file, args) {
  return [file.replace(cmdMetaChars, "^$1"), ...args.map(cmdArgument)].join(" ");
}

// [file, args, spawn options] for an argument list. Throws when the program cannot be found on Windows;
// elsewhere a missing program surfaces as the spawn error.
export function programLaunch(argv, { platform = process.platform, cwd, env = process.env, exists } = {}) {
  const [program, ...args] = argv;
  if (platform !== "win32") return [program, args, { detached: true }];
  const file = resolveWindowsProgram(program, cwd, env, exists);
  if (!file) throw new Error(`找不到程序 ${program}：工作目录和 PATH 里都没有。检查名字，或给出相对项目根目录的路径`);
  if (/\.(cmd|bat)$/i.test(file)) {
    return [env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${cmdLine(file, args)}"`], { windowsVerbatimArguments: true }];
  }
  return [file, args, {}];
}
