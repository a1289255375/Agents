const byId = (id) => document.getElementById(id);
const list = byId("sessions");
const chat = byId("chat");
const messages = byId("messages");
const input = byId("input");
const send = byId("send");
const status = byId("status");
const notice = byId("notice");
const approvals = byId("approvals");
const policy = byId("policy");
const connectionDialog = byId("connection-dialog");
const confirmDialog = byId("confirm-dialog");
const publicUrl = byId("public-url");
const showToken = byId("show-token");

const statusLabels = {
  waiting: "等待网页消息", working: "处理中", active: "已接入", offline: "未在等待", disconnected: "已断开",
};
const deliveryLabels = { queued: "排队中，等云端领取", delivered: "已送达，处理中", undelivered: "未送达" };
const toolLabels = {
  project_info: "项目信息", list_dir: "列目录", find_files: "查找文件", search_text: "搜索", read_file: "读取",
  write_file: "写入", edit_file: "修改", delete_path: "删除", move_path: "移动", run_command: "命令",
  command_status: "命令状态", stop_command: "终止命令",
};
const jobLabels = {
  awaiting_approval: "等待你确认", running: "运行中", timeout: "超时已终止", stopped: "已终止",
  denied: "已拒绝", expired: "已作废", failed: "无法执行",
};
const timeOptions = { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" };
const shortTime = new Intl.DateTimeFormat("zh-CN", timeOptions);
const fullTime = new Intl.DateTimeFormat("zh-CN", { ...timeOptions, year: "numeric" });
const clockTime = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const maxActivity = 300;

const sessionNodes = new Map();
const itemNodes = new Map();
const approvalNodes = new Map();
// What the agent did on this machine, by entry number. The server only sends entries that changed.
const activity = new Map();
let revision = 0;
let instance;
let bridge;
let sessions = [];
let selected;
let detail;
let immediate = true;
let pollAbort;
let sending = false;
let connection;
let connectionUrl;

async function request(path, { method = "GET", body, signal } = {}) {
  const response = await fetch(path, {
    method, signal,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body && JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `请求失败（HTTP ${response.status}）`);
  return data;
}

function addText(parent, tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  parent.append(element);
  return element;
}

function setStatus(element, text, state) {
  element.textContent = text;
  element.dataset.state = state;
}

function setNotice(text = "") {
  notice.textContent = text;
  notice.hidden = !text;
}

function confirmAction(title, text, okLabel) {
  byId("confirm-title").textContent = title;
  byId("confirm-text").textContent = text;
  byId("confirm-ok").textContent = okLabel;
  confirmDialog.returnValue = "cancel";
  confirmDialog.showModal();
  return new Promise((resolve) => {
    confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue === "ok"), { once: true });
  });
}

async function poll() {
  for (;;) {
    const query = new URLSearchParams({ rev: String(revision) });
    if (selected) query.set("session", selected);
    if (immediate) query.set("now", "1");
    immediate = false;
    pollAbort = new AbortController();
    try {
      apply(await request(`/api/state?${query}`, { signal: pollAbort.signal }));
    } catch (error) {
      // Aborted on purpose: the selection changed and the request must be made again for it.
      if (pollAbort.signal.aborted) continue;
      setStatus(status, "与本机服务的连接中断", "error");
      await new Promise((resolve) => { setTimeout(resolve, 1500); });
      immediate = true;
    }
  }
}

function apply(data) {
  if (instance && data.bridge.instance !== instance) {
    // The bridge was restarted; what this page holds belongs to the old process.
    activity.clear();
    revision = 0;
    instance = data.bridge.instance;
    immediate = true;
    return;
  }
  instance = data.bridge.instance;
  revision = data.rev;
  bridge = data.bridge;
  sessions = data.sessions;
  for (const entry of data.activity) activity.set(entry.n, entry);
  for (const n of [...activity.keys()].slice(0, Math.max(0, activity.size - maxActivity))) activity.delete(n);

  if (!sessions.some(({ id }) => id === selected)) {
    select(sessions[0]?.id);
    return;
  }
  if (data.session?.id === selected) detail = data.session;
  render();
}

function select(id) {
  selected = id;
  detail = undefined;
  itemNodes.clear();
  messages.replaceChildren();
  input.value = "";
  setNotice();
  immediate = true;
  pollAbort?.abort();
  render();
}

