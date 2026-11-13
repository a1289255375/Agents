// Block until a session needs the commander, without spending tokens on polling:
//   node scripts/watch.mjs [--window <title>] [--interval 60] <sessionId> [sessionId...]
// Prints one status line per poll, then "WATCH-EVENT <id> <reason>" and exits when a session stops generating,
// waits for a command approval, or needs attention. While it runs, don't call the resident cursor-session server:
// both would open and close Cursor's inspector and could cut each other's calls.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: opt, positionals: ids } = parseArgs({
  allowPositionals: true,
  options: { window: { type: "string" }, interval: { type: "string" } },
});
if (ids.length === 0) throw new Error("usage: node scripts/watch.mjs [--window <title>] [--interval 60] <sessionId>...");
const interval = Number(opt.interval ?? 60) * 1000;
const time = () => new Date().toLocaleTimeString("en-GB");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new Client({ name: "watch", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/index.mjs", import.meta.url))],
    env: { ...process.env },
  }),
);

async function finish(line) {
  console.log(line);
  await client.close();
  process.exit(0);
}

let failures = 0;
for (;;) {
  for (const id of ids) {
    let s;
    try {
      const r = await client.callTool(
        { name: "read_session", arguments: { ...(opt.window ? { window: opt.window } : {}), id, last: 3, maxChars: 200 } },
        undefined,
        { timeout: 55000 },
      );
      const text = r.content.map((c) => c.text).join("");
      if (r.isError) throw new Error(text);
      s = JSON.parse(text);
      failures = 0;
    } catch (e) {
      failures++;
      console.log(`${time()} ${id.slice(0, 8)} read failed (${failures}): ${String(e.message).slice(0, 160)}`);
      if (failures >= 5) await finish(`WATCH-EVENT ${id} read-failed`);
      continue;
    }
    const approval = s.messages.some((m) => m.tool?.awaitingApproval);
    console.log(`${time()} ${id.slice(0, 8)} status=${s.status} agent=${s.agentStatus} msgs=${s.messageCount}${approval ? " APPROVAL" : ""}`);
    if (s.status !== "generating" || approval || s.agentStatus === "needs_attention") {
      await finish(`WATCH-EVENT ${id} ${s.status}/${s.agentStatus}${approval ? "/approval" : ""}`);
    }
  }
  await sleep(interval);
}
