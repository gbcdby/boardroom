<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave, RouterLink } from "vue-router";
import { createMcpCatalogState } from "../composables/useMcpCatalogState.ts";
import { useToast } from "../composables/useToast.ts";
import { isAttemptPending, isEditable } from "../api/mcp-connections.ts";
import type { McpDiscoveryAttempt, McpCatalogTool } from "../api/mcp-connections.ts";
import AppIcon from "../components/AppIcon.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import McpDrawer from "../components/McpDrawer.vue";
import McpToolDetails from "../components/McpToolDetails.vue";

const toast = useToast();
const state = createMcpCatalogState({ onSaved: id => toast.success("连接配置已保存。", `mcp-save:${id}`) });
const { connections, selectedId, selected, loaded, reading, forbidden, readError, lastRead, editor, saveOperation, dirty, editorLocked,
  discoveries, ownedAttempts, knownAttempts, preparing, cancelPending, actionError, historical, snapshot, historyLoading, historyError } = state;
const filter = ref(""), knownDigest = ref(""), selectedToolKey = ref<string | null>(null), toolDrawerOpen = ref(false);
const discard = ref(false), confirmIndependent = ref(false);
let leaveResolve: ((value: boolean) => void) | null = null;
const tools = computed(() => snapshot.value?.tools.filter(t => [t.ref.name, t.title ?? "", t.description ?? ""].some(v => v.toLocaleLowerCase().includes(filter.value.trim().toLocaleLowerCase()))) ?? []);
const selectedTool = computed(() => snapshot.value?.tools.find(t => t.toolKey === selectedToolKey.value) ?? null);
const operation = computed(() => selectedId.value ? discoveries.value[selectedId.value] ?? null : null);
const ownAttempts = computed(() => selectedId.value ? ownedAttempts.value[selectedId.value] ?? [] : []);
const foreignAttempts = computed(() => (selectedId.value ? knownAttempts.value[selectedId.value] ?? [] : [])
  .filter(attempt => !ownAttempts.value.some(owned => owned.attemptId === attempt.attemptId)));
const savePending = computed(() => saveOperation.value?.state === "pending");
const uncertainDiscovery = computed(() => Object.values(discoveries.value).some(o => o.state === "pending" || o.state === "unknown"));
const canDiscover = computed(() => !!selected.value && isEditable(selected.value.connection) && selected.value.connection.enabled && !forbidden.value
  && !preparing.value[selectedId.value!] && !editor.value && !["pending", "unknown"].includes(operation.value?.state ?? ""));
const latestPending = computed(() => !!selected.value?.lastDiscovery && isAttemptPending(selected.value.lastDiscovery));
const editorConflict = computed(() => !!editor.value?.id && selected.value?.connection.revision !== editor.value.baseRevision);
const editorTitle = computed(() => editor.value?.kind === "create" ? "新建 MCP 连接" : editor.value?.kind === "disable" ? "确认停用连接" : "编辑 MCP 连接");
const attemptLabels: Record<McpDiscoveryAttempt["status"], string> = { running: "发现进行中", cancel_requested: "已请求取消，结果待核实", succeeded: "目录发现完成", blocked: "发现受阻", connection_failed: "连接失败", discovery_failed: "目录读取失败", cancelled: "发现已取消", timed_out: "发现超时", superseded: "已被后续发现取代" };
const cleanupLabels: Record<McpDiscoveryAttempt["cleanup"], string> = { pending: "清理尚未确认", not_opened: "未建立远端会话", closed: "会话清理已确认", remote_unsupported: "远端不支持清理确认", remote_unknown: "远端清理结果未知" };
const time = (value: string) => new Date(value).toLocaleString("zh-CN");
function selectConnection(event: Event): void { const el = event.target as HTMLSelectElement; if (!state.select(el.value)) el.value = selectedId.value ?? ""; }
function showTool(tool: McpCatalogTool): void {
  selectedToolKey.value = tool.toolKey;
  if (typeof window !== "undefined" && window.matchMedia("(max-width: 1100px)").matches) toolDrawerOpen.value = true;
}
function requestCloseEditor(): void { if (saveOperation.value) return; if (dirty.value) discard.value = true; else state.closeEditor(); }
function discardEditor(): void { state.closeEditor(); discard.value = false; leaveResolve?.(true); leaveResolve = null; }
function keepEditor(): void { discard.value = false; leaveResolve?.(false); leaveResolve = null; }
async function independentDiscovery(): Promise<void> { confirmIndependent.value = false; await state.discover(true); }
function visibility(): void { if (typeof document !== "undefined") state.setVisible(document.visibilityState !== "hidden"); }
function beforeUnload(event: BeforeUnloadEvent): void {
  if (dirty.value || saveOperation.value || uncertainDiscovery.value) { event.preventDefault(); event.returnValue = ""; }
}
onBeforeRouteLeave(() => {
  if (saveOperation.value || uncertainDiscovery.value) { toast.info("请求结果尚待核实，请先处理原请求再离开。"); return false; }
  if (!dirty.value) return true;
  discard.value = true; return new Promise<boolean>(resolve => { leaveResolve = resolve; });
});
watch(selectedId, () => { selectedToolKey.value = null; toolDrawerOpen.value = false; filter.value = ""; });
watch(() => snapshot.value?.snapshotDigest, () => {
  if (selectedToolKey.value && !snapshot.value?.tools.some(tool => tool.toolKey === selectedToolKey.value)) {
    selectedToolKey.value = null; toolDrawerOpen.value = false;
  }
});
onMounted(() => {
  visibility(); state.start();
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", visibility);
  if (typeof window !== "undefined") { window.addEventListener("beforeunload", beforeUnload); window.addEventListener("online", state.refresh); window.addEventListener("focus", state.refresh); }
});
onBeforeUnmount(() => {
  if (typeof document !== "undefined") document.removeEventListener("visibilitychange", visibility);
  if (typeof window !== "undefined") { window.removeEventListener("beforeunload", beforeUnload); window.removeEventListener("online", state.refresh); window.removeEventListener("focus", state.refresh); }
  leaveResolve?.(false); state.dispose();
});
</script>

