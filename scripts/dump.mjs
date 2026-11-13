// Dump a session's conversation to a JSON file through the MCP server: node scripts/dump.mjs <id> <out.json> [last] [window]
// Don't run it while the resident cursor-session server is serving a call (both open and close Cursor's inspector).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [id, out, last = "200", window] = process.argv.slice(2);
if (!id || !out) throw new Error("usage: node scripts/dump.mjs <id> <out.json> [last] [window]");
const client = new Client({ name: "dump", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/index.mjs", import.meta.url))],
    env: { ...process.env },
  }),
);
const r = await client.callTool(
  { name: "read_session", arguments: { id, last: Number(last), maxChars: 8000, ...(window ? { window } : {}) } },
  undefined,
  { timeout: 55000 },
);
const text = r.content.map((c) => c.text).join("");
if (r.isError) throw new Error(text);
writeFileSync(out, text, "utf8");
const s = JSON.parse(text);
console.log(`${s.name} | status ${s.status}/${s.agentStatus} | ${s.messageCount} bubbles, ${s.messages.length} messages dumped -> ${out}`);
await client.close();
