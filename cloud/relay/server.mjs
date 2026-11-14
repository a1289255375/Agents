// The relay process the user runs on their public server. It listens on one port (443 in production),
// terminates TLS with the Let's Encrypt IP certificate, and hands every request and link upgrade to the
// routing logic. When the renewal timer rewrites the cert it reloads in place, so active plugin links
// survive. With no cert configured it falls back to plain HTTP for a high-port deployment or for tests.
//
//   RELAY_PORT=443 RELAY_CERT=/path/fullchain.pem RELAY_KEY=/path/key.pem node cloud/relay/server.mjs
import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { readFileSync, watch } from "node:fs";
import { createRelay } from "./relay.mjs";

const port = Number(process.env.RELAY_PORT || 443);
const host = process.env.RELAY_HOST || "0.0.0.0";
const certPath = process.env.RELAY_CERT;
const keyPath = process.env.RELAY_KEY;
const maxLinks = Number(process.env.RELAY_MAX_LINKS || 16);

const log = (message) => console.log(`[relay] ${new Date().toISOString()} ${message}`);
const relay = createRelay({ maxLinks, log });

function tlsFiles() {
  return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
}

let server;
if (certPath && keyPath) {
  server = createHttps({ ...tlsFiles() }, relay.handleRequest);
  watchCert(server);
  log(`TLS 模式，证书 ${certPath}`);
} else {
  server = createHttp(relay.handleRequest);
  log("明文 HTTP 模式（未配置证书）");
}
server.on("upgrade", relay.handleUpgrade);
server.requestTimeout = 0; // long-poll waits must not be cut off by the server
server.headersTimeout = 60_000;
server.keepAliveTimeout = 75_000;

server.listen(port, host, () => log(`监听 ${host}:${port}，上限 ${maxLinks} 条链路`));
server.on("error", (error) => { log(`监听失败：${error.code ?? error.message}`); process.exit(1); });

// Reload the certificate in place when the renewal timer rewrites it (debounced; the writer may touch
// both files). A transient read error during the write is retried on the next event.
function watchCert(httpsServer) {
  let pending = null;
  const reload = () => {
    pending = null;
    try {
      httpsServer.setSecureContext(tlsFiles());
      log("已重新加载证书");
    } catch (error) {
      log(`证书重载失败，稍后重试：${error.code ?? error.message}`);
    }
  };
  for (const file of [certPath, keyPath]) {
    try {
      watch(file, () => { if (!pending) pending = setTimeout(reload, 1000); }).unref?.();
    } catch { /* the directory may not be watchable; the renewal hook can restart the service instead */ }
  }
}

process.on("SIGTERM", () => { relay.close(); server.close(() => process.exit(0)); });
process.on("SIGINT", () => { relay.close(); server.close(() => process.exit(0)); });