<template>
  <section class="page mcp-page">
    <header class="page-header"><div><h1><AppIcon name="layers" :size="28" />角色与能力</h1><p class="page-description">管理全局 MCP 连接，查看工具目录与发现记录。</p></div><button type="button" class="primary" data-testid="mcp-create" :disabled="forbidden || !!editor" @click="state.openCreate"><AppIcon name="plus" :size="17" />新建连接</button></header>
    <nav class="capability-nav" aria-label="角色与能力页面"><RouterLink to="/collaboration/connections">连接与实例</RouterLink><span aria-current="page">MCP</span></nav>
    <div class="mcp-toolbar"><label class="field connection-choice">全局连接<select :value="selectedId ?? ''" :disabled="!connections.length || !!editor" data-testid="mcp-connection" @change="selectConnection"><option v-if="!connections.length" value="">{{ loaded ? '尚无连接' : '等待读取' }}</option><option v-for="view in connections" :key="view.connection.connectionId" :value="view.connection.connectionId">{{ view.connection.name }} · v{{ view.connection.revision }}{{ view.connection.enabled ? '' : ' · 已停用' }} · {{ view.connection.connectionId.slice(0, 8) }}</option></select></label><button type="button" :disabled="reading" data-testid="mcp-refresh" @click="state.refresh">{{ reading ? '正在读取…' : '重新读取' }}</button><p class="read-time muted small" role="status">{{ lastRead ? `上次成功读取 ${time(lastRead)}` : '尚未取得目录记录' }}</p></div>
    <div v-if="readError" class="error" role="alert" data-testid="mcp-read-error"><p>{{ readError }}</p><p v-if="loaded && !forbidden">以下保留上次成功读取的记录，当前状态可能已变化。</p></div>
    <p v-if="!loaded && !readError" class="muted" role="status" :aria-busy="reading">正在读取全局 MCP 连接…</p>
    <div v-if="loaded && !connections.length && !readError" class="panel empty-state" data-testid="mcp-empty"><AppIcon name="layers" :size="32" /><h2>还没有 MCP 连接</h2><p>添加一个服务地址，保存后可手动发现它提供的工具。</p></div>
    <p v-if="loaded && connections.length && !selected" class="muted" role="status">原连接当前不可读，请选择列表中的连接。</p>
    <template v-if="selected">
      <section class="connection-summary" aria-label="当前连接"><div><h2>{{ selected.connection.name }}</h2><div class="summary-meta"><span class="badge">{{ selected.connection.enabled ? '已登记' : '已停用' }}</span><span class="muted small">{{ selected.connection.transport === 'stdio' ? 'stdio' : 'Streamable HTTP' }} · 配置 v{{ selected.connection.revision }}</span><span class="muted small">{{ selected.connection.credentialConfigured ? '已配置凭据 · 只读' : '无凭据' }}</span></div></div><div class="actions"><button v-if="isEditable(selected.connection)" type="button" :disabled="!!editor" data-testid="mcp-edit" @click="state.openEditor()">编辑连接</button><button v-if="isEditable(selected.connection) && selected.connection.enabled" type="button" :disabled="!!editor" data-testid="mcp-disable" @click="state.openEditor('disable')">停用</button><button v-if="!latestPending" type="button" :disabled="!canDiscover" data-testid="mcp-discover" @click="state.discover()">{{ operation?.state === 'pending' ? '正在发现…' : '发现工具目录' }}</button><button v-else type="button" :disabled="!canDiscover" data-testid="mcp-new-attempt" @click="confirmIndependent = true">另行开始一次发现</button></div></section>
      <p v-if="!isEditable(selected.connection)" class="scope-note small">此连接的传输方式或凭据配置在本页只读；保留已有目录与发现记录。</p><p v-else-if="!selected.connection.enabled" class="scope-note small">连接已停用，不能开始新的目录发现。已有目录和发现记录仍保留。</p>
      <div v-if="actionError" class="error" role="alert">{{ actionError }}</div>
      <div v-if="operation?.state === 'unknown'" class="pending-notice" role="status" data-testid="mcp-discovery-unknown"><strong>发现结果待核实</strong><p>{{ operation.error }} 原请求已保留，列表中的最近发现不能证明本次结果。</p><button type="button" data-testid="mcp-recover-discovery" @click="state.recoverDiscovery">继续上次刷新</button><p class="muted small">使用原请求重试；若服务尚未登记它，这个操作会开始一次目录发现。</p></div>
      <div v-else-if="operation?.state === 'pending'" class="pending-notice" role="status"><p>正在等待本次发现的精确回执。</p><button type="button" data-testid="mcp-stop-wait" @click="state.stopDiscovery">停止等待并核查结果</button><p class="muted small">停止等待不表示服务端已取消或清理完成。</p></div>
      <div v-if="operation?.state === 'failed'" class="error" role="alert">{{ operation.error }}</div>
      <section v-if="foreignAttempts.length || ownAttempts.length" class="discovery-records" aria-label="发现记录">
        <h3>发现记录</h3><p class="muted small">仅展示本页已读取精确标识的记录；旧记录和清理未知继续保留。</p>
        <div v-for="attempt in foreignAttempts" :key="attempt.attemptId" class="attempt-row" :data-testid="selected.lastDiscovery?.attemptId === attempt.attemptId ? 'mcp-latest-attempt' : 'mcp-known-attempt'"><div><strong>{{ attemptLabels[attempt.status] }}</strong><span class="muted small">{{ selected.lastDiscovery?.attemptId === attempt.attemptId ? '服务记录中的最近一次' : '本页已读取的旧记录' }} · v{{ attempt.connectionRevision }} · {{ cleanupLabels[attempt.cleanup] }}</span><code>{{ attempt.attemptId }}</code><span v-if="attempt.protocolVersion !== null || attempt.pages !== null" class="muted small">{{ attempt.protocolVersion === null ? '协议未协商' : `协议 ${attempt.protocolVersion}` }} · {{ attempt.pages === null ? '页数未确认' : `已读取 ${attempt.pages} 页` }}</span><span class="muted small">开始 {{ time(attempt.createdAt) }}<template v-if="attempt.finishedAt"> · 结束 {{ time(attempt.finishedAt) }}</template></span></div><button type="button" @click="state.inspectAttempt(attempt)">核查此记录</button></div>
        <div v-for="attempt in ownAttempts" :key="attempt.attemptId" class="attempt-row" data-testid="mcp-owned-attempt"><div><strong>{{ attemptLabels[attempt.status] }}</strong><span class="muted small">本页请求 · v{{ attempt.connectionRevision }} · {{ cleanupLabels[attempt.cleanup] }}</span><code>{{ attempt.attemptId }}</code><span v-if="attempt.protocolVersion !== null || attempt.pages !== null" class="muted small">{{ attempt.protocolVersion === null ? '协议未协商' : `协议 ${attempt.protocolVersion}` }} · {{ attempt.pages === null ? '页数未确认' : `已读取 ${attempt.pages} 页` }}</span><span class="muted small">开始 {{ time(attempt.createdAt) }}<template v-if="attempt.finishedAt"> · 结束 {{ time(attempt.finishedAt) }}</template></span><span v-if="attempt.errorCode" class="muted small">原因：{{ attempt.errorCode }}</span></div><div class="actions"><button type="button" @click="state.inspectAttempt(attempt)">核查记录</button><button v-if="isAttemptPending(attempt)" type="button" :disabled="cancelPending[attempt.attemptId]" data-testid="mcp-cancel-attempt" @click="state.cancelAttempt(attempt)">请求取消此发现</button></div></div>
      </section>
      <div class="catalog-layout">
        <section class="catalog-list panel" aria-labelledby="catalog-title"><header class="catalog-heading"><div><h2 id="catalog-title">{{ historical ? '已知历史目录' : '当前配置的工具目录' }}</h2><p class="muted small">{{ snapshot ? `${snapshot.tools.length} 个工具 · 配置 v${snapshot.connection.revision}` : '尚未取得当前配置的完整目录' }}</p></div><button v-if="historical" type="button" @click="state.currentCatalog">返回当前目录</button></header>
          <p class="catalog-note muted small">目录是一次发现的保存结果；不表示当前在线、已授权或已加载。</p>
          <label v-if="snapshot?.tools.length" class="field tool-filter"><span class="visually-hidden">筛选目录工具</span><input v-model="filter" type="search" placeholder="筛选工具名称或描述" data-testid="mcp-tool-filter" /></label>
          <div v-if="!snapshot" class="catalog-empty" data-testid="mcp-undiscovered"><AppIcon name="layers" :size="26" /><h3>目录尚未发现</h3><p class="muted small">保存连接不会自动连接服务。选择“发现工具目录”后可读取当前配置的工具。</p></div>
          <div v-else-if="!snapshot.tools.length" class="catalog-empty" data-testid="mcp-empty-catalog"><h3>这个目录没有工具</h3><p class="muted small">已成功读取完整目录，服务在这次发现中未返回工具。</p></div>
          <div v-else-if="!tools.length" class="catalog-empty"><p>没有匹配的工具。</p><button type="button" @click="filter = ''">清除筛选</button></div>
          <ul v-else class="tool-list" aria-label="目录工具"><li v-for="(tool, index) in tools" :key="tool.toolKey"><button type="button" class="tool-row" :class="{ selected: selectedToolKey === tool.toolKey }" :aria-pressed="selectedToolKey === tool.toolKey" :data-testid="`mcp-tool-${index}`" :data-tool-key="tool.toolKey" @click="showTool(tool)"><AppIcon name="layers" :size="21" /><span class="tool-name"><strong>{{ tool.title || tool.ref.name }}</strong><code>{{ tool.ref.name }}</code><span class="muted small">{{ selected.connection.name }} · v{{ tool.ref.connectionRevision }}</span></span><span class="badge">目录已发现</span><AppIcon name="chevron" :size="15" /></button></li></ul>
          <details class="catalog-history"><summary>目录标识与历史快照</summary><p v-if="snapshot" class="muted small">当前显示的精确摘要：<code data-testid="mcp-snapshot-digest">{{ snapshot.snapshotDigest }}</code></p><p class="muted small">可读取已有的精确目录摘要；此处不列举未知的历史快照。</p><label class="field">已知目录摘要<input v-model="knownDigest" spellcheck="false" maxlength="64" data-testid="mcp-history-digest" /></label><button type="button" :disabled="historyLoading" data-testid="mcp-load-history" @click="state.loadHistory(knownDigest)">{{ historyLoading ? '正在读取…' : '读取历史目录' }}</button><p v-if="historyError" class="error" role="alert">{{ historyError }}</p></details>
        </section>
        <aside class="tool-inspector" aria-label="工具详情"><McpToolDetails v-if="selectedTool && snapshot" :tool="selectedTool" :snapshot="snapshot" :connection-name="selected.connection.name" /><div v-else class="inspector-empty"><AppIcon name="layers" :size="32" /><h3>查看工具来源</h3><p class="muted small">选择目录中的工具，查看准确版本、结构与发现时间。</p><p class="scope-note small">尚未向模型提供工具。角色选择、授权、加载与调用尚未接通。</p></div></aside>
      </div>
    </template>
    <McpDrawer :open="!!editor" :title="editorTitle" :busy="savePending || !!editor?.loading" :lock-close="!!saveOperation" test-id="mcp-editor" @close="requestCloseEditor">
      <template v-if="editor"><p v-if="editor.kind === 'disable'" class="scope-note">停用后不能开始新的目录发现，已有目录和发现记录保留。</p><p class="muted small">保存只登记连接，不自动发现或加载工具。</p><p v-if="editor.loading" role="status">正在读取精确配置版本…</p><label class="field">连接名称<input v-model="editor.name" maxlength="128" :disabled="editorLocked || editor.kind === 'disable'" data-testid="mcp-name" /></label><label class="field">服务地址<input v-model="editor.endpoint" type="url" spellcheck="false" placeholder="http://localhost:3000/mcp" :disabled="editorLocked || editor.kind === 'disable'" data-testid="mcp-endpoint" aria-describedby="mcp-endpoint-help" /></label><p id="mcp-endpoint-help" class="muted small">支持无凭据 HTTP(S) 地址，不含用户名、密码、查询参数或片段。</p><label v-if="editor.kind !== 'disable'" class="enabled-field"><input v-model="editor.enabled" type="checkbox" :disabled="editorLocked" data-testid="mcp-enabled" />启用目录发现</label><p v-if="editor.baseRevision" class="muted small">编辑基准：v{{ editor.baseRevision }}</p><p v-if="editorConflict" class="pending-notice">当前配置已变化，编辑稿保留。请核对新版本后明确采用保存基准。</p><button v-if="editor.id" type="button" :disabled="editorLocked" data-testid="mcp-adopt-revision" @click="state.adoptRevision">读取并采用最新保存基准</button><p v-if="editor.error" class="error" role="alert">{{ editor.error }}</p><div v-if="saveOperation?.state === 'unknown'" class="pending-notice" role="status" data-testid="mcp-save-unknown"><strong>保存结果待核实</strong><p>原请求与输入已保留。重新读取列表不能证明本次保存成功；重试会使用同一个请求。</p></div></template>
      <template #footer><button v-if="saveOperation?.state === 'unknown'" type="button" class="primary" data-testid="mcp-recover-save" @click="state.recoverSave">重试原保存</button><template v-else><button type="button" :disabled="!!saveOperation" @click="requestCloseEditor">取消</button><button type="button" :class="editor?.enabled ? 'primary' : 'danger'" :disabled="editorLocked" data-testid="mcp-save" @click="state.saveEditor">{{ savePending ? '正在保存…' : editor?.enabled ? '保存连接' : '确认停用并保存' }}</button></template></template>
    </McpDrawer>
    <McpDrawer :open="toolDrawerOpen && !!selectedTool" :title="selectedTool?.title || selectedTool?.ref.name || '工具详情'" test-id="mcp-tool-drawer" @close="toolDrawerOpen = false"><McpToolDetails v-if="selectedTool && snapshot && selected" :tool="selectedTool" :snapshot="snapshot" :connection-name="selected.connection.name" /></McpDrawer>
    <ConfirmDialog :open="discard" title="放弃未保存的更改？" description="关闭后会丢弃本次编辑稿，已经保存的连接不受影响。" confirm-label="放弃更改" @confirm="discardEditor" @cancel="keepEditor" />
    <ConfirmDialog :open="confirmIndependent" title="另行开始一次发现？" description="已有发现仍未结束。此操作会创建独立的新请求；旧记录、取消和清理未知都会保留。" confirm-label="开始新的发现" @confirm="independentDiscovery" @cancel="confirmIndependent = false" />
  </section>
