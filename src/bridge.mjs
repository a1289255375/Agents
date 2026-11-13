export const BRIDGE_VERSION = 36;

// Runs inside the Cursor window through Runtime.callFunctionOn, so it must stay self-contained.
// `this` is the array of every Map in the page heap (Runtime.queryObjects on Map.prototype). A ServiceCollection
// is a Map keyed by service identifiers, whose own toString() returns the service name.
//
// Two kinds of window share the same services but not the same session model:
// - editor window: sessions are composers of this window's workspace (composerService);
// - Agents window (environmentService.isGlass): the glass shell hosts one root workbench per opened workspace,
//   each its own ServiceCollection. agentRepositoryService and composerDataService are shared singletons across
//   them (so listing / loading / reading work from any), while composerService is per-workspace. A workspace
//   collection is disposed when its workspace closes, so bind to the always-present "empty-window" root; the
//   caller's alive() check reinstalls on another root if this one ever goes away.
export function installBridge(version) {
  const isServiceId = (k) => typeof k === "function" && Object.hasOwn(k, "toString");
  const instOf = (m) => {
    for (const [k, v] of m) if (String(k) === "instantiationService") return v;
  };
  const isAlive = (inst) => {
    try {
      return inst.invokeFunction(() => true) === true;
    } catch {
      return false;
    }
  };
  const roots = this.filter((m) => {
    try {
      const keys = Map.prototype.keys.call(m);
      if (!isServiceId(keys.next().value)) return false;
      if (![...keys].some((k) => String(k) === "composerService")) return false;
      const inst = instOf(m);
      return inst && !inst._parent && isAlive(inst);
    } catch {
      return false;
    }
  });
  const labelOf = (m) => instOf(m)._findLabel?.() ?? "";
  const services = roots.find((m) => labelOf(m).includes("empty-window")) ?? roots[0];
  if (!services) return false;

  const ids = new Map([...services.keys()].map((k) => [String(k), k]));
  const inst = instOf(services);
  const alive = () => isAlive(inst);
  const svc = (name) => {
    const id = ids.get(name);
    if (!id) throw new Error(`Cursor 内部服务不存在：${name}（Cursor 版本可能变了）`);
    return inst.invokeFunction((accessor) => accessor.get(id));
  };
  const isAgentsWindow = svc("environmentService").isGlass === true;
  const composer = () => svc("composerService");
  const chat = () => svc("composerChatService");
  const data = () => svc("composerDataService");
  const modelConfig = () => svc("modelConfigService");
  const agentRepo = () => svc("agentRepositoryService");
  const URI = svc("environmentService").userRoamingDataHome.constructor;
  const submitErrors = new Map();
  const loadedAgents = new Map(); // kept for the window's lifetime so a generating agent is never evicted under us
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const unbox = (v) => (v && typeof v === "object" && "_value" in v ? v._value : v);

  function watchWebMcp({ origin }) {
    if (webMcpChecks.has(origin)) return;
    webMcpChecks.add(origin);
    void repairWebMcp(origin).finally(() => webMcpChecks.delete(origin)).catch(() => {});
  }

  const webMcpChecks = new Set();
  async function repairWebMcp(origin) {
    const service = svc("mcpService");
    for (const server of service.getServers()) {
      if (server.type !== "streamableHttp" || !server.url) continue;
      const url = URL.parse(server.url);
      if (url?.origin !== origin || url.pathname !== "/mcp" ||
          !service.isServerEnabled(server) || !service.isServerOfferedToAgent(server) || service.getServerBlockMessage(server)) continue;
      const resolved = await service.resolveServerVariables(server);
      if (service.getResolvedServerBlockMessage(resolved)) continue;
      const client = await service.getMcpClient(server.identifier, server.name, server);
      const shared = client.getUnderlyingClient?.() ?? client;
      if (!shared.serverService || !shared.resolveConfigHash) continue;

      const info = service._serverInfoFromResolvedServer(resolved);
      const hash = btoa(shared.resolveConfigHash(info)).replace(/=+$/, "");
      const key = shared.processRegistryKey;
      if (!key?.endsWith(`:cfg:${hash}`) || !(await shared.serverService.getActiveServers()).includes(key)) {
        // Refresh this window's subscription without resetting other windows' transport.
        await service._ensureConnectedWithResolvedServer(server, resolved, "self_healing");
        continue;
      }

      // Cursor keeps a failed connection registered and won't retry a terminal HTTP error via ensureConnected.
      const status = await shared.serverService.getStatus(key);
      if (status?.type === "error" && status.isRetryable === false && status.error === "fetch failed") {
        await service._reloadClientWithResolvedServer(server, resolved, "self_healing");
      }
    }
  }

  async function create({ prompt, model, maxMode, mode = "agent", name, submit = true, workspace, workspaceId, subagentModels }) {
    const resolved = model ? resolveModel(model) : undefined; // validate before creating, so a bad model leaves no empty session
    const unifiedMode = resolveMode(mode);
    const target = workspaceId === undefined ? undefined : dispatchWorkspaces().find((entry) => entry.id === workspaceId);
    if (workspaceId !== undefined && !target) throw new Error("所选工作区已关闭，请重新选择");
    const variants = subagentModels?.map(resolveModel);
    const id = isAgentsWindow
      ? await createAgent({ prompt, unifiedMode, workspace, environment: target?.environment })
      : await createComposer({ prompt, unifiedMode, submit, workspace });
    const handle = await handleOf(id);
    if (resolved) applyModel(handle, resolved, maxMode);
    if (variants?.some((variant) => variant.maxMode)) {
      const config = modelConfig().getEffectiveModelConfigForComposer(handle);
      if (config && !config.maxMode) applyModel(handle, resolved ?? resolveModel(config.modelName), true);
    }
    if (name) await composer().renameComposer(id, name);
    await show(id);
    if (prompt && submit) await startSubmit(id, prompt);
    else if (prompt && isAgentsWindow) handle.setData({ text: prompt, richText: prompt });
    const session = await summary(id);
    return target ? { ...session, workspace: target.folder } : session;
  }

  async function createSubagents({ parentId, agents }) {
    const parent = await handleOf(parentId);
    const parentMaxMode = !!modelConfig().getEffectiveModelConfigForComposer(parent)?.maxMode;
    const selections = agents.map((agent) => ({ ...agent, resolved: resolveModel(agent.model) }));
    if (!parentMaxMode && selections.some(({ resolved }) => resolved.maxMode)) {
      throw new Error("所选档位需要 Max Mode。请先在 Cursor 父会话打开 Max Mode，再派出子代理。");
    }
    const service = svc("subagentComposerService");
    const children = [];
    for (const { name, prompt, resolved } of selections) {
      let id;
      try {
        const args = {
          parentConversationId: parentId,
          rootParentConversationId: parent.data.subagentInfo?.rootParentConversationId ?? parentId,
          subagentType: "generalPurpose",
          modelId: resolved.modelName,
          modelParameters: resolved.parameters,
          prompt,
        };
        const handle = await service.createOrResumeSubagent(args);
        id = handle.data.composerId;
        applyModel(handle, resolved, parentMaxMode);
        await composer().renameComposer(id, name);
        data().updateComposerDataSetStore(parent, (set) => {
          set("subagentComposerIds", (ids) => [...(ids ?? []), id]);
        });
        void service.runSubagentWithHandle(args, handle).then((result) => {
          if (!result.success && result.terminationReason !== "aborted") submitErrors.set(id, result.error);
        }).catch((error) => submitErrors.set(id, error.message));
        children.push(await connect({ id }));
      } catch (error) {
        children.push({ id, name, error: String(error.message ?? error) });
      }
    }
    return children;
  }

  async function send({ id, text, model, maxMode, whenBusy = "reject" }) {
    const handle = await handleOf(id);
    if (data().getComposerData(handle).status === "generating") {
      if (whenBusy === "reject") {
        throw new Error("会话还在生成。whenBusy 可选 steer（不停下、插进这一轮）、queue（这一轮结束后再发）、interrupt（先停再发）。");
      }
      if (whenBusy !== "interrupt") {
        if (model) throw new Error("插话或排队时不能同时换模型");
        return enqueue(id, handle, text, whenBusy === "steer");
      }
      await stop({ id });
    }
    if (model) applyModel(handle, resolveModel(model), maxMode);
    await startSubmit(id, text);
    return summary(id);
  }

  // Cursor's own queue: dispatched when the running turn finishes; steering promotes the item into that turn.
  async function enqueue(id, handle, text, steer) {
    const queuing = data().getComposerCapability(handle, 24); // COMPOSER_CAPABILITY_TYPE_QUEUING
    if (typeof queuing?.addToQueue !== "function") throw new Error("这个会话没有排队能力（Cursor 内部结构可能变了）");
    const d = data().getComposerData(handle);
    const itemId = queuing.addToQueue({
      query: text,
      extras: { modelOverride: d.modelConfig?.modelName, maxModeOverride: d.modelConfig?.maxMode, unifiedModeOverride: d.unifiedMode },
    });
    let delivery = "queued";
    if (steer) {
      if (queuing.isSteeringAvailable?.()) {
        await queuing.promoteQueueItemToSteer(itemId);
        delivery = "steered";
      } else {
        delivery = "queued（这个会话现在不能插话，本轮结束后发）";
      }
    }
    return { ...(await summary(id)), delivery, queueLength: queuing.getQueueItems?.().length };
  }

  // Cursor keeps the headers when a session's bubble bodies are unloaded.
  async function read({ id, last = 10, maxChars = 4000 }) {
    const handle = await handleOf(id);
    const base = await summary(id, handle);
    const store = data();
    const composerData = store.getComposerData(handle);
    const headers = composerData.fullConversationHeadersOnly ?? [];
    const messages = [];
    const batchSize = Math.max(last, 32);
    for (let end = headers.length; end > 0 && messages.length < last; end -= batchSize) {
      const batch = headers.slice(Math.max(0, end - batchSize), end);
      await store.ensureBubbleBodies(handle, batch.map((header) => header.bubbleId));
      for (let i = batch.length - 1; i >= 0 && messages.length < last; i--) {
        const bubble = store.getComposerBubble(handle, batch[i].bubbleId);
        if (!bubble) continue;
        const tool = bubble.toolFormerData;
        const edit = tool?.name === "edit_file_v2" ? await editDetails(tool) : undefined;
        const message = toMessage(bubble, maxChars, edit);
        if (message) messages.push(message);
      }
    }
    return { ...base, contextUsage: contextUsage(composerData), messageCount: headers.length, messages: messages.reverse() };
  }

  // Cursor's context ring reads these fields from the latest prompt checkpoint.
  function contextUsage({ contextTokensUsed, contextTokenLimit, contextUsagePercent }) {
    if (Number.isFinite(contextTokensUsed) && contextTokenLimit > 0) {
      return { used: contextTokensUsed, limit: contextTokenLimit, percent: contextTokensUsed / contextTokenLimit * 100 };
    }
    if (Number.isFinite(contextUsagePercent)) return { percent: contextUsagePercent };
  }

  async function connect({ id }) {
    const target = id ?? (isAgentsWindow
      ? svc("glassActiveAgentService").getActiveAgentId()
      : data().selectedComposerId);
    if (!target) throw new Error("请先打开要接入的 Cursor 会话，或传入会话 ID");
    const session = await summary(target);
    return { ...session, workspace: session.workspace ?? (isAgentsWindow ? undefined : currentFolder()) };
  }

  async function connectingSessions({ bindingToken, toolName = "connect_session" }) {
    const store = data();
    const matches = await Promise.all(store.getLoadedComposers().map(async (composerId) => {
      const handle = store.getHandleIfLoaded(composerId);
      if (!handle) return;
      const recent = store.getComposerData(handle).fullConversationHeadersOnly?.slice(-16) ?? [];
      // A background composer can have tool headers before its tool results are in memory.
      const missing = recent.filter(({ bubbleId }) => !store.getComposerBubble(handle, bubbleId));
      if (missing.length) await store.ensureBubbleBodies(handle, missing.map(({ bubbleId }) => bubbleId));
      const ownsToken = recent.some(({ bubbleId }) => {
        const tool = store.getComposerBubble(handle, bubbleId)?.toolFormerData;
        if (tool?.status !== "completed" || toolArgs(tool)?.toolName !== toolName) return false;
        const result = tool.result?.result;
        if (typeof result !== "string" || !result.includes(bindingToken)) return false;
        try {
          const data = JSON.parse(JSON.parse(result).content[0].text);
          return data.event === "bind" && data.bindingToken === bindingToken;
        } catch {
          return false;
        }
      });
      if (ownsToken) return composerId;
    }));
    return matches.filter(Boolean);
  }

  function list({ limit = 20, includeArchived = false }) {
    if (isAgentsWindow) {
      return agentRepo()
        .agents.value.filter((h) => h.source !== "draft" && (includeArchived || !unbox(h.isArchived)))
        .slice(0, limit)
        .map((h) => ({
          id: h.id,
          name: unbox(h.name) || undefined,
          status: unbox(h.status),
          archived: unbox(h.isArchived) || undefined,
          workspace: folderOf(unbox(h.environment)),
          updatedAt: toIso(unbox(h.lastUpdatedAt) ?? h.createdAt),
        }));
    }
    const time = (c) => c.lastUpdatedAt ?? c.createdAt ?? 0;
    return [...data().allComposersData.allComposers]
      .filter((c) => !c.isDraft && (includeArchived || !c.isArchived))
      .sort((a, b) => time(b) - time(a))
      .slice(0, limit)
      .map((c) => ({
        id: c.composerId,
        name: c.name || undefined,
        mode: c.unifiedMode,
        archived: c.isArchived || undefined,
        updatedAt: toIso(time(c)),
      }));
  }

  function workspaces() {
    if (!isAgentsWindow) return [{ folder: currentFolder(), current: true }];
    const byId = new Map();
    for (const h of agentRepo().agents.value) {
      const env = unbox(h.environment);
      if (h.source === "draft" || !env || env.id === "empty-window") continue;
      const entry = byId.get(env.id) ?? { folder: folderOf(env), id: env.id, agents: 0, lastUpdatedAt: 0 };
      entry.agents += 1;
      entry.lastUpdatedAt = Math.max(entry.lastUpdatedAt, unbox(h.lastUpdatedAt) ?? h.createdAt ?? 0);
      byId.set(env.id, entry);
    }
    const active = activeEnvironment();
    return [...byId.values()]
      .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
      .map((e) => ({ ...e, lastUpdatedAt: toIso(e.lastUpdatedAt), active: e.id === active?.id || undefined }));
  }

  async function stop({ id }) {
    if (isAgentsWindow) {
      const agent = await loadAgent(id);
      agent.abortChat();
      for (let waited = 0; waited < 10000 && agent.composerDataHandle.data.status === "generating"; waited += 100) {
        await sleep(100);
      }
    } else {
      await chat().abortChatAndWaitForFinish(await handleOf(id));
    }
    return summary(id);
  }

  async function open({ id }) {
    await handleOf(id);
    await show(id);
    return summary(id);
  }

  async function rename({ id, name }) {
    await handleOf(id);
    await composer().renameComposer(id, name);
    return summary(id);
  }

  async function deleteSession({ id }) {
    await handleOf(id);
    await composer().deleteComposer(id);
    // Cursor can log a failure internally without rejecting when deleting the open chat.
    if (await data().getComposerHandleById(id)) throw new Error("Cursor 未能删除会话");
    submitErrors.delete(id);
    loadedAgents.delete(id);
    return true;
  }

  function info() {
    return {
      title: document.title,
      kind: isAgentsWindow ? "agents" : "editor",
      focused: document.hasFocus(),
      workspace: isAgentsWindow ? undefined : currentFolder(),
    };
  }

  function dispatchWorkspaces() {
    if (!isAgentsWindow) {
      const workspace = svc("contextService").getWorkspace();
      if (!workspace.folders.length) return [];
      return [{ id: workspace.id, folder: workspace.configuration?.fsPath ?? currentFolder(), active: true }];
    }
    const active = activeEnvironment();
    const open = svc("workspaceCollectionService").getMaterializedWorkspaceIdentifiers();
    const environments = new Map(open.map((env) => [env.id, env]));
    if (active && !environments.has(active.id)) environments.set(active.id, active);
    return [...environments.values()]
      .filter((env) => env.id !== "empty-window" && (env.uri ?? env.configPath)?.scheme === "file")
      .map((environment) => ({
        id: environment.id, folder: folderOf(environment), active: environment.id === active?.id, environment,
      }));
  }

  function dispatchTargets() {
    if (!modes().some((mode) => mode.id === "multitask")) return [];
    return dispatchWorkspaces().map(({ id, folder, active }) => ({ id, folder, active }));
  }

  function models({ includeVariants = false } = {}) {
    const current = modelConfig().getModelConfig("composer")?.modelName;
    return modelConfig()
      .getAvailableDefaultModels()
      .map((m) => ({
        name: m.name,
        label: m.clientDisplayName ?? m.name,
        supportsMaxMode: !!m.supportsMaxMode,
        default: m.name === current || undefined,
        ...(includeVariants && { variants: (m.variants ?? []).map((variant) => ({
          model: variant.variantStringRepresentation ?? formatVariant(m.name, variant.parameterValues),
          label: variant.displayName.replace(/<[^>]*>|\u200b/g, "").replace(/\s+/g, " ").trim(),
          maxMode: !!variant.isMaxMode,
          parameters: variant.parameterValues ?? [],
        })) }),
      }));
  }

  function checkModel({ model }) {
    const r = resolveModel(model);
    return { model: r.modelName, maxMode: r.maxMode, parameters: r.parameters ?? "（不带档位：用 Cursor 对这个模型记住的档位）" };
  }

  function modes() {
    return svc("composerModesService")
      .getAllModes()
      .map((m) => ({ id: m.id, name: m.name }));
  }

  async function summary(id, handle) {
    handle ??= await handleOf(id);
    const d = data().getComposerData(handle);
    const header = isAgentsWindow ? agentRepo().peekAgentHeader(id) : undefined;
    return {
      id,
      name: d.name || undefined,
      createdAt: toIso(d.createdAt ?? unbox(header?.createdAt)),
      parentId: d.subagentInfo?.parentComposerId,
      mode: d.unifiedMode,
      status: d.status,
      generationId: d.chatGenerationUUID,
      abortReason: d.abortReason,
      agentStatus: header ? unbox(header.status) : undefined,
      model: effectiveModel(handle),
      workspace: header ? folderOf(unbox(header.environment)) : undefined,
      draft: d.text || undefined, // text sitting in the input box (a failed first message is put back here)
      submitError: submitError(id, d),
    };
  }

  function submitError(id, composerData) {
    return submitErrors.get(id) ?? composerData.submitErrorDetails?.message ?? composerData.submitErrorDetails?.error?.details?.detail;
  }

  async function sessionStatuses(ids) {
    const store = data();
    const results = await Promise.allSettled(ids.map(async (id) => {
      const handle = store.getHandleIfLoaded(id) ?? await handleOf(id);
      const composerData = store.getComposerData(handle);
      return [id, { status: composerData.status, generationId: composerData.chatGenerationUUID, submitError: submitError(id, composerData) }];
    }));
    return Object.fromEntries(results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []));
  }

  async function createComposer({ prompt, unifiedMode, submit, workspace }) {
    if (workspace && !sameFolder(workspace.folder, currentFolder())) {
      throw new Error(`这个编辑器窗口打开的是 ${currentFolder() ?? "空窗口"}，不能在 ${workspace.folder} 里建会话；用 Agents 窗口，或不传 workspace。`);
    }
    const draft = prompt && !submit ? { text: prompt, richText: prompt } : {};
    const created = await composer().createComposer({
      unifiedMode,
      openInNewTab: true,
      partialState: { unifiedMode, ...draft },
    });
    if (!created?.composerId) throw new Error("Cursor 没有创建会话（createComposer 返回空）");
    return created.composerId;
  }

  // Mirrors the Agents window's own "new agent": registers the sidebar entry, binds the workspace, creates the
  // composer inside that workspace. The first message goes through submitMessage afterwards so the model config
  // can be applied with Cursor's invariants first.
  async function createAgent({ prompt, unifiedMode, workspace, environment = resolveEnvironment(workspace) }) {
    const agent = await agentRepo().createAgent(prompt ?? "", { type: "existing", environment }, {
      unifiedMode,
      promptPreview: prompt,
      richText: prompt,
      skipInitialSubmit: true,
      skipFocusAfterSubmission: true,
    });
    loadedAgents.set(agent.header.id, agent);
    return agent.header.id;
  }

  function resolveEnvironment(workspace) {
    if (workspace) {
      const known = knownEnvironments().find((env) => sameFolder(folderOf(env), workspace.folder));
      return known ?? { id: workspace.id, uri: URI.file(workspace.folder) };
    }
    const active = activeEnvironment();
    if (active && active.id !== "empty-window") return active;
    const folders = workspaces().map((w) => w.folder).join("，");
    throw new Error(`Agents 窗口里要指定 workspace（项目文件夹路径）。已知的：${folders || "无"}`);
  }

  function knownEnvironments() {
    return agentRepo()
      .agents.value.map((h) => unbox(h.environment))
      .filter((env) => env?.uri);
  }

  function activeEnvironment() {
    const id = svc("glassActiveAgentService").getActiveAgentId?.();
    const header = id ? agentRepo().peekAgentHeader(id) : undefined;
    return header ? unbox(header.environment) : undefined;
  }

  async function loadAgent(id) {
    let agent = loadedAgents.get(id);
    const disposed = typeof agent?.isDisposed === "function" ? agent.isDisposed() : agent?.isDisposed === true;
    if (!agent || disposed) {
      agent = await agentRepo().loadAgent(id);
      loadedAgents.set(id, agent);
    }
    return agent;
  }

  async function handleOf(id) {
    const handle = await data().getComposerHandleById(id);
    if (!handle) throw new Error(`找不到会话 ${id}`);
    return handle;
  }

  function applyModel(handle, resolved, maxModeArg) {
    const maxMode = maxModeArg ?? resolved.maxMode ?? false;
    const config = { modelName: resolved.modelName, maxMode };
    if (resolved.parameters) config.selectedModels = [{ modelId: resolved.modelId, parameters: resolved.parameters }];
    modelConfig().setModelConfigForComposer(handle, config);
  }

  function effectiveModel(handle) {
    const cfg = modelConfig().getEffectiveModelConfigForComposer(handle);
    if (!cfg) return undefined;
    const params = cfg.selectedModels?.[0]?.parameters ?? [];
    const suffix = params
      .filter((p) => (p.id === "context" ? true : p.id === "fast" ? p.value === "true" : p.id === "effort" || p.id.includes("reasoning")))
      .map((p) => (p.id === "fast" ? "fast" : p.value))
      .join(" ");
    return {
      name: cfg.modelName, maxMode: !!cfg.maxMode, params: suffix || undefined,
      parameters: params.map(({ id, value }) => ({ id, value })),
    };
  }

  function formatVariant(model, parameters = []) {
    return `${model}[${parameters.map(({ id, value }) => `${id}=${value}`).join(",")}]`;
  }

  // Accepts a plain model name/label ("claude-opus-5-5", "Claude Opus 5.5") or a label plus a variant phrase
  // ("Claude Opus 5.5 1m max"), resolving the trailing words to a variant's context/effort/fast parameters.
  function resolveModel(query) {
    const spec = query.trim();
    const explicit = /^([^\[\]]+)\[([^\[\]]*)\]$/.exec(spec);
    if ((spec.includes("[") || spec.includes("]")) && !explicit) {
      throw new Error("模型档位格式为 model-id[参数=值,参数=值]");
    }
    // "opus5-5" and "opus 5.5" must normalize alike, so split letter→digit boundaries ("1m", "300k" stay whole).
    const norm = (s) =>
      String(s)
        .toLowerCase()
        .replace(/<[^>]*>/g, " ")
        .replace(/([a-z])(\d)/g, "$1 $2")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const q = norm(explicit ? explicit[1] : spec);
    const all = modelConfig().getAvailableDefaultModels();
    let base;
    let baseLabel = "";
    for (const m of all) {
      for (const cand of [m.name, m.clientDisplayName, m.inputboxShortModelName, ...(m.idAliases ?? [])]) {
        const c = norm(cand);
        if (c && (q === c || (!explicit && q.startsWith(`${c} `))) && c.length > baseLabel.length) {
          base = m;
          baseLabel = c;
        }
      }
    }
    if (!base) throw new Error(`没有模型「${query}」。可用：${all.map((m) => m.clientDisplayName ?? m.name).join("，")}`);
    const modelId = base.modelId ?? base.name;
    const leftover = q.slice(baseLabel.length).trim();
    if (!explicit && !leftover) return { modelName: base.name, modelId };

    const wanted = new Map();
    if (explicit?.[2].trim()) {
      for (const pair of explicit[2].split(",")) {
        const parts = pair.trim().match(/^([\w-]+)\s*=\s*([\w-]+)$/);
        if (!parts || wanted.has(parts[1])) throw new Error(`无效或重复的模型档位参数「${pair}」`);
        wanted.set(parts[1], parts[2]);
      }
    }
    let effort;
    if (!explicit) {
      for (const token of leftover.replace(/extra high/g, "xhigh").split(" ")) {
        if (/^\d+[km]$/.test(token)) wanted.set("context", token);
        else if (["none", "low", "medium", "high", "xhigh", "max"].includes(token)) effort = token;
        else if (token === "fast") wanted.set("fast", "true");
        else throw new Error(`无法识别模型档位「${token}」`);
      }
    }
    const pv = (v, id) => v.parameterValues?.find((p) => p.id === id)?.value;
    let cands = (base.variants ?? []).filter((v) =>
      [...wanted].every(([id, value]) => pv(v, id) === value) &&
      (effort === undefined || (pv(v, "effort") ?? pv(v, "reasoning_effort") ?? pv(v, "reasoning")) === effort));
    if (!wanted.has("fast") && cands.some((v) => pv(v, "fast") !== "true")) {
      cands = cands.filter((v) => pv(v, "fast") !== "true");
    }
    if (explicit && !wanted.size && !cands.length && !base.variants?.length) return { modelName: base.name, modelId, parameters: [] };
    const variant = cands.find((v) => v.isDefaultMaxConfig || v.isDefaultNonMaxConfig) ?? cands[0];
    if (!variant) {
      const choices = [...new Set((base.variants ?? []).map((v) => v.displayName.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()))];
      throw new Error(`「${query}」没匹配到 ${base.clientDisplayName ?? base.name} 的档位。可选：${choices.join("，")}`);
    }
    return { modelName: base.name, modelId, maxMode: variant.isMaxMode, parameters: variant.parameterValues };
  }

  function resolveMode(query) {
    const q = query.trim().toLowerCase();
    const all = modes();
    const hit = all.find((m) => m.id.toLowerCase() === q) ?? all.find((m) => m.name.toLowerCase() === q);
    if (!hit) throw new Error(`没有模式「${query}」。可用：${all.map((m) => `${m.id}（${m.name}）`).join("，")}`);
    return hit.id;
  }

  async function show(id) {
    if (isAgentsWindow) await svc("commandService").executeCommand("glass.openAgentById", id);
    else await composer().openComposer(id);
  }

  // A turn can run for minutes, so only wait until it has visibly started (or failed early).
  async function startSubmit(id, text) {
    submitErrors.delete(id);
    let settled = false;
    const submission = isAgentsWindow
      ? loadAgent(id).then((agent) => agent.submitMessage(text))
      : chat().submitChatMaybeAbortCurrent(id, text);
    submission.catch((e) => submitErrors.set(id, String(e?.message ?? e))).finally(() => (settled = true));
    const handle = await handleOf(id);
    for (let waited = 0; waited < 5000 && !settled; waited += 100) {
      if (data().getComposerData(handle).status === "generating") return;
      await sleep(100);
    }
  }

  async function editDetails(tool) {
    const change = tool.toolCall?.tool?.value?.result?.result?.value;
    const diff = change?.diffString || tool.additionalData?.precomputedDiff?.diffString;
    if (diff) return { change, diff };
    const { beforeContentId, afterContentId } = tool.result ?? {};
    if (!afterContentId && typeof change?.afterFullFileContent !== "string") return { change };
    const storage = beforeContentId || afterContentId ? svc("storageService") : undefined;
    const [before, after] = await Promise.all([
      change?.beforeFullFileContent ?? (beforeContentId && storage.cursorDiskKVGet(beforeContentId)),
      change?.afterFullFileContent ?? (afterContentId && storage.cursorDiskKVGet(afterContentId)),
    ]).catch(() => []);
    if (typeof after !== "string" || beforeContentId && typeof before !== "string") return { change };
    return { change, before, after };
  }

  function toMessage(bubble, maxChars, edit) {
    const text = clip(bubble.text, maxChars);
    // 3.29.9 can return older transcript steps with thinking stored as a string.
    const thinking = clip(typeof bubble.thinking === "string" ? bubble.thinking : bubble.thinking?.text, maxChars);
    const summary = clip(bubble.conversationSummary?.summary, maxChars);
    const tool = bubble.toolFormerData;
    const error = bubble.errorDetails;
    if (!text && !thinking && !summary && !tool && !error) return null;
    const msg = { id: bubble.bubbleId, role: bubble.type === 1 ? "user" : "assistant", createdAt: bubble.createdAt };
    if (text) msg.text = text;
    if (thinking) {
      msg.thinking = thinking;
      msg.thinkingDurationMs = bubble.thinkingDurationMs;
    }
    if (summary) msg.summary = summary;
    if (error) {
      msg.error = {
        title: clip(error.title ?? error.error?.details?.title, maxChars),
        message: clip(error.message ?? error.error?.details?.detail, maxChars),
        code: error.error?.error,
      };
    }
    if (tool) msg.tool = toolMessage(tool, maxChars, edit);
    return msg;
  }

  function toolMessage(tool, maxChars, edit) {
    const name = tool.name ?? String(tool.tool);
    const native = tool.toolCall?.tool;
    const call = native?.value;
    const outcome = call?.result?.result;
    const rawArgs = toolArgs(tool);
    const args = rawArgs && Object.keys(rawArgs).length ? rawArgs : call?.args ?? tool.params ?? rawArgs;
    const { status: executionStatus, ...extra } = tool.additionalData ?? {};
    const status = executionStatus === "error" || outcome?.case === "error" || outcome?.value?.isError === true
      ? "error" : executionStatus === "rejected" ? "cancelled" : tool.status;
    const error = clip(tool.error?.clientVisibleErrorMessage ?? tool.error?.message
      ?? (typeof tool.error === "string" ? tool.error : undefined)
      ?? (status === "error" ? outcome?.value?.errorMessage ?? outcome?.value?.error : undefined), maxChars);
    const awaitingApproval = (args?.requireUserApproval === true || executionStatus === "pending" && !!extra.smartModeApprovalReason)
      && ["pending", "loading", "running"].includes(status);
    const message = { name, status, error, awaitingApproval: awaitingApproval || undefined };
    if (outcome?.case && outcome.case !== "success") message.outcome = outcome.case;

    const result = tool.result ?? outcome?.value;
    if (native?.case === "mcpToolCall" || name.startsWith("mcp-")) {
      const input = args?.args ?? parseToolJSON(tool.params?.tools?.[0]?.parameters);
      const relay = name.startsWith("mcp-cursor-session-web-");
      message.detail = toolDetail(input);
      message.input = formatToolData(input, maxChars);
      const body = parseToolJSON(result?.result);
      const content = body?.content ?? (Array.isArray(outcome?.value?.content)
        ? outcome.value.content.map(({ content: entry }) => ({ type: entry?.case, ...entry?.value }))
        : undefined);
      if (Array.isArray(content)) {
        // The first connect_session result is an internal binding challenge containing a live token.
        const blocks = content.map(({ type, text, data, ...metadata }) => {
          const payload = relay && type === "text" ? parseToolJSON(text) : undefined;
          if (payload && typeof payload === "object" && !Array.isArray(payload)) {
            const { bindingToken, nextCall, ...visible } = payload;
            if (bindingToken) delete visible.instruction;
            return { type, text: formatToolData(visible, maxChars) };
          }
          return { type, text, ...metadata, ...(data && { hasBinaryData: true }) };
        });
        message.output = clip(blocks.filter(({ type }) => type === "text").map(({ text }) => text).filter(Boolean).join("\n\n"), maxChars);
        const attachments = blocks.filter(({ type }) => type !== "text");
        message.result = formatToolData({
          content: attachments.length ? attachments : undefined,
          structuredContent: body?.structuredContent ?? outcome?.value?.structuredContent,
        }, maxChars);
      } else {
        message.output = clip(result?.result, maxChars);
        message.result = message.output ? undefined : formatToolData(result, maxChars);
      }
      return message;
    }

    message.detail = toolDetail(args);
    message.input = formatToolData(args, maxChars);
    if (name === "glob_file_search") {
      message.fileSearch = globSearchDetails(args, result, outcome?.case === "success" ? outcome.value : undefined, maxChars);
      if (message.fileSearch?.files) return message;
    } else if (name === "web_search" && Array.isArray(result?.references) && !error && status === "completed") {
      message.webSearch = webSearchDetails(result.references, maxChars);
      return message;
    } else if (name === "update_current_step") {
      message.output = clip(args?.currentStep ?? result?.currentStep, maxChars);
      if (message.output) return message;
    } else if (edit) {
      const { change, diff, before, after } = edit;
      const { beforeContentId, afterContentId, resultForModel, ...stats } = tool.result ?? {};
      message.output = clip(diff ?? resultForModel ?? change?.message, maxChars);
      if (diff) message.outputKind = "diff";
      message.before = clip(before, maxChars);
      message.after = clip(after, maxChars);
      message.result = formatToolData({ linesAdded: change?.linesAdded, linesRemoved: change?.linesRemoved, ...stats }, maxChars);
      if (message.output || message.result || message.before || message.after) return message;
    }

    if (result && typeof result === "object" && !Array.isArray(result)) {
      const { output, contents, markdown, content, ...fields } = result;
      message.output = clip([output, contents, markdown, content].find(value => typeof value === "string" && value.trim()), maxChars);
      if (message.output) {
        message.result = formatToolData({
          ...(typeof content !== "string" && { content }),
          ...fields,
          ...extra,
        }, maxChars);
        return message;
      }
    }
    message.output = clip(result, maxChars);
    const hasExtra = Object.keys(extra).length > 0;
    const data = message.output ? undefined : result;
    // The workbench projection can omit fields from the native outcome, notably for task and search tools.
    const nativeResult = tool.result == null ? undefined : outcome?.value;
    const resultData = data && typeof data === "object" && !Array.isArray(data)
      && nativeResult && typeof nativeResult === "object" && !Array.isArray(nativeResult)
      ? { ...nativeResult, ...data }
      : data;
    message.result = formatToolData(hasExtra ? { ...extra, result: resultData } : resultData, maxChars);
    return message;
  }

  function parseToolJSON(value) {
    if (typeof value !== "string") return undefined;
    try { return JSON.parse(value); } catch { return undefined; }
  }

  function formatToolData(value, maxChars) {
    if (value == null) return undefined;
    if (typeof value === "string") return clip(value, maxChars);
    const json = JSON.stringify(value, (key, item) => {
      if (key === "toolCallId" || key === "bindingToken") return undefined;
      if (typeof item === "bigint") return String(item);
      if (ArrayBuffer.isView(item)) return `[二进制数据，${item.byteLength} 字节]`;
      return item;
    }, 2);
    return json === "{}" ? undefined : clip(json, maxChars);
  }

  function clip(value, maxChars) {
    if (typeof value !== "string") return undefined;
    const text = value.trim();
    return text.length > maxChars ? `${text.slice(0, maxChars)}…（截断，共 ${text.length} 字）` : text || undefined;
  }

  // Most tools keep their JSON arguments in rawArgs; the terminal tool leaves rawArgs empty and uses params.
  function toolArgs(tool) {
    for (const raw of [tool.rawArgs, tool.params]) {
      if (raw && typeof raw === "object") return raw;
      const parsed = parseToolJSON(raw);
      if (parsed && typeof parsed === "object") return parsed;
    }
    return undefined;
  }

  function globSearchDetails(args, result, nativeResult, maxChars) {
    const directories = result?.directories;
    const hasResult = Array.isArray(directories) && directories.some(({ files }) => Array.isArray(files));
    const nativeFiles = Array.isArray(nativeResult?.files) ? nativeResult.files : undefined;
    const pattern = clip(args?.globPattern ?? nativeResult?.pattern, maxChars);
    const directory = clip(args?.targetDirectory ?? nativeResult?.path ?? directories?.[0]?.absPath, maxChars);
    if (!pattern && !directory && !hasResult && !nativeFiles) return undefined;
    const details = { pattern, directory: directory ?? "." };
    // Cursor emits a directory with an empty files array for a successful search with no matches.
    if (!hasResult && !nativeFiles) return details;
    const matches = nativeFiles ?? directories.flatMap(({ files }) => Array.isArray(files)
      ? files.map(({ relPath }) => relPath).filter((path) => typeof path === "string" && path.length > 0)
      : []);
    const files = [];
    let remaining = maxChars;
    for (const match of matches) {
      remaining -= match.length + 1;
      if (remaining < 0) break;
      files.push(match);
    }
    return {
      ...details,
      files,
      omitted: matches.length - files.length,
      total: Number(nativeResult?.totalFiles) || undefined,
      truncated: nativeResult?.clientTruncated || nativeResult?.ripgrepTruncated || !!directories?.some(({ ripgrepTruncated }) => ripgrepTruncated),
    };
  }

  function webSearchDetails(references, maxChars) {
    const items = [];
    let remaining = maxChars;
    for (const { title, url, chunk } of references) {
      const label = clip(title, 240);
      const link = typeof url === "string" && url.length <= 2048 ? url.trim() : undefined;
      remaining -= (label?.length ?? 0) + (link?.length ?? 0) + 2;
      if (remaining < 0) break;
      const excerpt = remaining > 0 ? clip(chunk, Math.min(1000, remaining)) : undefined;
      remaining -= excerpt?.length ?? 0;
      if (label || link || excerpt) items.push({ title: label, url: link, excerpt });
    }
    return { items, omitted: references.length - items.length };
  }

  // Surface the one field that says what the call touches.
  function toolDetail(args) {
    if (!args || typeof args !== "object") return undefined;
    for (const k of ["currentStep", "command", "searchTerm", "pattern", "query", "globPattern", "glob_pattern", "search_term", "path", "relativeWorkspacePath", "target_file", "targetFile", "targetDirectory", "url", "server", "description"]) {
      const v = args[k];
      if (typeof v !== "string" || !v.trim()) continue;
      const s = v.replace(/\s+/g, " ").trim();
      return s.length > 200 ? `${s.slice(0, 200)}…` : s;
    }
    return undefined;
  }

  function currentFolder() {
    return svc("contextService").getWorkspace().folders[0]?.uri.fsPath; // IWorkspaceContextService
  }

  const folderOf = (env) => env?.uri?.fsPath ?? env?.configPath?.fsPath ?? env?.id;
  const sameFolder = (a, b) => !!a && !!b && a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
  const toIso = (t) => (t ? new Date(t).toISOString() : undefined);

  (globalThis.__cursorSessionMcpBridges ??= {})[version] = {
    version,
    alive,
    create,
    createSubagents,
    send,
    read,
    connect,
    connectingSessions,
    watchWebMcp,
    list,
    workspaces,
    stop,
    open,
    rename,
    deleteSession,
    info,
    dispatchTargets,
    models,
    checkModel,
    modes,
    summary,
    sessionStatuses,
  };
  return true;
}
