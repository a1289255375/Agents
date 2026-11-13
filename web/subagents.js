const dialog = document.getElementById("dispatch-dialog");
const form = document.getElementById("dispatch-form");
const settings = document.getElementById("dispatch-settings");
const workspace = document.getElementById("dispatch-target");
const method = document.getElementById("dispatch-method");
const agentRows = document.getElementById("dispatch-agents");
const addGroup = document.getElementById("dispatch-add");
const total = document.getElementById("dispatch-total");
const generate = document.getElementById("dispatch-generate");
const send = document.getElementById("dispatch-send");
const notice = document.getElementById("dispatch-notice");
const result = document.getElementById("dispatch-result");
const output = document.getElementById("dispatch-output");
const rows = [];
const maxAgents = 10;
const preferredModel = "grok-4.7";
const preferredVariant = "grok-4.7[context=500k,reasoning_effort=xhigh,fast=true]";
let models = [];
let targets = [];
let loading = false;
let sending = false;
let nextGroupId = 0;

document.getElementById("open-dispatch").addEventListener("click", async () => {
  dialog.showModal();
  if (loading || sending) return;
  const previous = targets[workspace.value];
  loading = true;
  workspace.disabled = true;
  updateTotal();
  notice.textContent = "正在读取已打开的 Cursor 工作区…";
  try {
    targets = await request("/api/dispatch-targets", { signal: AbortSignal.timeout(15000) });
    workspace.replaceChildren(...targets.map(({ folder, title }, index) => new Option(`${folder} · ${title}`, index)));
    const previousIndex = targets.findIndex(({ windowId, workspaceId }) => previous?.windowId === windowId && previous?.workspaceId === workspaceId);
    const preferred = targets.findIndex((target) => target.preferred);
    if (targets.length) workspace.selectedIndex = previousIndex >= 0 ? previousIndex : Math.max(0, preferred);
    else workspace.add(new Option("没有已打开的 Multitask 工作区"));
    await loadModels();
  } catch (error) {
    models = [];
    notice.textContent = `读取 Cursor 失败：${error.message}`;
  } finally {
    workspace.disabled = !targets.length;
    loading = false;
    updateTotal();
  }
});

workspace.addEventListener("change", async () => {
  loading = true;
  workspace.disabled = true;
  updateTotal();
  try {
    await loadModels();
  } catch (error) {
    models = [];
    notice.textContent = `读取模型失败：${error.message}`;
  } finally {
    loading = false;
    workspace.disabled = false;
    updateTotal();
  }
});

async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

async function loadModels() {
  const target = targets[workspace.value];
  const query = target ? `?windowId=${encodeURIComponent(target.windowId)}` : "";
  notice.textContent = "正在读取 Cursor 模型档位…";
  const available = await request(`/api/model-variants${query}`, { signal: AbortSignal.timeout(15000) });
  models = available.filter(({ name }) => name !== "default" && !name.startsWith("auto"));
  if (!models.length) throw new Error("当前 Cursor 窗口没有可用模型");
  if (!rows.length) appendGroup(2);
  else for (const row of rows) populateModel(row);
  notice.textContent = target ? "" : "打开一个支持 Multitask 的 Cursor 工作区后即可直接发送。";
}

addGroup.addEventListener("click", () => {
  const row = appendGroup(1);
  row.model.focus();
  updateTotal();
});
form.addEventListener("input", (event) => {
  if (event.target === output) return;
  result.hidden = true;
  updateTotal();
});

function updateTotal() {
  const valid = rows.length > 0 && rows.every(({ count }) => count.validity.valid);
  const size = valid ? rows.reduce((sum, { count }) => sum + count.valueAsNumber, 0) : 0;
  const tooMany = size > maxAgents;
  total.textContent = valid ? `共 ${size} 个（上限 ${maxAgents} 个）` : "每组请输入有效数量";
  total.hidden = rows.length === 0;
  total.classList.toggle("dispatch-over-limit", tooMany || !valid);
  addGroup.disabled = loading || sending || !models.length || rows.length >= maxAgents;
  generate.disabled = loading || sending || !models.length || !valid || tooMany;
  send.disabled = generate.disabled || !targets[workspace.value];
  for (const row of rows) row.remove.disabled = rows.length === 1;
}

function appendGroup(quantity) {
  result.hidden = true;
  const group = document.createElement("fieldset");
  const model = document.createElement("select");
  const variant = document.createElement("select");
  const count = document.createElement("input");
  count.type = "number";
  count.min = "1";
  count.max = String(maxAgents);
  count.required = true;
  count.value = String(quantity);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "移除此组";
  const detail = document.createElement("div");
  detail.className = "dispatch-variant-detail";
  detail.id = `dispatch-variant-${++nextGroupId}`;
  variant.setAttribute("aria-describedby", detail.id);
  for (const [control, label] of [[model, "模型"], [variant, "档位"], [count, "数量"]]) {
    const field = document.createElement("label");
    field.append(label, control);
    group.append(field);
  }
  group.append(remove, detail);
  const row = { group, model, variant, count, remove, detail };
  model.addEventListener("change", () => updateVariants(row));
  variant.addEventListener("change", () => showVariant(row));
  remove.addEventListener("click", () => {
    rows.splice(rows.indexOf(row), 1);
    group.remove();
    result.hidden = true;
    updateTotal();
    addGroup.focus();
  });
  rows.push(row);
  populateModel(row);
  agentRows.append(group);
  return row;
}