function render() {
  if (!bridge) return;
  renderSessions();
  renderBridge();
  renderApprovals();
  renderHeader();
  renderTimeline();
  updateSend();
  if (connectionDialog.open) {
    if (bridge.publicUrl !== connectionUrl) void loadConnection();
    else renderConnection();
  }
  const waiting = bridge.jobs.filter((job) => job.state === "awaiting_approval").length;
  document.title = waiting ? `（${waiting} 条命令待确认）Cursor 云端桥` : "Cursor 云端桥";
}

function sessionName(heading, name, createdAt) {
  const [nameNode, timeNode] = heading.children;
  nameNode.textContent = name;
  timeNode.hidden = !createdAt;
  if (!createdAt) return name;
  timeNode.dateTime = new Date(createdAt).toISOString();
  timeNode.textContent = shortTime.format(createdAt);
  return `${name} · ${fullTime.format(createdAt)}`;
}

function renderSessions() {
  byId("count").textContent = sessions.length;
  const live = new Set(sessions.map(({ id }) => id));
  for (const [id, button] of sessionNodes) {
    if (live.has(id)) continue;
    button.remove();
    sessionNodes.delete(id);
  }
  sessions.forEach((entry, index) => {
    let button = sessionNodes.get(entry.id);
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "session";
      const heading = addText(button, "span", "", "session-heading");
      addText(heading, "span", "", "session-name");
      addText(heading, "time", "", "session-created");
      const meta = addText(button, "span", "", "session-meta");
      addText(meta, "small", "");
      addText(meta, "span", "", "status");
      button.addEventListener("click", () => { if (entry.id !== selected) select(entry.id); });
      sessionNodes.set(entry.id, button);
    }
    const [heading, meta] = button.children;
    const [preview, state] = meta.children;
    button.title = sessionName(heading, entry.name, entry.createdAt);
    preview.textContent = entry.queued ? `${entry.queued} 条消息排队中` : entry.preview ?? "";
    setStatus(state, statusLabels[entry.status], entry.status);
    button.setAttribute("aria-current", String(entry.id === selected));
    if (list.children[index] !== button) list.insertBefore(button, list.children[index] ?? null);
  });
}

function publicState() {
  const { tunnel, selfTest } = bridge;
  if (tunnel?.state === "starting") return ["隧道启动中", "connecting"];
  if (tunnel?.state === "down") return ["隧道已断开", "error"];
  if (!bridge.publicUrl) return ["未填写公网地址", "warn"];
  if (!selfTest) return ["已填写，正在自检", "offline"];
  return selfTest.ok ? ["公网地址可用", "ok"] : ["自检未通过", "warn"];
}

function renderBridge() {
  const root = byId("root");
  // The element is right-to-left so a long path is cut at its start; the mark keeps the text itself in order.
  root.textContent = `\u200e${bridge.root}`;
  root.title = bridge.root;
  const state = byId("public-status");
  setStatus(state, ...publicState());
  state.title = bridge.publicUrl ? `${bridge.publicUrl}/mcp` : "在“连接配置”里填写隧道的公网地址";
  if (document.activeElement !== policy) policy.value = bridge.policy;
  policy.dataset.policy = bridge.policy;
  byId("empty-endpoint").textContent = bridge.localMcpUrl;
}

function sessionLabel(id) {
  return sessions.find((entry) => entry.id === id)?.name ?? (id ? `会话 ${id}` : "未注明会话");
}

async function jobAction(button, path, body) {
  button.disabled = true;
  try {
    await request(path, { method: "POST", body });
    setNotice();
  } catch (error) {
    setNotice(error.message);
    button.disabled = false;
  }
}

