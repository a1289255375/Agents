// Finds the command that runs a project's tests, so the cloud agent can ask for "run the tests"
// without guessing the toolchain or composing a command line for the user's shell.
import fs from "node:fs/promises";
import nodePath from "node:path";

const npmPlaceholder = /no test specified/;
const lockfiles = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lockb", "bun"], ["bun.lock", "bun"]];
const dotnetProject = /\.(sln|slnx|csproj|fsproj|vbproj)$/i;
const pythonTest = /^(test_.*|.*_test)\.py$/;

// { argv, source } for the directory, or undefined when no known test setup is found there.
export async function detectTestCommand(dir, { platform = process.platform, args = [] } = {}) {
  const names = new Set(await fs.readdir(dir));
  const read = (name) => fs.readFile(nodePath.join(dir, name), "utf8").catch(() => "");
  const has = (...candidates) => candidates.find((name) => names.has(name));
  const found = (source, argv) => ({ source, argv: [...argv, ...args] });

  if (names.has("package.json")) {
    let script;
    try {
      script = JSON.parse(await read("package.json")).scripts?.test;
    } catch {}
    if (typeof script === "string" && !npmPlaceholder.test(script)) {
      const manager = lockfiles.find(([lockfile]) => names.has(lockfile))?.[1] ?? "npm";
      // npm swallows options meant for the test runner unless they come after "--".
      const runner = manager === "npm" ? ["npm", "test", ...(args.length ? ["--"] : [])] : manager === "bun" ? ["bun", "run", "test"] : [manager, "test"];
      return found(`package.json 的 test 脚本（${manager}）`, runner);
    }
  }
  if (names.has("Cargo.toml")) return found("Cargo.toml", ["cargo", "test"]);
  if (names.has("go.mod")) return found("go.mod", ["go", "test", "./..."]);
  const dotnet = [...names].find((name) => dotnetProject.test(name));
  if (dotnet) return found(dotnet, ["dotnet", "test"]);
  if (names.has("pom.xml")) {
    const wrapper = platform === "win32" ? has("mvnw.cmd") : has("mvnw") && "./mvnw";
    return found("pom.xml", [wrapper || "mvn", "test"]);
  }
  const gradle = has("build.gradle.kts", "build.gradle");
  if (gradle) {
    const wrapper = platform === "win32" ? has("gradlew.bat") : has("gradlew") && "./gradlew";
    return found(gradle, [wrapper || "gradle", "test"]);
  }
  const python = platform === "win32" ? "python" : "python3";
  const pytestConfig = has("pytest.ini", "conftest.py") ?? (/\[tool\.pytest/.test(await read("pyproject.toml")) ? "pyproject.toml" : undefined);
  if (pytestConfig) return found(pytestConfig, [python, "-m", "pytest"]);
  for (const testDir of ["tests", "test"]) {
    if (!names.has(testDir)) continue;
    const entries = await fs.readdir(nodePath.join(dir, testDir)).catch(() => []);
    if (entries.some((name) => pythonTest.test(name))) return found(`${testDir}/ 里的 Python 测试`, [python, "-m", "pytest"]);
  }
  const makefile = has("Makefile", "makefile", "GNUmakefile");
  if (makefile && /^test\s*:/m.test(await read(makefile))) return found(`${makefile} 的 test 目标`, ["make", "test"]);
  return undefined;
}
