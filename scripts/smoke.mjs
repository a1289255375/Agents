// End-to-end check over real MCP stdio:
//   node scripts/smoke.mjs [--window <title>] [--workspace <folder>] [--model <name>] [--prompt <text>] [--mode <mode>] [--keep]
// Without --prompt it creates an empty session (nothing is sent to a model). The session is stopped at the end.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  options: {
    window: { type: "string" },
    workspace: { type: "string" },
    model: { type: "string" },
    prompt: { type: "string" },
    mode: { type: "string" },
    keep: { type: "boolean" },
  },
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/index.mjs", import.meta.url))],
    env: { ...process.env },
  }),
);

async function call(name, args = {}) {
  const t0 = performance.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text).join("\n");
  console.log(`\n## ${name} ${JSON.stringify(args)} -> ${r.isError ? "ERROR" : "ok"} (${Math.round(performance.now() - t0)} ms)\n${text}`);
  if (r.isError) throw new Error(`${name} failed`);
  return JSON.parse(text);
}

try {
  console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
  const w = opt.window ? { window: opt.window } : {};
  await call("list_windows");
  const models = await call("list_models", w);
  await call("list_workspaces", w);
  const created = await call("create_session", {
    ...w,
    name: "MCP smoke test",
    ...(opt.workspace ? { workspace: opt.workspace } : {}),
    ...(opt.model ? { model: opt.model } : {}),
    ...(opt.prompt ? { prompt: opt.prompt } : {}),
    ...(opt.mode ? { mode: opt.mode } : {}),
  });
  if (opt.model) {
    const wanted = models.find((m) => m.name === opt.model || m.label === opt.model)?.name
      ?? (await call("check_model", { ...w, model: opt.model })).model;
    if (created.model?.name !== wanted) throw new Error(`model not applied: got ${created.model?.name}, wanted ${wanted}`);
  }
  if (created.name !== "MCP smoke test") throw new Error(`name not applied: ${created.name}`);
  const read = await call("read_session", { ...w, id: created.id, waitSeconds: opt.prompt ? 40 : 0 });
  if (opt.prompt) {
    const error = read.messages.find((m) => m.error)?.error;
    if (read.status !== "completed" || !read.messages.some((m) => m.role === "assistant" && m.text)) {
      throw new Error(`Cursor did not finish a reply: ${error?.message ?? read.submitError ?? read.status}`);
    }
    if (!read.messages.some((m) => m.role === "user" && m.text === opt.prompt.trim())) {
      throw new Error("prompt not found in conversation");
    }
  }
  await call("rename_session", { ...w, id: created.id, name: "MCP smoke test (renamed)" });
  const sessions = await call("list_sessions", { ...w, limit: 5 });
  const listed = sessions.find((s) => s.id === created.id);
  if (!listed) throw new Error("created session missing from list_sessions");
  if (listed.name !== "MCP smoke test (renamed)") throw new Error(`rename not visible in list: ${listed.name}`);
  await call("open_session", { ...w, id: created.id });
  if (!opt.keep) await call("stop_session", { ...w, id: created.id });
  console.log("\nsmoke passed");
} finally {
  await client.close();
}