function renderApprovals() {
  const jobs = bridge.jobs;
  approvals.hidden = jobs.length === 0;
  const live = new Set(jobs.map(({ id }) => id));
  for (const [id, entry] of approvalNodes) {
    if (live.has(id)) continue;
    entry.node.remove();
    approvalNodes.delete(id);
  }
  jobs.forEach((job, index) => {
    const signature = `${job.state}\n${sessionLabel(job.session)}`;
    let entry = approvalNodes.get(job.id);
    if (entry?.signature !== signature) {
      const node = document.createElement("div");
      node.className = "approval";
      node.dataset.state = job.state;
      const title = addText(node, "div", "", "approval-title");
      const asking = job.state === "awaiting_approval";
      addText(title, "strong", asking ? "云端 Agent 请求执行命令" : `命令运行中（${clockTime.format(job.startedAt)} 开始）`);
      addText(title, "small", `${job.id} · ${sessionLabel(job.session)} · ${job.shell} · 目录 ${job.cwd}`);
      addText(node, "pre", job.command);
      const actions = addText(node, "div", "", "approval-actions");
      const action = (label, className, path, body) => {
        const button = addText(actions, "button", label, className);
        button.type = "button";
        button.addEventListener("click", () => jobAction(button, path, body));
      };
      if (asking) {
        action("允许一次", "primary", `/api/jobs/${job.id}/decision`, { decision: "allow" });
        action("始终允许这条命令", "", `/api/jobs/${job.id}/decision`, { decision: "always" });
        action("拒绝", "danger", `/api/jobs/${job.id}/decision`, { decision: "deny" });
      } else {
        action("终止", "danger", `/api/jobs/${job.id}/stop`);
      }
      entry?.node.replaceWith(node);
      entry = { node, signature };
      approvalNodes.set(job.id, entry);
    }
    if (approvals.children[index] !== entry.node) approvals.insertBefore(entry.node, approvals.children[index] ?? null);
  });
}

function hintText(entry) {
  if (!entry || entry.closed) return "";
  const lines = [];
  if (entry.status === "offline") {
    lines.push("云端已有一阵没有调用本服务，它那一轮可能已经结束。现在发的消息会排队，等它再次等待时送达；可以到 Cursor 里对它说“继续等待网页消息”，或重新发送提示词。");
  }
  // Limits of clients and proxies are 30 seconds and up; anything shorter was a dropped connection.
  if (entry.hint?.afterMs >= 25_000) {
    const { afterMs, holdMs } = entry.hint;
    const after = Math.round(afterMs / 1000);
    const suggestion = Math.max(5, Math.floor((after - 5) / 5) * 5);
    lines.push(`上一次 wait_message 在第 ${after} 秒被对端切断（设定 ${Math.round(holdMs / 1000)} 秒）。偶尔一次可以忽略；反复出现时，重启本服务并加上 --wait-seconds ${suggestion}。`);
  }
  return lines.join("\n");
}

function renderHeader() {
  const entry = sessions.find(({ id }) => id === selected);
  const title = byId("title");
  title.title = sessionName(title, entry?.name ?? "云端会话", entry?.createdAt);
  const subtitle = byId("subtitle");
  subtitle.hidden = !entry;
  if (entry) {
    const waiting = entry.waiting && `${entry.waiting.via === "shell" ? "Shell 等待" : "wait_message"} 挂起中，单次最长 ${Math.round(entry.waiting.holdMs / 1000)} 秒`;
    subtitle.textContent = [`会话 ${entry.id}`, waiting, entry.queued && `${entry.queued} 条消息排队中`].filter(Boolean).join(" · ");
  }
  if (entry) setStatus(status, statusLabels[entry.status], entry.status);
  else setStatus(status, "等待云端接入", "offline");
  byId("disconnect").hidden = !entry || Boolean(entry.closed);
  byId("delete").hidden = !entry;
  const hint = byId("session-hint");
  hint.textContent = hintText(entry);
  hint.hidden = !hint.textContent;
  byId("empty").hidden = Boolean(entry);
  messages.hidden = !entry;
  byId("composer-area").hidden = !entry;
}

function updateSend() {
  const entry = sessions.find(({ id }) => id === selected);
  input.disabled = !entry || Boolean(entry.closed);
  input.placeholder = entry?.closed ? "会话已断开，不能再发送" : "给云端 Agent 下指令（Ctrl+Enter 发送）";
  send.disabled = input.disabled || sending || !input.value.trim();
}

