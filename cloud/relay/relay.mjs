// The relay's routing logic, kept free of TLS so tests can drive it over a plain HTTP server.
// A plugin dials in with an HTTP Upgrade to /__relay_link__, announcing sha256(token) in a header; the
// relay remembers that one link in memory (never the token itself) and forwards every Cursor request
// whose bearer hashes to the same value down the link's mux. `GET /` with no bearer answers the relay's
// own health, so `curl https://<server>/` proves TLS without a token; the token-less self-test and the
// wt_-ticket /wait path fall back to the sole link, which covers the one-plugin case this serves.
import { createHash } from "node:crypto";
import { createMux, pumpInto } from "../src/relay-mux.mjs";

const linkPath = "/__relay_link__";
const linkProtocol = "cursor-bridge-relay";
const hopByHop = new Set([
  "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer",
  "content-length", "host",
]);

const sha256hex = (value) => createHash("sha256").update(value).digest("hex");
const bearerOf = (req) => /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "")?.[1];

function forwardHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !hopByHop.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

function sendJson(res, status, data, extra) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra });
  res.end(body);
}

export function createRelay({ maxLinks = 16, maxStreamsPerLink = 512, log = () => {} } = {}) {
  const links = new Map(); // tokenHash(hex) -> link

  function dropLink(hash, link) {
    if (links.get(hash) === link) {
      links.delete(hash);
      log(`link down (${hash.slice(0, 8)}…)，当前连接数 ${links.size}`);
    }
  }

  function handleUpgrade(req, socket, head) {
    const { pathname } = new URL(req.url, "http://relay.invalid");
    const hash = req.headers["x-bridge-token-hash"];
    if (pathname !== linkPath || (req.headers.upgrade ?? "").toLowerCase() !== linkProtocol || !/^[0-9a-f]{64}$/.test(hash ?? "")) {
      socket.destroy();
      return;
    }
    if (!links.has(hash) && links.size >= maxLinks) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${linkProtocol}\r\nConnection: Upgrade\r\n\r\n`);
    const link = { hash, mux: null, streams: 0 };
    link.mux = createMux(socket, { role: "relay", onClose: () => dropLink(hash, link) });
    const existing = links.get(hash);
    if (existing) existing.mux.close(); // the plugin reconnected; retire the old link
    links.set(hash, link);
    if (head?.length) socket.emit("data", head);
    log(`link up (${hash.slice(0, 8)}…)，当前连接数 ${links.size}`);
  }

  // Pick the link for a request: by bearer hash when it matches, otherwise the sole link for the
  // token-less GET / self-test and the wt_-ticket /wait path.
  function routeFor(req, pathname) {
    const bearer = bearerOf(req);
    if (bearer) {
      const link = links.get(sha256hex(bearer));
      if (link) return link;
    }
    if (pathname !== "/mcp" && links.size === 1) return [...links.values()][0];
    return undefined;
  }

  function forward(link, req, res) {
    if (link.streams >= maxStreamsPerLink) return sendJson(res, 503, { error: "too many concurrent streams" });
    link.streams++;
    let responded = false;
    let settled = false;
    const finish = () => { if (!settled) { settled = true; link.streams--; } };
    const stream = link.mux.open({ method: req.method, url: req.url, headers: forwardHeaders(req.headers) });
    stream.on("head", (meta) => { responded = true; res.writeHead(meta.status, forwardHeaders(meta.headers)); });
    stream.on("data", (chunk) => res.write(chunk));
    stream.on("end", () => { res.end(); stream.close(); finish(); });
    stream.on("reset", () => {
      if (!responded) res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(responded ? undefined : JSON.stringify({ error: "bridge link dropped" }));
      finish();
    });
    pumpInto(req, stream);
    res.on("close", () => { if (!stream.closed) stream.reset(); finish(); });
  }

  function handleRequest(req, res) {
    const { pathname } = new URL(req.url, "http://relay.invalid");
    if (req.method === "GET" && (pathname === "/__relay_health__" || (pathname === "/" && !bearerOf(req)))) {
      return sendJson(res, 200, { service: "cursor-bridge-relay", ok: true, links: links.size });
    }
    const link = routeFor(req, pathname);
    if (!link) {
      if (pathname === "/mcp") return sendJson(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: token has no connected bridge" }, id: null }, { "WWW-Authenticate": "Bearer" });
      return sendJson(res, 503, { error: "no bridge connected" });
    }
    forward(link, req, res);
  }

  return {
    handleRequest,
    handleUpgrade,
    get linkCount() { return links.size; },
    close() { for (const link of links.values()) link.mux.close(); links.clear(); },
  };
}
