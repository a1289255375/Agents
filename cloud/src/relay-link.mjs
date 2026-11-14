// The plugin's side of the relay. It dials the user's public relay with an HTTP Upgrade (so the home
// machine opens no inbound port), announcing only sha256(token) — never the token. For each request the
// relay forwards, it replays it against the local MCP endpoint and streams the response back frame by
// frame. The link reconnects on its own with backoff, so a dropped tunnel or a relay restart heals.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash } from "node:crypto";
import { createMux } from "./relay-mux.mjs";

const linkPath = "/__relay_link__";
const linkProtocol = "cursor-bridge-relay";
const hopByHop = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host"]);

function localHeaders(headers, hostHeader) {
  const out = { host: hostHeader };
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !hopByHop.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

export function startRelayLink({ relayUrl, token, localHost = "127.0.0.1", localPort, onState = () => {}, log = () => {} }) {
  const url = new URL(relayUrl);
  const secure = url.protocol === "https:";
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const localHostHeader = `${localHost}:${localPort}`;
  let stopped = false;
  let attempt = 0;
  let current = null; // the active upgrade request or mux
  let retimer = null;

  // Replay one forwarded request against the local MCP endpoint and stream the response back.
  function serve(stream, meta) {
    const localReq = httpRequest({ host: localHost, port: localPort, method: meta.method, path: meta.url, headers: localHeaders(meta.headers, localHostHeader) });
    stream.on("data", (chunk) => localReq.write(chunk));
    stream.on("end", () => localReq.end());
    stream.on("reset", () => localReq.destroy());
    localReq.on("response", (res) => {
      stream.head({ status: res.statusCode, headers: res.headers });
      const onDrain = () => res.resume();
      stream.mux.on("drain", onDrain);
      res.on("data", (chunk) => { if (!stream.writeData(chunk)) res.pause(); });
      res.on("end", () => { stream.end(); stream.close(); stream.mux.off("drain", onDrain); });
      res.on("error", () => { stream.reset(); stream.mux.off("drain", onDrain); });
    });
    localReq.on("error", () => stream.reset());
  }

  function scheduleReconnect(reason) {
    if (stopped || retimer) return;
    onState({ state: "down", detail: reason });
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
    attempt++;
    retimer = setTimeout(() => { retimer = null; connect(); }, delay);
    retimer.unref?.();
  }

  function connect() {
    if (stopped) return;
    onState({ state: "connecting" });
    const lib = secure ? httpsRequest : httpRequest;
    const req = lib({
      hostname: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: linkPath,
      method: "GET",
      headers: { Connection: "Upgrade", Upgrade: linkProtocol, "x-bridge-token-hash": tokenHash },
    });
    current = req;
    req.on("upgrade", (_res, socket, head) => {
      attempt = 0;
      const mux = createMux(socket, { role: "plugin", onStream: serve, onClose: (reason) => { if (current === mux) scheduleReconnect(reason); } });
      current = mux;
      if (head?.length) socket.emit("data", head);
      onState({ state: "up", url: `${url.protocol}//${url.host}` });
      log(`relay 链路已连接 ${url.host}`);
    });
    req.on("response", (res) => { res.resume(); scheduleReconnect(`relay 拒绝连接（HTTP ${res.statusCode}）`); });
    req.on("error", (error) => scheduleReconnect(error.code ?? error.message));
    req.end();
  }

  connect();
  return {
    url: `${url.protocol}//${url.host}`,
    stop() {
      stopped = true;
      if (retimer) clearTimeout(retimer);
      if (current && typeof current.close === "function") current.close();
      else current?.destroy?.();
    },
  };
}