function addInline(parent, text) {
  // Replies are untrusted text. Formatting is recognized and built from text nodes, never injected as HTML.
  const tokens = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let end = 0;
  for (const match of text.matchAll(tokens)) {
    const [, code, bold, label, url] = match;
    parent.append(text.slice(end, match.index));
    if (code) addText(parent, "code", code);
    else if (bold) addText(parent, "strong", bold);
    else {
      const link = addText(parent, "a", label);
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    end = match.index + match[0].length;
  }
  parent.append(text.slice(end));
}

function addResponse(parent, text) {
  const body = addText(parent, "div", "", "response");
  const lines = text.split(/\r?\n/);
  const block = /^( {0,3})(`{3,}|#{1,6}\s+|>\s?|-\s+|\*\s+|\+\s+|\d+\.\s+)(.*)$/;
  let paragraph;
  let items;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      paragraph = items = undefined;
      continue;
    }
    const match = block.exec(line);
    if (!match) {
      items = undefined;
      if (!paragraph) paragraph = addText(body, "p", "");
      else paragraph.append("\n");
      addInline(paragraph, line);
      continue;
    }
    const [, , marker, content] = match;
    paragraph = undefined;
    if (/^(?:[-*+]|\d+\.)\s/.test(marker)) {
      const tag = /^\d/.test(marker) ? "ol" : "ul";
      if (items?.localName !== tag) {
        items = addText(body, tag, "");
        if (tag === "ol") items.start = Number.parseInt(marker, 10);
      }
      addInline(addText(items, "li", ""), content);
      continue;
    }
    items = undefined;
    if (marker.startsWith("`")) {
      const code = [];
      const closingFence = new RegExp(`^ {0,3}\x60{${marker.length},}\\s*$`);
      while (++i < lines.length && !closingFence.test(lines[i])) code.push(lines[i]);
      const frame = addText(body, "div", "", "code-frame");
      if (content.trim()) addText(frame, "div", content.trim(), "code-language");
      addText(addText(frame, "pre", ""), "code", code.join("\n"));
    } else if (marker.startsWith("#")) {
      addInline(addText(body, `h${Math.max(2, marker.trim().length)}`, ""), content);
    } else {
      addInline(addText(body, "blockquote", ""), content);
    }
  }
}

function addToolSection(tool, label, content, style = "") {
  const section = addText(tool, "div", "", "tool-section");
  const heading = addText(section, "div", "", "tool-section-label");
  addText(heading, "span", label);
  const pre = addText(section, "pre", "", `tool-output ${style}`.trim());
  if (style !== "tool-diff") {
    pre.textContent = content;
    return heading;
  }
  for (const line of content.split("\n")) {
    addText(pre, "span", line, line.startsWith("+") ? "diff-added" : line.startsWith("-") ? "diff-removed" : line.startsWith("@@") ? "diff-hunk" : "");
  }
  return heading;
}

function jobBadge(job) {
  if (job.state === "exited") return [job.exitCode === 0 ? "已结束" : `退出码 ${job.exitCode ?? "无"}`, job.exitCode === 0 ? "" : "error"];
  const state = job.state === "awaiting_approval" ? "pending" : job.state === "running" ? "running"
    : ["stopped", "expired"].includes(job.state) ? "" : "error";
  return [jobLabels[job.state], state];
}

function addActivity(node, { tool, ok, target, summary, diff, detail: result, error, job, session }) {
  const expandable = Boolean(error || diff || result || job);
  const card = addText(node, expandable ? "details" : "div", "", "tool");
  const row = addText(card, expandable ? "summary" : "div", "", "tool-row");
  addText(row, "span", "›_", "tool-icon").setAttribute("aria-hidden", "true");
  addText(row, "span", toolLabels[tool] ?? tool, "tool-name");
  if (target) addText(row, "span", target, "tool-preview").title = target;
  const [label, state] = job ? jobBadge(job) : ok ? [summary ?? "", ""] : ["失败", "error"];
  const badge = [label, session === undefined && "未注明会话"].filter(Boolean).join(" · ");
  if (badge) addText(row, "span", badge, "tool-status").dataset.state = state;

  if (error) addToolSection(card, "错误", error, "tool-error wrap");
  if (diff) addToolSection(card, "文件改动", diff, "tool-diff");
  if (result) addToolSection(card, "结果", result);
  if (!job) return;
  if (job.error) addToolSection(card, "错误", job.error, "tool-error wrap");
  if (!job.startedAt) {
    addText(card, "p", `${job.id} · ${job.shell} · 目录 ${job.cwd} · 没有执行`, "tool-section-label");
    return;
  }
  const omitted = job.outputChars > job.outputTail.length ? `（只显示最后 ${job.outputTail.length} 个字符）` : "";
  const heading = addToolSection(card, `${job.id} · ${job.shell} · 目录 ${job.cwd}${omitted}`, job.outputTail || "（暂无输出）", "job-output");
  if (job.state === "running") {
    const stop = addText(heading, "button", "终止");
    stop.type = "button";
    stop.addEventListener("click", () => jobAction(stop, `/api/jobs/${job.id}/stop`));
  }
}

