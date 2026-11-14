import assert from "node:assert/strict";
import test from "node:test";
import { originOf, waitingHtml, webviewHtml } from "../lib/webview.mjs";

test("originOf returns the scheme/host/port, or undefined for junk", () => {
  assert.equal(originOf("http://127.0.0.1:3220/"), "http://127.0.0.1:3220");
  assert.equal(originOf("https://abc.trycloudflare.com/mcp"), "https://abc.trycloudflare.com");
  assert.equal(originOf("not a url"), undefined);
});

test("webviewHtml frames the console and locks the CSP to its origin", () => {
  const html = webviewHtml({ iframeSrc: "http://localhost:3220/", frameOrigin: "http://localhost:3220", consoleUrl: "http://127.0.0.1:3220/" });
  assert.match(html, /<iframe src="http:\/\/localhost:3220\/"/);
  assert.match(html, /frame-src http:\/\/localhost:3220;/);
  assert.match(html, /default-src 'none'/);
  // The fallback shows the loopback address the user can open in a browser.
  assert.match(html, /127\.0\.0\.1:3220/);
});

test("webviewHtml escapes a hostile value instead of injecting it", () => {
  const html = webviewHtml({ iframeSrc: 'http://x/"><script>alert(1)</script>', frameOrigin: "http://x", consoleUrl: "http://x" });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test("webviewHtml falls back to a message when the console is not up", () => {
  assert.match(webviewHtml({}), /云端桥还没有启动/);
  assert.match(waitingHtml("停了"), /停了/);
});
