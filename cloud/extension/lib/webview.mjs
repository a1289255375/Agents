// The panel shown inside the IDE. It embeds the same web console the standalone bridge serves, so the
// session list, thinking, progress, file diffs and command approvals are exactly the browser console.
// Kept vscode-free and pure so the markup and its CSP can be unit-tested.

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
));

export const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

// `iframeSrc` is the console address the webview can reach (an asExternalUri / port-mapped localhost
// URL); `frameOrigin` is its scheme+host+port for the frame-src directive.
export function webviewHtml({ iframeSrc, frameOrigin, consoleUrl } = {}) {
  if (!iframeSrc || !frameOrigin) {
    return waitingHtml("云端桥还没有启动。设置工作区目录后，用命令“Cursor 云端桥：打开控制台”再试。");
  }
  const src = escapeHtml(iframeSrc);
  const origin = escapeHtml(frameOrigin);
  const shown = escapeHtml(consoleUrl ?? iframeSrc);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline';">
<style>
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; background: var(--vscode-editor-background, #1e1e1e); color: var(--vscode-foreground, #ccc); font: 13px var(--vscode-font-family, sans-serif); }
  iframe { flex: 1 1 auto; width: 100%; border: 0; }
  .fallback { padding: 8px 12px; font-size: 12px; opacity: .75; }
  .fallback code { background: var(--vscode-textCodeBlock-background, rgba(255,255,255,.08)); padding: 1px 4px; border-radius: 3px; }
</style>
</head>
<body>
  <iframe src="${src}" title="Cursor 云端桥控制台" allow="clipboard-read; clipboard-write"></iframe>
  <p class="fallback">面板空白时，用命令“Cursor 云端桥：在浏览器中打开控制台”，或手动打开 <code>${shown}</code>。</p>
</body>
</html>`;
}

export function waitingHtml(message) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { margin: 0; padding: 24px; background: var(--vscode-editor-background, #1e1e1e); color: var(--vscode-foreground, #ccc); font: 13px var(--vscode-font-family, sans-serif); }
</style>
</head>
<body><p>${escapeHtml(message)}</p></body>
</html>`;
}