function populateModel(row) {
  const previousModel = row.model.value;
  row.model.replaceChildren(...models.map(({ name, label }) => new Option(label, name)));
  row.model.value = models.some(({ name }) => name === previousModel)
    ? previousModel : (models.find(({ name }) => name === preferredModel) ?? models.find((item) => item.default) ?? models[0]).name;
  updateVariants(row);
}

function updateVariants(row) {
  const { variant, model } = row;
  const selection = models.find(({ name }) => name === model.value);
  const previous = variant.value;
  const options = selection.variants.length ? selection.variants : [{ model: selection.name, label: "默认档位" }];
  variant.replaceChildren(...options.map(({ model, label }) => new Option(label, model)));
  if (options.some(({ model }) => model === previous)) variant.value = previous;
  else if (options.some(({ model }) => model === preferredVariant)) variant.value = preferredVariant;
  showVariant(row);
}

function showVariant({ model, variant, detail }) {
  const item = models.find(({ name }) => name === model.value).variants.find((v) => v.model === variant.value);
  const names = { context: "上下文", effort: "推理", reasoning: "推理", reasoning_effort: "推理", thinking: "Thinking", fast: "Fast" };
  detail.textContent = (item?.parameters ?? []).map(({ id, value }) => {
    const label = names[id] ?? id;
    const text = value === "true" ? "开" : value === "false" ? "关" : id === "context" ? value.toUpperCase() : value;
    return `${label} ${text}`;
  }).join(" · ");
}

function selectedAgents() {
  const prompt = [
    "【子会话】你负责接收并执行我在 WebUI 下发的任务。",
    "立即调用 user-cursor-session-web 的 connect_session({})。收到 event=bind 后，执行同一会话工具返回的 nextCall，挂起等待网页消息。",
    "收到 event=message 后执行任务，按需使用 Cursor 工具并输出进展。完成后调用 reply_message 回传结果，然后立即用工具返回的 id 调用 wait_message。不要自行结束当前轮或派发其他子代理。",
    "收到 disconnected，或用户明确结束网页等待时停止。主动结束时用 disconnect_session。",
  ].join("\n");
  let number = 0;
  return rows.flatMap(({ variant, count }) => Array.from({ length: count.valueAsNumber }, () => ({
    name: `网页助手 ${++number}`, model: variant.value, prompt,
  })));
}

function dispatchPrompt(agents) {
  if (method.value === "native") {
    const tasks = agents.map((agent) => agent.model === preferredVariant
      ? { ...agent, model: "grok-4.7-xhigh-fast" }
      : agent);
    return [
      `请在当前 Multitask 会话中，用 Cursor 原生的子代理工具（Task）并行启动以下 ${agents.length} 个本地后台子代理，设置 run_in_background 为 true。使用 name 作为任务名，完整转交 prompt。子代理使用 MCP 的 connect_session 与网页通信。`,
      "model 若已是原生 Task 标识，直接使用。带方括号的档位需使用 Task 提供的等价模型标识，保留指定的上下文、推理和 Fast 设置。创建子代理时只用原生 Task。若没有等价档位或无法后台启动，请在父会话报告具体原因。",
      JSON.stringify({ agents: tasks }, null, 2),
    ].join("\n\n");
  }
  return [
    `调用 user-cursor-session-web 的 create_subagents，一次创建下面这 ${agents.length} 个本地子代理。首次调用省略 parentId；若返回 event=bind，在当前父会话立即执行 nextCall。严格使用各项 model 的原值。如果工具报错，把错误告诉我。`,
    JSON.stringify({ agents }, null, 2),
    "工具返回后报告创建结果。子代理会各自接入网页并等待任务。",
  ].join("\n\n");
}

generate.addEventListener("click", () => {
  if (result.hidden) output.value = dispatchPrompt(selectedAgents());
  result.hidden = false;
  output.focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (send.disabled) return;
  const { windowId, workspaceId } = targets[workspace.value];
  const agents = selectedAgents();
  const prompt = result.hidden ? dispatchPrompt(agents) : output.value.trim();
  if (!prompt) {
    notice.textContent = "请输入派发提示词";
    output.focus();
    return;
  }
  sending = true;
  settings.disabled = true;
  updateTotal();
  notice.textContent = "正在创建 Multitask 父会话并发送提示词…";
  try {
    const parent = await request("/api/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ windowId, workspaceId, prompt, models: agents.map(({ model }) => model) }),
    });
    document.dispatchEvent(new CustomEvent("cursor-dispatch", { detail: parent }));
    notice.textContent = parent.submitError ? `父会话发送失败：${parent.submitError}` : "已发送，子代理接入后会出现在侧栏。";
    if (!parent.submitError) dialog.close();
  } catch (error) {
    notice.textContent = `派发失败：${error.message}`;
  } finally {
    sending = false;
    settings.disabled = false;
    updateTotal();
  }
});

document.getElementById("dispatch-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(output.value);
    notice.textContent = "已复制提示词";
  } catch {
    output.select();
    notice.textContent = "提示词已选中，按 Ctrl+C 复制";
  }
});
