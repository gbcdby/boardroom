import { computed, ref } from "vue";
import { createMcpCatalogApi, isAttemptPending, isEditable, McpRequestError } from "../api/mcp-connections.ts";
import type { McpCatalogApi, McpCatalogSnapshot, McpConnectionView, McpDiscoverInput, McpDiscoveryAttempt, McpSaveInput } from "../api/mcp-connections.ts";

interface Editor {
  kind: "create" | "edit" | "disable"; id: string | null; baseRevision: number | null;
  name: string; endpoint: string; enabled: boolean; initial: string; loading: boolean; error: string | null;
}
interface SaveOperation { id: string | null; input: McpSaveInput; state: "pending" | "unknown"; error: string | null }
interface DiscoveryOperation {
  input: McpDiscoverInput; state: "pending" | "unknown" | "known" | "failed"; attempt: McpDiscoveryAttempt | null; error: string | null;
}
const fields = (e: Pick<Editor, "name" | "endpoint" | "enabled">) => JSON.stringify([e.name, e.endpoint, e.enabled]);
const pending = (a: McpDiscoveryAttempt | null) => a !== null && isAttemptPending(a);
const regresses = (old: McpDiscoveryAttempt, incoming: McpDiscoveryAttempt) =>
  incoming.sequence !== old.sequence || incoming.connectionRevision !== old.connectionRevision
  || !pending(old) && pending(incoming) || old.status === "cancel_requested" && incoming.status === "running";
const asError = (error: unknown) => error instanceof McpRequestError ? error : new McpRequestError("无法核实结果，请重新读取。", 0, "unknown", true);

