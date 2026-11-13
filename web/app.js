const byId = (id) => document.getElementById(id);
const list = byId("sessions");
const chat = byId("chat");
const messages = byId("messages");
const input = byId("input");
const send = byId("send");
const status = byId("status");
const notice = byId("notice");
const empty = byId("empty");
const sessionDetails = byId("session-details");
const sessionModel = byId("session-model");
const contextProgress = byId("context-progress");
const contextValue = byId("context-value");
const dispatchError = byId("session-dispatch-error");
const openDelete = byId("open-delete");
const toggleBatch = byId("toggle-batch");
const batchActions = byId("batch-actions");
const selectAll = byId("select-all");
const openBatchDelete = byId("open-batch-delete");
const deleteDialog = byId("delete-dialog");
const deleteTitle = byId("delete-title");
const deleteTargetList = byId("delete-targets");
const deleteCursor = byId("delete-cursor");
const deleteWarning = byId("delete-cursor-warning");
const deleteError = byId("delete-error");
const cancelDelete = byId("cancel-delete");
const confirmDelete = byId("confirm-delete");
const modelParameterLabels = {
  context: "上下文", effort: "推理", reasoning: "推理", reasoning_effort: "推理", thinking: "Thinking", fast: "Fast",
};
const tokenFormat = new Intl.NumberFormat("zh-CN");
const percentFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const toolStatusLabels = {
  completed: "已完成", error: "失败", failed: "失败", cancelled: "已取消", canceled: "已取消",
  aborted: "已中止", loading: "运行中", running: "运行中", pending: "等待执行",
};
const toolOutcomeLabels = {
  failure: "执行失败", error: "执行失败", rejected: "已拒绝", timeout: "已超时",
  permissionDenied: "权限不足", readPermissionDenied: "读取权限不足", writePermissionDenied: "写入权限不足",
  fileNotFound: "文件不存在", spawnError: "无法启动进程", async: "等待结果",
};
const labels = {
  generating: "生成中", completed: "已完成", aborted: "已中止", none: "已接入",
  waiting: "等待网页消息", responding: "Cursor 处理中", queued: "消息已排队", ready: "可发送消息",
  offline: "离线", unavailable: "状态不可用", connecting: "等待接入", failed: "派发失败",
  dispatching: "正在派发子代理",
};
const creationTimeOptions = {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
};
const shortCreationTime = new Intl.DateTimeFormat("zh-CN", creationTimeOptions);
const fullCreationTime = new Intl.DateTimeFormat("zh-CN", { ...creationTimeOptions, year: "numeric" });
const sessionNodes = new Map();
const checkedSessions = new Set();
const messageNodes = new Map();
const recentDispatchErrors = new Map();
let selected;
let thread = [];
let sending = false;
let generation = 0;
let sessionState;
let batchMode = false;
let deleteTargets = [];

byId("endpoint").textContent = `${location.origin}/mcp`;

