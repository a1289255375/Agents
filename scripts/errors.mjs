// Error paths over real MCP stdio: node scripts/errors.mjs [--window <title>]
// Every case must fail with the expected message and must not leave a new session behind.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({ options: { window: { type: "string" } } });
const w = opt.window ? { window: opt.window } : {};
const client = new Client({ name: "errors", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/index.mjs", import.meta.url))],
  }),
);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: r.content.map((c) => c.text).join("\n") };
};
const count = async () => JSON.parse((await call("list_sessions", { ...w, limit: 500, includeArchived: true })).text).length;

const before = await count();
const cases = [
  ["create_session", { ...w, model: "no-such-model" }, /没有模型「no-such-model」/],
  ["create_session", { ...w, mode: "no-such-mode" }, /没有模式「no-such-mode」/],
  ["create_session", { ...w, workspace: "Q:\\no\\such\\folder" }, /文件夹不存在/],
  ["create_session", { ...w, workspace: fileURLToPath(import.meta.url) }, /不是文件夹/],
  ["read_session", { ...w, id: "00000000-0000-0000-0000-000000000000" }, /找不到会话/],
  ["send_message", { ...w, id: "00000000-0000-0000-0000-000000000000", text: "x" }, /找不到会话/],
  ["list_models", { window: "no-such-window" }, /没有标题包含「no-such-window」/],
  ["send_message", { ...w, id: "x", text: "" }, /too_small|>=1|at least/i],
];
let failed = 0;
for (const [name, args, expect] of cases) {
  const r = await call(name, args);
  const ok = r.isError && expect.test(r.text);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(args)}\n     ${r.text.split("\n")[0].slice(0, 160)}`);
}
const after = await count();
console.log(`sessions before ${before}, after ${after}`);
if (after !== before) failed++;
await client.close();
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all error paths ok");