/** Global MCP state only. Read reconciliation never calls discover or any mutation. */
export function createMcpCatalogState(options: { api?: McpCatalogApi; requestId?: () => string; now?: () => string;
  onSaved?: (requestId: string) => void; readTimeoutMs?: number } = {}) {
  const api = options.api ?? createMcpCatalogApi(), requestId = options.requestId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date().toISOString());
  const connections = ref<McpConnectionView[]>([]), selectedId = ref<string | null>(null);
  const loaded = ref(false), reading = ref(false), forbidden = ref(false), readError = ref<string | null>(null), lastRead = ref<string | null>(null);
  const editor = ref<Editor | null>(null), saveOperation = ref<SaveOperation | null>(null);
  const discoveries = ref<Record<string, DiscoveryOperation>>({}), ownedAttempts = ref<Record<string, McpDiscoveryAttempt[]>>({});
  const knownAttempts = ref<Record<string, McpDiscoveryAttempt[]>>({});
  const preparing = ref<Record<string, boolean>>({}), actionError = ref<string | null>(null), cancelPending = ref<Record<string, boolean>>({});
  const historical = ref<McpCatalogSnapshot | null>(null), historyLoading = ref(false), historyError = ref<string | null>(null);
  const selected = computed(() => connections.value.find(v => v.connection.connectionId === selectedId.value) ?? null);
  const snapshot = computed(() => historical.value ?? selected.value?.currentSnapshot ?? null);
  const dirty = computed(() => !!editor.value && (fields(editor.value) !== editor.value.initial || !!saveOperation.value));
  const editorLocked = computed(() => !!saveOperation.value || !!editor.value?.loading || forbidden.value);
  let disposed = false, visible = true, epoch = 0, permission = 0, editorVersion = 0, historyVersion = 0;
  let readController: AbortController | null = null, editorController: AbortController | null = null, historyController: AbortController | null = null;
  let readPromise: Promise<void> | null = null, queued = false, polling: ReturnType<typeof setInterval> | null = null;
  const controllers = new Map<string, AbortController>();

  function advance(): void { epoch++; readController?.abort(); historyVersion++; historyController?.abort(); historyLoading.value = false; }
  function revoke(): void {
    permission++; advance(); editorVersion++; editorController?.abort();
    for (const c of controllers.values()) c.abort(); controllers.clear();
    forbidden.value = true; connections.value = []; loaded.value = false; lastRead.value = null;
    editor.value = null; saveOperation.value = null; discoveries.value = {}; ownedAttempts.value = {}; knownAttempts.value = {};
    historical.value = null; actionError.value = null; historyError.value = null;
  }
  function errorOf(error: unknown): McpRequestError { const e = asError(error); if (e.status === 403) revoke(); return e; }
  function newer(old: McpConnectionView | undefined, incoming: McpConnectionView): McpConnectionView {
    if (!old || incoming.connection.revision > old.connection.revision) return incoming;
    if (incoming.connection.revision < old.connection.revision) return old;
    const a = old.lastDiscovery, b = incoming.lastDiscovery;
    if (a && (!b || b.sequence < a.sequence || b.attemptId === a.attemptId && regresses(a, b))) return old;
    return incoming;
  }
  function upsert(view: McpConnectionView): void {
    if (view.lastDiscovery) view = { ...view, lastDiscovery: observe(view.lastDiscovery) };
    const index = connections.value.findIndex(v => v.connection.connectionId === view.connection.connectionId);
    if (index < 0) connections.value.push(view); else connections.value[index] = newer(connections.value[index], view);
  }
  // Observing an exact identity is distinct from owning the request that created it.
  function observe(attempt: McpDiscoveryAttempt): McpDiscoveryAttempt {
    const id = attempt.connectionId, rows = knownAttempts.value[id] ?? [];
    const index = rows.findIndex(a => a.attemptId === attempt.attemptId), old = rows[index];
    if (old && regresses(old, attempt)) return old;
    if (index < 0) rows.push(attempt); else rows[index] = attempt;
    knownAttempts.value[id] = rows.sort((a, b) => b.sequence - a.sequence);
    return attempt;
  }
  function remember(id: string, attempt: McpDiscoveryAttempt): void {
    attempt = observe(attempt);
    const rows = ownedAttempts.value[id] ?? [], index = rows.findIndex(a => a.attemptId === attempt.attemptId), old = rows[index];
    if (old && regresses(old, attempt)) return;
    if (index < 0) rows.unshift(attempt); else rows[index] = attempt;
    ownedAttempts.value[id] = rows;
    const op = discoveries.value[id]; if (op?.attempt?.attemptId === attempt.attemptId) op.attempt = attempt;
  }
  async function refresh(): Promise<void> {
    if (disposed || !visible) return;
    if (readPromise) { queued = true; return readPromise; }
    const scope = epoch, auth = permission, id = selectedId.value, controller = new AbortController();
    readController = controller; reading.value = true;
    // The whole reconciliation, including exact owned-attempt GETs, has one deadline.
    let expired = false;
    const deadline = setTimeout(() => { expired = true; controller.abort(); }, options.readTimeoutMs ?? 10_000);
    const run = async () => {
      try {
        // The list contains full selected-object projections, not a count-based cache token.
        const rows = await api.list(controller.signal);
        if (disposed || scope !== epoch || auth !== permission) return;
        const old = new Map(connections.value.map(v => [v.connection.connectionId, v]));
        connections.value = rows.map(v => newer(old.get(v.connection.connectionId), v))
          .map(v => v.lastDiscovery ? { ...v, lastDiscovery: observe(v.lastDiscovery) } : v);
        forbidden.value = false; loaded.value = true; readError.value = null; lastRead.value = now();
        if (!selectedId.value && rows[0]) selectedId.value = rows[0].connection.connectionId;
        // Exact reads retain foreign observations without claiming or cancelling their requests.
        const known = id ? [...new Map([...(knownAttempts.value[id] ?? []), ...(ownedAttempts.value[id] ?? [])]
          .map(a => [a.attemptId, a])).values()] : [];
        for (const previous of known.filter(isAttemptPending)) {
          const a = await api.attempt(id!, previous.attemptId, controller.signal);
          if (disposed || scope !== epoch || auth !== permission) return;
          if (ownedAttempts.value[id!]?.some(row => row.attemptId === a.attemptId)) remember(id!, a); else observe(a);
        }
      } catch (error) {
        if (disposed || scope !== epoch || auth !== permission) return;
        readError.value = expired ? "读取超时，请重新读取。" : errorOf(error).message;
      } finally {
        clearTimeout(deadline);
        if (readController === controller) { readController = null; reading.value = false; }
      }
    };
    readPromise = run();
    try { await readPromise; } finally {
      readPromise = null;
      if (queued && !disposed && visible && !forbidden.value) { queued = false; await refresh(); } else queued = false;
    }
  }
  function select(id: string): boolean {
    if (editor.value || saveOperation.value) return false;
    if (selectedId.value !== id) { selectedId.value = id; advance(); historical.value = null; historyError.value = null; actionError.value = null; void refresh(); }
    return true;
  }
  function openCreate(): void {
    if (disposed || forbidden.value || saveOperation.value) return;
    editorVersion++; editorController?.abort();
    const e: Editor = { kind: "create", id: null, baseRevision: null, name: "", endpoint: "", enabled: true, initial: "", loading: false, error: null };
    e.initial = fields(e); editor.value = e;
  }
  async function openEditor(kind: "edit" | "disable" = "edit"): Promise<void> {
    const view = selected.value;
    if (!view || forbidden.value || saveOperation.value || !isEditable(view.connection)) return;
    const generation = ++editorVersion, auth = permission, controller = new AbortController();
    editorController?.abort(); editorController = controller;
    editor.value = { kind, id: view.connection.connectionId, baseRevision: view.connection.revision,
      name: view.connection.name, enabled: kind === "disable" ? false : view.connection.enabled, endpoint: "", initial: "", loading: true, error: null };
    try {
      const configuration = await api.configuration(view.connection.connectionId, view.connection.revision, controller.signal);
      if (disposed || generation !== editorVersion || auth !== permission || !editor.value) return;
      if (configuration.enabled !== view.connection.enabled) throw new McpRequestError("配置来源与当前版本不一致，请重新读取。", 200, "invalid_response");
      editor.value.endpoint = configuration.transport.endpoint; editor.value.initial = fields(editor.value);
    } catch (error) { if (!disposed && generation === editorVersion && auth === permission && editor.value) { const message = errorOf(error).message; if (editor.value) editor.value.error = message; } }
    finally { if (generation === editorVersion && editor.value) editor.value.loading = false; }
  }
  function closeEditor(): boolean {
    if (saveOperation.value) { if (editor.value) editor.value.error = "原保存结果尚未核实，请先重试原保存；不会以新输入覆盖它。"; return false; }
    editorVersion++; editorController?.abort(); editor.value = null; return true;
  }
  async function adoptRevision(): Promise<void> {
    const e = editor.value; if (!e?.id || editorLocked.value) return;
    const generation = editorVersion, auth = permission; e.loading = true; e.error = null;
    try {
      const latest = await api.get(e.id);
      if (disposed || generation !== editorVersion || auth !== permission) return;
      upsert(latest);
      if (!isEditable(latest.connection)) throw new McpRequestError("该连接的传输或凭据配置已变化，本页不能继续编辑。", 409, "unsupported_configuration");
      const configuration = await api.configuration(e.id, latest.connection.revision);
      if (disposed || generation !== editorVersion || auth !== permission) return;
      e.baseRevision = latest.connection.revision;
      if (e.kind === "disable") { e.name = latest.connection.name; e.endpoint = configuration.transport.endpoint; }
    } catch (error) { if (!disposed && generation === editorVersion && auth === permission) e.error = errorOf(error).message; }
    finally { if (generation === editorVersion) e.loading = false; }
  }
  async function sendSave(): Promise<void> {
    const op = saveOperation.value; if (!op || forbidden.value || disposed) return;
    const auth = permission, controller = new AbortController(), recovering = op.state === "unknown";
    controllers.set("save", controller); op.state = "pending"; op.error = null;
    try {
      const receipt = await api.save(op.id, op.input, controller.signal);
      if (disposed || auth !== permission || saveOperation.value !== op) return;
      saveOperation.value = null; editorVersion++; editor.value = null; selectedId.value = receipt.connectionId;
      advance(); historical.value = null; options.onSaved?.(op.input.requestId); await refresh();
    } catch (error) {
      if (disposed || auth !== permission || saveOperation.value !== op) return;
      const e = errorOf(error); if (auth !== permission) return;
      if (editor.value) editor.value.error = e.message;
      if (e.uncertain || recovering) { op.state = "unknown"; op.error = e.message; }
      else { saveOperation.value = null; if (e.status === 409) await refresh(); }
    } finally { if (controllers.get("save") === controller) controllers.delete("save"); }
  }
  async function saveEditor(): Promise<void> {
    const e = editor.value; if (!e || editorLocked.value || e.error && !e.endpoint) return;
    const name = e.name.trim();
    try {
      const endpoint = new URL(e.endpoint);
      if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name) || !["http:", "https:"].includes(endpoint.protocol)
        || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || e.endpoint.length > 8192) throw new Error("invalid input");
    } catch { e.error = "请填写名称及完整 HTTP(S) 地址；地址不能含凭据、查询参数或片段。"; return; }
    const current = connections.value.find(v => v.connection.connectionId === e.id);
    if (e.id && current?.connection.revision !== e.baseRevision) { e.error = "连接版本已变化；编辑稿保留，请先采用最新版本作为保存基准。"; return; }
    const input: McpSaveInput = Object.freeze({ requestId: requestId(), name, enabled: e.enabled,
      ...(e.baseRevision === null ? {} : { expectedRevision: e.baseRevision }), transport: Object.freeze({ type: "streamable-http" as const, endpoint: e.endpoint }) });
    saveOperation.value = { id: e.id, input, state: "pending", error: null }; await sendSave();
  }
  async function recoverSave(): Promise<void> { if (saveOperation.value?.state === "unknown") await sendSave(); }
  async function sendDiscovery(id: string, op: DiscoveryOperation): Promise<void> {
    const auth = permission, controller = new AbortController(), recovering = op.state === "unknown";
    controllers.set(id, controller); op.state = "pending"; op.error = null;
    try {
      const attempt = await api.discover(id, op.input, controller.signal);
      if (disposed || auth !== permission || discoveries.value[id] !== op) return;
      op.state = "known"; op.attempt = attempt; remember(id, attempt);
      // A receipt for another selected object never selects it or replaces the current detail.
      advance(); await refresh();
    } catch (error) {
      if (disposed || auth !== permission || discoveries.value[id] !== op) return;
      const e = errorOf(error); if (auth !== permission) return;
      op.state = e.uncertain || recovering ? "unknown" : "failed"; op.error = e.message;
      if (op.state !== "unknown") await refresh();
    } finally { if (controllers.get(id) === controller) controllers.delete(id); }
  }
  async function discover(independent = false): Promise<void> {
    const id = selectedId.value, scope = epoch, auth = permission;
    if (!id || forbidden.value || preparing.value[id] || editor.value || saveOperation.value) return;
    const prior = discoveries.value[id];
    if (prior && (prior.state === "pending" || prior.state === "unknown")) return;
    const previous = selected.value?.lastDiscovery;
    if (previous && pending(previous) && !independent) { actionError.value = "已有持久发现仍未结束；可明确另行开始一次发现，旧状态与清理未知将保留。"; return; }
    preparing.value[id] = true; actionError.value = null;
    try {
      const fresh = await api.get(id);
      if (disposed || scope !== epoch || auth !== permission || id !== selectedId.value) return;
      upsert(fresh);
      if (!fresh.connection.enabled || !isEditable(fresh.connection)) throw new McpRequestError("当前连接未启用，或其传输/凭据不支持本页发现。", 400, "unsupported_configuration");
      if (pending(fresh.lastDiscovery) && !independent) { actionError.value = "发现状态已变化，请核对后明确另行开始。"; return; }
      discoveries.value[id] = { input: Object.freeze({ requestId: requestId(), expectedRevision: fresh.connection.revision }), state: "pending", attempt: null, error: null };
      await sendDiscovery(id, discoveries.value[id]!);
    } catch (error) { if (!disposed && scope === epoch && auth === permission) actionError.value = errorOf(error).message; }
    finally { preparing.value[id] = false; }
  }
  async function recoverDiscovery(): Promise<void> {
    const id = selectedId.value, op = id ? discoveries.value[id] : null;
    if (id && op?.state === "unknown" && !forbidden.value) await sendDiscovery(id, op);
  }
  function stopDiscovery(): void { if (selectedId.value) controllers.get(selectedId.value)?.abort(); }
  async function inspectAttempt(attempt: McpDiscoveryAttempt): Promise<void> {
    const scope = epoch, auth = permission; actionError.value = null;
    try {
      const current = await api.attempt(attempt.connectionId, attempt.attemptId);
      if (disposed || scope !== epoch || auth !== permission) return;
      // Inspecting a foreign latest attempt never makes it owned or eligible for automatic cancellation.
      if (ownedAttempts.value[attempt.connectionId]?.some(a => a.attemptId === current.attemptId)) remember(attempt.connectionId, current); else observe(current);
      await refresh();
    } catch (error) { if (!disposed && scope === epoch && auth === permission) actionError.value = errorOf(error).message; }
  }
  async function cancelAttempt(attempt: McpDiscoveryAttempt): Promise<void> {
    const id = attempt.connectionId, auth = permission;
    if (forbidden.value || !pending(attempt) || cancelPending.value[attempt.attemptId]
      || !ownedAttempts.value[id]?.some(a => a.attemptId === attempt.attemptId)) return;
    cancelPending.value[attempt.attemptId] = true; actionError.value = null;
    try {
      const result = await api.cancel(id, attempt.attemptId);
      if (disposed || auth !== permission) return;
      remember(id, result); advance(); await refresh();
    } catch (error) { if (!disposed && auth === permission) actionError.value = errorOf(error).message + " 请用该发现的精确记录核查，不推断取消或清理成功。"; }
    finally { cancelPending.value[attempt.attemptId] = false; }
  }
  async function loadHistory(digest: string): Promise<void> {
    const id = selectedId.value, scope = epoch, auth = permission, generation = ++historyVersion;
    if (!id || forbidden.value || !/^[a-f0-9]{64}$/.test(digest)) { historyError.value = "请填写已知的 64 位目录摘要。"; return; }
    historyController?.abort(); const controller = new AbortController(); historyController = controller;
    historyLoading.value = true; historyError.value = null;
    try {
      const result = await api.snapshot(id, digest, controller.signal);
      if (!disposed && scope === epoch && auth === permission && generation === historyVersion) historical.value = result;
    } catch (error) { if (!disposed && scope === epoch && auth === permission && generation === historyVersion) historyError.value = errorOf(error).message; }
    finally { if (generation === historyVersion) historyLoading.value = false; }
  }
  function currentCatalog(): void { historyVersion++; historyController?.abort(); historical.value = null; historyError.value = null; historyLoading.value = false; }
  function setVisible(value: boolean): void { const changed = visible !== value; visible = value; if (changed && value) void refresh(); }
  function start(): void { if (!polling && !disposed) { polling = setInterval(() => { if (visible) void refresh(); }, 15_000); polling.unref?.(); void refresh(); } }
  function dispose(): void {
    disposed = true; advance(); editorVersion++; editorController?.abort(); if (polling) clearInterval(polling);
    for (const c of controllers.values()) c.abort(); controllers.clear(); editor.value = null; saveOperation.value = null;
  }
  return { connections, selectedId, selected, loaded, reading, forbidden, readError, lastRead, editor, saveOperation, dirty, editorLocked,
    discoveries, ownedAttempts, knownAttempts, preparing, cancelPending, actionError, historical, snapshot, historyLoading, historyError,
    refresh, select, openCreate, openEditor, closeEditor, adoptRevision, saveEditor, recoverSave, discover, recoverDiscovery,
    stopDiscovery, inspectAttempt, cancelAttempt, loadHistory, currentCatalog, setVisible, start, dispose };
}