async function request(path, body, method = "POST") {
  const response = await fetch(path, body && {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

function setStatus(text, state) {
  status.textContent = text;
  status.dataset.state = state;
}

function setNotice(text = "") {
  notice.textContent = text;
  notice.hidden = !text;
}

function updateSend() {
  input.disabled = !selected || ["offline", "connecting", "dispatching", "failed"].includes(sessionState);
  send.disabled = input.disabled || sending || !sessionState ||
    ["generating", "unavailable", "error"].includes(sessionState) || !input.value.trim();
}

function select(id) {
  selected = id;
  generation++;
  messages.replaceChildren();
  messageNodes.clear();
  input.value = "";
  sessionDetails.hidden = true;
  const entry = thread.find((entry) => entry.id === id);
  sessionState = entry?.webStatus ?? entry?.status;
  setNotice();
  showDispatchError(entry?.submitError);
  renderSessions();
  setStatus(labels[sessionState] ?? (id ? "正在读取" : "等待接入"), sessionState ?? "idle");
  if (id) void readSelected();
}

function renderSessions() {
  byId("count").textContent = thread.length;
  const liveIds = new Set(thread.map((entry) => entry.id));
  for (const [id, { row }] of sessionNodes) {
    if (!liveIds.has(id)) {
      row.remove();
      sessionNodes.delete(id);
      checkedSessions.delete(id);
    }
  }
  toggleBatch.hidden = !thread.some((entry) => entry.hasCursorSession !== undefined);
  if (toggleBatch.hidden) batchMode = false;
  thread.forEach((entry, index) => {
    const name = entry.name || "未命名会话";
    const state = entry.webStatus ?? entry.status ?? "none";
    let node = sessionNodes.get(entry.id);
    if (!node) {
      const row = document.createElement("div");
      row.className = "session-row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) checkedSessions.add(entry.id);
        else checkedSessions.delete(entry.id);
        updateBatchActions();
      });
      const button = document.createElement("button");
      button.type = "button";
      button.className = "session";
      const heading = document.createElement("span");
      heading.className = "session-heading";
      addText(heading, "span", "", "session-name");
      addText(heading, "time", "", "session-created");
      const meta = document.createElement("span");
      meta.className = "session-meta";
      meta.append(document.createElement("small"));
      addText(meta, "span", "", "status");
      button.append(heading, meta);
      button.addEventListener("click", () => { if (entry.id !== selected) select(entry.id); });
      row.append(checkbox, button);
      node = { row, checkbox, button };
      sessionNodes.set(entry.id, node);
    }
    const { row, checkbox, button } = node;
    const [projectNode, statusNode] = button.lastChild.children;
    const caption = renderSessionName(button.firstChild, name, entry.createdAt);
    checkbox.hidden = !batchMode;
    checkbox.checked = checkedSessions.has(entry.id);
    checkbox.setAttribute("aria-label", `选择 ${caption}`);
    button.title = [caption, entry.submitError].filter(Boolean).join("\n");
    statusNode.textContent = labels[state] ?? labels.none;
    statusNode.dataset.state = state;
    projectNode.textContent = [entry.parentId && "子代理", entry.workspace || entry.window].filter(Boolean).join(" · ");
    button.setAttribute("aria-current", String(entry.id === selected));
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
  });
  updateBatchActions();
  const active = thread.find(({ id }) => id === selected);
  openDelete.hidden = active?.hasCursorSession === undefined;
  const title = byId("title");
  title.title = renderSessionName(title, active ? active.name || "未命名会话" : "会话", active?.createdAt);
  const project = byId("project");
  project.hidden = !active;
  project.textContent = active?.workspace || active?.window || "";
  empty.hidden = !!active;
  messages.hidden = !active;
  byId("composer-area").hidden = !active;
  updateSend();
}

function updateBatchActions() {
  batchActions.hidden = !batchMode;
  toggleBatch.textContent = batchMode ? "退出批量管理" : "批量管理";
  toggleBatch.setAttribute("aria-expanded", String(batchMode));
  const count = checkedSessions.size;
  selectAll.checked = count > 0 && count === thread.length;
  selectAll.indeterminate = count > 0 && count < thread.length;
  openBatchDelete.disabled = count === 0;
  openBatchDelete.textContent = count ? `删除所选（${count}）` : "删除所选";
}

function renderSessionName(heading, name, createdAt) {
  const [nameNode, timeNode] = heading.children;
  nameNode.textContent = name;
  timeNode.hidden = !createdAt;
  if (!createdAt) return name;
  const time = new Date(createdAt);
  timeNode.dateTime = createdAt;
  timeNode.textContent = shortCreationTime.format(time);
  return `${name} · ${fullCreationTime.format(time)}`;
}

async function refreshList() {
  try {
    thread = await request("/api/sessions");
    for (const entry of thread) {
      const lastError = recentDispatchErrors.get(entry.id);
      if (entry.webStatus === "offline" && lastError) {
        entry.webStatus = "failed";
        entry.submitError ??= lastError;
      }
    }
    if (!thread.some(({ id }) => id === selected)) select(thread[0]?.id);
    else {
      const active = thread.find((entry) => entry.id === selected);
      if (active?.webStatus) {
        sessionState = active.webStatus;
        setStatus(labels[sessionState], sessionState);
        showDispatchError(active.submitError);
      }
      renderSessions();
    }
  } catch (error) {
    setStatus("连接中断", "error");
    setNotice(error.message);
  } finally {
    setTimeout(refreshList, 1800);
  }
}

async function readSelected() {
  const id = selected;
  if (!id) return;
  const current = generation;
  try {
    const session = await request(`/api/sessions/${encodeURIComponent(id)}`);
    if (current !== generation) return;
    sessionState = session.webStatus ?? session.status;
    if (sessionState === "offline" && session.submitError) sessionState = "failed";
    const reason = sessionState === "failed" ? session.submitError : undefined;
    if (reason) recentDispatchErrors.set(id, reason);
    else recentDispatchErrors.delete(id);
    const row = thread.find((entry) => entry.id === id);
    if (row && (reason || row.webStatus === "failed")) {
      row.webStatus = sessionState;
      row.submitError = reason;
      renderSessions();
    }
    setStatus(labels[sessionState] ?? "已接入", sessionState);
    showDispatchError(reason);
    renderSessionDetails(session);
    renderMessages(session.messages);
    setNotice(reason ? undefined : session.deliveryError ?? session.submitError);
    updateSend();
  } catch (error) {
    if (current !== generation) return;
    if (sessionState !== "offline" && sessionState !== "failed") {
      sessionState = "error";
      setStatus("读取失败", "error");
      updateSend();
    }
    if (sessionState !== "failed") setNotice(error.message);
  }
}

function showDispatchError(reason) {
  dispatchError.textContent = reason || "";
  dispatchError.hidden = !reason;
}

function renderSessionDetails({ model, contextUsage }) {
  const settings = (model?.parameters ?? []).map(({ id, value }) => {
    const label = modelParameterLabels[id] ?? id;
    if (id === "context") return `${label} ${value.toUpperCase()}`;
    return `${label} ${value === "true" ? "开" : value === "false" ? "关" : value}`;
  });
  if (settings.length === 0 && model?.params) settings.push(model.params);
  if (model?.maxMode !== undefined) settings.push(`Max Mode ${model.maxMode ? "开" : "关"}`);
  sessionModel.textContent = model?.name ? [model.name, ...settings].join(" · ") : "暂无模型信息";

  const percent = contextUsage?.percent;
  contextProgress.hidden = percent === undefined;
  if (percent === undefined) {
    contextValue.textContent = "暂无上下文占用数据";
  } else {
    contextProgress.value = percent;
    const usage = `已用 ${percentFormat.format(percent)}%`;
    contextValue.textContent = contextUsage.used === undefined
      ? `上下文${usage}`
      : `上下文 ${tokenFormat.format(contextUsage.used)} / ${tokenFormat.format(contextUsage.limit)} tokens · ${usage}`;
  }
  sessionDetails.hidden = false;
}

function renderMessages(items) {
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 48;
  const liveIds = new Set(items.map(({ id }) => id));
  for (const [id, entry] of messageNodes) {
    if (!liveIds.has(id)) {
      entry.node.remove();
      messageNodes.delete(id);
    }
  }
  items.forEach((item, index) => {
    const signature = JSON.stringify(item);
    let entry = messageNodes.get(item.id);
    if (entry?.signature !== signature) {
      const node = document.createElement("article");
      node.className = `message ${item.role === "user" ? "user" : "assistant"}`;
      node.setAttribute("aria-label", item.role === "user" ? "你" : "Cursor");
      if (item.thinking) {
        const seconds = item.thinkingDurationMs > 0 ? ` ${Math.max(1, Math.round(item.thinkingDurationMs / 1000))} 秒` : "";
        addDetails(node, "thinking", `思考${seconds}`, item.thinking);
      }
      if (item.text) {
        if (item.role === "user") addText(node, "p", item.text, "message-text");
        else addResponse(node, item.text);
      }
      if (item.pending) addText(node, "small", "等待送达", "delivery-status");
      if (item.undelivered) addText(node, "small", "未送达", "delivery-status undelivered");
      if (item.summary) addDetails(node, "recap", "对话摘要", item.summary);
      if (item.tool) addTool(node, item.tool);
      if (item.error) {
        const error = document.createElement("div");
        error.className = "message-error";
        addText(error, "strong", item.error.title || "执行失败");
        if (item.error.message) addText(error, "p", item.error.message, "message-text");
        node.append(error);
      }
      node.querySelectorAll("details").forEach((detail) => {
        detail.open = entry?.node.querySelector(`details.${detail.classList[0]}`)?.open ?? false;
      });
      entry?.node.replaceWith(node);
      entry = { node, signature };
      messageNodes.set(item.id, entry);
    }
    if (messages.children[index] !== entry.node) messages.insertBefore(entry.node, messages.children[index] ?? null);
  });
  if (atBottom) chat.scrollTop = chat.scrollHeight;
}

function addText(parent, tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  parent.append(element);
  return element;
}

function addDetails(parent, kind, label, value) {
  const details = document.createElement("details");
  details.className = kind;
  addText(details, "summary", label);
  if (value) addText(details, "p", value, "detail-text");
  parent.append(details);
  return details;
}

function addTool(parent, { name, detail, input, output, outputKind, before, after, result, outcome, status, error, awaitingApproval, fileSearch, webSearch }) {
  const expandable = !!(fileSearch || webSearch || detail || input || output || before || after || result || error || outcome);
  const tool = addText(parent, expandable ? "details" : "div", "", "tool");
  const row = addText(tool, expandable ? "summary" : "div", "", "tool-row");
  const glyph = addText(row, "span", "›_", "tool-icon");
  glyph.setAttribute("aria-hidden", "true");
  addText(row, "span", name || "工具调用", "tool-name");
  if (detail) {
    const preview = addText(row, "span", detail, "tool-preview");
    preview.title = detail;
  }
  const state = awaitingApproval ? "等待批准" : (toolStatusLabels[status] ?? status);
  if (state) {
    const badge = addText(row, "span", state, "tool-status");
    badge.dataset.state = awaitingApproval ? "pending" : status;
  }
  if (fileSearch) addFileSearch(tool, fileSearch);
  if (webSearch) addWebSearch(tool, webSearch);
  if (outcome) addText(tool, "p", toolOutcomeLabels[outcome] ?? outcome, "tool-section-label");
  if (error) addToolSection(tool, "错误", error, "tool-error");
  if (output) addToolSection(tool, outputKind === "diff" ? "文件改动" : "输出", output, outputKind === "diff" ? "tool-diff" : "");
  if (before) addToolSection(tool, "修改前", before);
  if (after) addToolSection(tool, "修改后", after);
  if (result) addToolDisclosure(tool, "tool-result", output ? "结果详情" : "结果", result);
  if (input) addToolDisclosure(tool, "tool-parameters", "调用参数", input);
  else if (detail && !fileSearch && !webSearch && !output) addToolSection(tool, "调用详情", detail);
}

function addToolDisclosure(tool, kind, label, content) {
  const section = addText(tool, "details", "", `${kind} tool-section`);
  addText(section, "summary", label, "tool-section-label");
  addText(section, "pre", content, "tool-output");
}

function addToolSection(tool, label, content, style = "") {
  const section = addText(tool, "div", "", "tool-section");
  addText(section, "div", label, "tool-section-label");
  const pre = addText(section, "pre", "", `tool-output ${style}`.trim());
  if (style !== "tool-diff") {
    pre.textContent = content;
    return;
  }
  for (const line of content.split("\n")) {
    const className = line.startsWith("+") && !line.startsWith("+++") ? "diff-added"
      : line.startsWith("-") && !line.startsWith("---") ? "diff-removed" : "";
    addText(pre, "span", line, className);
  }
}

function addWebSearch(tool, { items, omitted }) {
  const section = addText(tool, "div", "", "tool-section");
  const count = items.length + omitted;
  addText(section, "div", `搜索结果（${count}）`, "tool-section-label");
  if (!count) addText(section, "p", "未找到搜索结果", "tool-section-note");
  if (items.length) {
    const list = addText(section, "ul", "", "tool-references");
    for (const { title, url, excerpt } of items) {
      const item = addText(list, "li", "");
      const text = title || url || "未命名来源";
      if (/^https?:\/\//i.test(url ?? "")) {
        const link = addText(item, "a", text);
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      } else {
        addText(item, "span", text);
      }
      if (url && title) addText(item, "small", url);
      if (excerpt) addText(item, "p", excerpt);
    }
  }
  if (omitted) addText(section, "p", `另有 ${omitted} 条结果未显示`, "tool-section-note");
}

function addFileSearch(tool, { pattern, directory, files, omitted, total, truncated }) {
  const fields = addText(tool, "dl", "", "file-search");
  if (pattern) {
    addText(fields, "dt", "搜索模式");
    addText(fields, "dd", pattern, "file-search-path");
  }
  addText(fields, "dt", "搜索目录");
  addText(fields, "dd", directory, "file-search-path");
  if (!files) return;

  const count = total ?? files.length + omitted;
  addText(fields, "dt", `匹配文件（${count}）`);
  const results = addText(fields, "dd", "");
  if (!count && !truncated) addText(results, "span", "未找到匹配文件");
  if (files.length) {
    const list = addText(results, "ul", "", "file-search-results");
    for (const file of files) addText(list, "li", file, "file-search-path");
  }
  if (omitted) addText(results, "div", `另有 ${omitted} 个已返回的文件未显示`);
  if (truncated) addText(results, "div", "Cursor 返回的搜索结果已截断");
}

function addInline(parent, text) {
  // Transcript text is untrusted. Recognize formatting and create text nodes instead of injecting HTML.
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
  const body = document.createElement("div");
  body.className = "response";
  const lines = text.split(/\r?\n/);
  const block = /^( {0,3})(`{3,}|#{1,6}\s+|>\s?|-\s+|\*\s+|\+\s+|\d+\.\s+)(.*)$/;
  let paragraph;
  let list;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      paragraph = list = undefined;
      continue;
    }
    const match = block.exec(line);
    if (!match) {
      list = undefined;
      if (!paragraph) paragraph = addText(body, "p", "");
      else paragraph.append("\n");
      addInline(paragraph, line);
      continue;
    }
    const [, , marker, content] = match;
    paragraph = undefined;
    if (/^(?:[-*+]|\d+\.)\s/.test(marker)) {
      const tag = /^\d/.test(marker) ? "ol" : "ul";
      if (list?.localName !== tag) {
        list = addText(body, tag, "");
        if (tag === "ol") list.start = Number.parseInt(marker, 10);
      }
      addInline(addText(list, "li", ""), content);
      continue;
    }
    list = undefined;
    if (marker.startsWith("`")) {
      const code = [];
      const closingFence = new RegExp(`^ {0,3}\x60{${marker.length},}\\s*$`);
      while (++i < lines.length && !closingFence.test(lines[i])) code.push(lines[i]);
      const frame = addText(body, "div", "", "code-frame");
      if (content.trim()) addText(frame, "div", content.trim(), "code-language");
      addText(addText(frame, "pre", ""), "code", code.join("\n"));
    } else if (marker.startsWith("#")) {
      const level = Math.max(2, marker.trim().length);
      addInline(addText(body, `h${level}`, ""), content);
    } else {
      addInline(addText(body, "blockquote", ""), content);
    }
  }
  parent.append(body);
}