function buildItem(item) {
  const node = document.createElement("article");
  if (item.entry) {
    node.className = "message assistant activity";
    addActivity(node, item.entry);
    return node;
  }
  node.className = `message ${item.role === "user" ? "user" : item.role === "assistant" ? "assistant" : item.role}`;
  if (item.role === "assistant") {
    node.setAttribute("aria-label", "云端 Agent");
    addResponse(node, item.text);
  } else {
    if (item.role === "user") node.setAttribute("aria-label", "你");
    addText(node, "p", item.text, "message-text");
  }
  if (deliveryLabels[item.state]) addText(node, "small", deliveryLabels[item.state], `delivery-status ${item.state}`);
  node.title = fullTime.format(item.at);
  return node;
}

function timelineItems() {
  if (!detail) return [];
  const items = detail.timeline.map((item) => ({ key: `m${item.n}`, ...item }));
  for (const entry of activity.values()) {
    // Calls without a session argument cannot be attributed; they are shown rather than hidden.
    if (entry.session === selected || (entry.session === undefined && entry.at >= detail.createdAt)) {
      items.push({ key: `a${entry.n}`, at: entry.at, entry });
    }
  }
  return items.sort((a, b) => a.at - b.at);
}

function renderTimeline() {
  const items = timelineItems();
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 48;
  const live = new Set(items.map(({ key }) => key));
  for (const [key, entry] of itemNodes) {
    if (live.has(key)) continue;
    entry.node.remove();
    itemNodes.delete(key);
  }
  items.forEach((item, index) => {
    const signature = JSON.stringify(item);
    let entry = itemNodes.get(item.key);
    if (entry?.signature !== signature) {
      const node = buildItem(item);
      const card = node.querySelector("details.tool");
      const job = item.entry?.job;
      // A command card opens by itself while it needs attention; afterwards it stays as the user left it.
      if (card) card.open = entry?.node.querySelector("details.tool")?.open ?? Boolean(job && ["awaiting_approval", "running"].includes(job.state));
      entry?.node.replaceWith(node);
      entry = { node, signature };
      itemNodes.set(item.key, entry);
      if (messages.children[index] !== node) messages.insertBefore(node, messages.children[index] ?? null);
      const output = node.querySelector(".job-output");
      if (output) output.scrollTop = output.scrollHeight;
    } else if (messages.children[index] !== entry.node) {
      messages.insertBefore(entry.node, messages.children[index] ?? null);
    }
  });
  if (atBottom) chat.scrollTop = chat.scrollHeight;
}

input.addEventListener("input", updateSend);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    byId("form").requestSubmit();
  }
});

byId("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (send.disabled) return;
  const id = selected;
  const text = input.value;
  sending = true;
  setNotice();
  updateSend();
  try {
    const session = await request(`/api/sessions/${id}/messages`, { method: "POST", body: { text } });
    if (selected === id) {
      if (input.value === text) input.value = "";
      detail = session;
      renderTimeline();
      chat.scrollTop = chat.scrollHeight;
    }
  } catch (error) {
    if (selected === id) setNotice(error.message);
  } finally {
    sending = false;
    updateSend();
  }
});

byId("disconnect").addEventListener("click", async () => {
  const id = selected;
  const sure = await confirmAction("断开这个会话？", "云端 Agent 会收到断开通知并停止等待，之后不能再给这个会话发消息。对话记录保留在本页，直到删除会话或关闭本服务。", "断开");
  if (!sure) return;
  try {
    await request(`/api/sessions/${id}/disconnect`, { method: "POST" });
  } catch (error) {
    setNotice(error.message);
  }
});