</template>

<style scoped>
h1 { display: flex; align-items: center; gap: 12px; }.capability-nav { display: flex; gap: 28px; border-bottom: 1px solid var(--border); margin-bottom: 24px; }.capability-nav a,.capability-nav > span { display: inline-flex; align-items: center; min-height: 46px; padding: 0 4px 12px; color: var(--muted); }.capability-nav > span { border-bottom: 3px solid var(--accent-fill); color: var(--fg); font-weight: 600; }
.mcp-toolbar { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; margin-bottom: 24px; }.connection-choice { flex: 1 1 300px; max-width: 520px; }.read-time { flex: 1 1 220px; text-align: right; margin: 0 0 8px; font-size: .78rem; }
.connection-summary { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; flex-wrap: wrap; margin: 24px 0 12px; }.connection-summary > div:first-child { min-width: 0; flex: 1 1 240px; }.connection-summary h2 { margin-bottom: 8px; }.summary-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }.scope-note,.pending-notice { color: var(--muted); background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 9px; padding: 13px 16px; }.pending-notice { margin: 16px 0; color: var(--fg); }.pending-notice strong { color: var(--warn); }
.discovery-records { border-top: 1px solid var(--border); margin-top: 20px; padding-top: 16px; }.discovery-records h3 { margin-bottom: 4px; }.attempt-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border); }.attempt-row > div:first-child { flex: 1 1 280px; min-width: 0; }.attempt-row strong,.attempt-row span,.attempt-row code { display: block; }.attempt-row strong { font-size: .9rem; }.attempt-row code { background: transparent; padding: 0; margin-top: 3px; font-size: .75rem; }
.catalog-layout { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 24px; margin-top: 24px; }.catalog-list.panel { padding: 0; overflow: hidden; }.catalog-heading { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 20px 20px 0; }.catalog-heading h2 { margin-bottom: 6px; font-size: 1.05rem; }.catalog-note { padding: 0 20px; font-size: .8rem; }.tool-filter { margin: 16px 20px; }.tool-list { padding: 0; margin: 16px 0 0; list-style: none; }.tool-list li { padding: 0 8px; }.tool-row { width: 100%; min-height: 90px; display: flex; justify-content: flex-start; gap: 12px; padding: 16px 12px; text-align: left; border: 1px solid transparent; border-bottom-color: var(--border); border-radius: 0; background: transparent; }.tool-row.selected { color: var(--fg); background: var(--accent-soft); border-color: var(--accent); border-radius: 9px; }.tool-name { min-width: 0; flex: 1; overflow-wrap: anywhere; }.tool-name > * { display: block; }.tool-name code { padding: 0; margin: 2px 0 4px; font-size: .75rem; background: transparent; color: var(--muted); }.tool-row > .badge { flex: none; font-size: .73rem; }.tool-row:focus-visible { outline-offset: -4px; }.catalog-empty { padding: 42px 24px; text-align: center; }.catalog-empty .app-icon { color: var(--muted); margin-bottom: 16px; }.catalog-empty h3 { font-size: 1rem; }
.catalog-history { padding: 12px 20px 20px; border-top: 1px solid var(--border); margin-top: 20px; }.catalog-history summary { font-size: .85rem; }.catalog-history button { margin-top: 12px; }.catalog-history code { display: block; word-break: break-all; background: transparent; padding: 4px 0; }.tool-inspector { padding: 4px 0 0 24px; border-left: 1px solid var(--border); min-width: 0; }.inspector-empty { padding: 22px 0; }.inspector-empty > .app-icon { color: var(--muted); margin-bottom: 16px; }.inspector-empty h3 { font-size: 1.1rem; }
.mcp-page :deep(.mcp-drawer .field) { margin-top: 20px; }.enabled-field { display: flex; align-items: center; gap: 9px; margin: 20px 0; }.mcp-page :deep(.mcp-drawer-body > p:first-child) { margin-top: 0; }
@media(max-width: 1250px) { .catalog-layout { grid-template-columns: minmax(0,1fr) 360px; gap: 16px; }.tool-inspector { padding-left: 16px; }.tool-row > .badge { display: none; } }
@media(max-width: 1100px) { .catalog-layout { grid-template-columns: minmax(0,1fr); }.tool-inspector { display: none; }.tool-row > .badge { display: inline-flex; }.read-time { text-align: left; } }
@media(max-width: 500px) { .mcp-toolbar { gap: 12px; }.connection-choice { flex-basis: 100%; }.read-time { margin: 0; }.connection-summary .actions { display: grid; width: 100%; grid-template-columns: repeat(2,minmax(0,1fr)); }.connection-summary .actions > :last-child { grid-column: 1/-1; }.tool-row { padding-inline: 8px; }.tool-row > .badge { display: none; }.catalog-heading { padding: 18px 16px 0; }.catalog-note { padding-inline: 16px; }.catalog-history { padding-inline: 16px; }.tool-filter { margin-inline: 16px; }.capability-nav { gap: 24px; }.attempt-row .actions { width: 100%; }.attempt-row .actions button { flex: 1; } }
</style>