input.addEventListener("input", updateSend);
toggleBatch.addEventListener("click", () => {
  batchMode = !batchMode;
  checkedSessions.clear();
  renderSessions();
});
selectAll.addEventListener("change", () => {
  checkedSessions.clear();
  if (selectAll.checked) for (const { id } of thread) checkedSessions.add(id);
  renderSessions();
});
openDelete.addEventListener("click", () => openDeleteDialog(thread.filter(({ id }) => id === selected)));
openBatchDelete.addEventListener("click", () => openDeleteDialog(thread.filter(({ id }) => checkedSessions.has(id))));

function showDeleteTargets() {
  deleteTitle.textContent = deleteTargets.length === 1 ? "删除会话？" : `删除 ${deleteTargets.length} 个会话？`;
  deleteTargetList.replaceChildren();
  for (const { caption } of deleteTargets) addText(deleteTargetList, "li", caption);
  const hasCursorSession = deleteTargets.some((entry) => entry.hasCursorSession);
  byId("delete-cursor-option").hidden = !hasCursorSession;
  deleteWarning.hidden = !hasCursorSession || !deleteCursor.checked;
}

function openDeleteDialog(entries) {
  deleteTargets = entries.map(({ id, name, createdAt, hasCursorSession }) => ({
    id, hasCursorSession,
    caption: createdAt ? `${name || "未命名会话"} · ${fullCreationTime.format(new Date(createdAt))}` : name || "未命名会话",
  }));
  deleteCursor.checked = false;
  deleteError.hidden = true;
  showDeleteTargets();
  deleteDialog.showModal();
}