byId("delete").addEventListener("click", async () => {
  const id = selected;
  const sure = await confirmAction("删除这个会话？", "会话和它的消息会从本页移除；云端 Agent 若还在等待，会收到断开通知。", "删除");
  if (!sure) return;
  try {
    await request(`/api/sessions/${id}`, { method: "DELETE" });
  } catch (error) {
    setNotice(error.message);
  }
});

policy.addEventListener("change", async () => {
  const next = policy.value;
  if (next === "allow") {
    const sure = await confirmAction(
      "全部允许命令？",
      "之后云端 Agent 发来的每一条命令都会直接在这台电脑上执行，不再询问你。拿到访问令牌的任何人也能执行命令。只在你盯着它干活、并且信任当前任务时使用。",
      "全部允许",
    );
    if (!sure) {
      policy.value = bridge.policy;
      return;
    }
  }
  try {
    await request("/api/policy", { method: "POST", body: { policy: next } });
  } catch (error) {
    policy.value = bridge.policy;
    setNotice(error.message);
  }
});

function masked(text) {
  return showToken.checked ? text : text.replaceAll(connection.token, "•".repeat(12));
}

function renderConnection() {
  byId("local-endpoint").textContent = bridge.localMcpUrl;
  const { selfTest, tunnel, observedUrl, unauthorized } = bridge;
  const result = byId("public-result");
  result.hidden = !selfTest;
  if (selfTest) {
    result.textContent = `${selfTest.ok ? "自检通过" : "自检未通过"}：${selfTest.message}`;
    result.dataset.state = selfTest.ok ? "ok" : "error";
  }
  const tunnelState = byId("tunnel-state");
  tunnelState.hidden = !tunnel;
  if (tunnel) {
    tunnelState.textContent = {
      starting: "cloudflared 隧道启动中……",
      up: `cloudflared 快速隧道已建立：${tunnel.url}。这个地址每次启动都会变，变了要同步修改云端 MCP 配置里的 URL。`,
      down: `隧道已断开：${tunnel.error}`,
    }[tunnel.state];
  }
  const observed = byId("observed");
  observed.hidden = !observedUrl || observedUrl === bridge.publicUrl;
  observed.textContent = `云端最近一次是通过 ${observedUrl} 访问到本服务的。`;
  const rejected = byId("unauthorized");
  rejected.hidden = !unauthorized;
  rejected.textContent = `收到过 ${unauthorized} 次令牌不正确的请求。如果是你刚配置完，请检查请求头是否为“Authorization: Bearer 令牌”；否则说明有人在探测这个地址。`;
  if (!connection) return;
  byId("server-name").textContent = connection.serverName;
  byId("server-url").textContent = connection.url;
  byId("server-header-name").textContent = "Authorization";
  byId("server-header-value").textContent = masked(connection.authorization);
  byId("server-config").textContent = masked(connection.config);
  byId("prompt").textContent = connection.prompt;
}

async function loadConnection() {
  connectionUrl = bridge.publicUrl;
  const error = byId("connection-error");
  try {
    connection = await request("/api/connection");
    error.hidden = true;
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
  }
  renderConnection();
}

function openConnection() {
  publicUrl.value = bridge?.publicUrl ?? "";
  connectionDialog.showModal();
  if (bridge) void loadConnection();
}

byId("open-connection").addEventListener("click", openConnection);
byId("empty-connection").addEventListener("click", openConnection);
showToken.addEventListener("change", renderConnection);

byId("public-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = byId("public-save");
  const failure = byId("public-error");
  button.disabled = true;
  button.textContent = "自检中……";
  failure.hidden = true;
  try {
    // The self-test result itself arrives with the state, like every other change.
    const outcome = await request("/api/public-url", { method: "POST", body: { url: publicUrl.value } });
    publicUrl.value = outcome.url ?? "";
  } catch (error) {
    failure.textContent = error.message;
    failure.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "保存并自检";
  }
});

connectionDialog.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-copy]");
  if (!button || !connection) return;
  const text = {
    serverName: connection.serverName, url: connection.url, headerName: "Authorization",
    headerValue: connection.authorization, config: connection.config, prompt: connection.prompt,
  }[button.dataset.copy];
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // The clipboard API can be refused; selecting hidden text and copying it works everywhere.
    const area = addText(connectionDialog, "textarea", text, "sr-only");
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  button.textContent = "已复制";
  setTimeout(() => { button.textContent = "复制"; }, 1200);
});

void poll();