deleteCursor.addEventListener("change", () => { deleteWarning.hidden = !deleteCursor.checked; });
cancelDelete.addEventListener("click", () => deleteDialog.close());
deleteDialog.addEventListener("cancel", (event) => { if (confirmDelete.disabled) event.preventDefault(); });
byId("delete-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (confirmDelete.disabled) return;
  confirmDelete.disabled = cancelDelete.disabled = deleteCursor.disabled = true;
  confirmDelete.textContent = "正在删除…";
  deleteError.hidden = true;
  const removed = new Set();
  const failures = [];
  try {
    for (const target of deleteTargets) {
      const { id, hasCursorSession } = target;
      const deleteNative = deleteCursor.checked && hasCursorSession;
      try {
        await request(`/api/sessions/${encodeURIComponent(id)}`, { deleteCursor: deleteNative }, "DELETE");
        removed.add(id);
        recentDispatchErrors.delete(id);
      } catch (error) {
        failures.push({ target, message: error.message });
      }
    }
    thread = thread.filter(({ id }) => !removed.has(id));
    if (removed.has(selected)) select(thread[0]?.id);
    else renderSessions();
    if (failures.length) {
      deleteTargets = failures.map(({ target }) => target);
      showDeleteTargets();
      deleteError.textContent = [`已删除 ${removed.size} 个，${failures.length} 个失败。`,
        ...failures.map(({ target, message }) => `${target.caption}：${message}`)].join("\n");
      deleteError.hidden = false;
    } else {
      deleteDialog.close();
    }
  } finally {
    confirmDelete.disabled = cancelDelete.disabled = deleteCursor.disabled = false;
    confirmDelete.textContent = "确认删除";
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
    const session = await request(`/api/sessions/${encodeURIComponent(id)}`, { text });
    if (selected === id) {
      if (input.value === text) input.value = "";
      sessionState = session.webStatus ?? session.status;
      setStatus(labels[sessionState] ?? "已提交", sessionState);
      chat.scrollTop = chat.scrollHeight;
      await readSelected();
    }
  } catch (error) {
    if (selected === id) {
      await readSelected();
      if (selected === id) setNotice(error.message);
    }
  } finally {
    sending = false;
    updateSend();
  }
});

async function refreshMessages() {
  if (!sending && !document.hidden) await readSelected();
  setTimeout(refreshMessages, ["generating", "responding", "queued"].includes(sessionState) ? 800 : 2000);
}

document.addEventListener("cursor-dispatch", ({ detail: parent }) => {
  if (!thread.some(({ id }) => id === parent.id)) {
    const webStatus = parent.submitError ? "failed" : parent.status === "generating" ? "dispatching" : "offline";
    thread.unshift({ ...parent, webStatus });
  }
  select(parent.id);
});
void refreshList();
void refreshMessages();
