<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { ApiError, api, type MemberDto, type OrgNodeDto } from "../api/client.ts";
import { memoryApi, memorySourceLabel, memoryTime, type MemoryConfig, type MemoryDocument, type MemoryVersion } from "../api/memory.ts";
import MemoryHistory from "../components/MemoryHistory.vue";
import MemorySummaryRequests from "../components/MemorySummaryRequests.vue";
import { useCurrentProject, useProjectDraft } from "../composables/useCurrentProject.ts";

const context = useCurrentProject();
const route = useRoute();
const router = useRouter();
const { currentProjectId, readonly: projectReadonly } = context;
const settings = ref<MemoryConfig | null>(null);
const members = ref<MemberDto[]>([]);
const nodes = ref<OrgNodeDto[]>([]);
const documents = ref<MemoryDocument[]>([]);
const metadataProject = ref<string | null>(null);
const metadataLoading = ref(false);
const metadataError = ref<string | null>(null);
const scope = computed(() => route.query["scope"] === "members" || typeof route.query["agentId"] === "string" ? "members" : "shared");
const targets = computed(() => {
  const options = new Map<string, { id: string; name: string; description: string; active: boolean }>();
  for (const member of members.value) {
    if (member.kind !== "agent" || !member.agentId || member.projectId !== currentProjectId.value) continue;
    const position = nodes.value.find((node) => node.memberId === member.id)?.name ?? "未分配岗位";
    const status = member.status === "disabled" ? " · 已停用" : member.status === "pending" ? " · 待加入" : "";
    options.set(member.agentId, { id: member.agentId, name: member.displayName, description: `${position}${status}`, active: member.status === "active" });
  }
  for (const entry of documents.value) {
    if (entry.key.scope !== "project-agent" || entry.key.projectId !== currentProjectId.value || options.has(entry.key.agentId)) continue;
    const name = entry.updatedBy.agentId === entry.key.agentId ? entry.updatedBy.displayName : `Agent ${entry.key.agentId.slice(0, 8)}`;
    options.set(entry.key.agentId, { id: entry.key.agentId, name, description: "已离开项目 · 记忆保留", active: false });
  }
  return [...options.values()];
});
const selectedAgentId = computed(() => scope.value === "shared" ? null : typeof route.query["agentId"] === "string" && route.query["agentId"] ? route.query["agentId"] : targets.value[0]?.id ?? null);
const selectedTarget = computed(() => targets.value.find((target) => target.id === selectedAgentId.value) ?? null);
const targetAvailable = computed(() => scope.value === "shared" || selectedTarget.value !== null);
const selectionKey = computed(() => `${currentProjectId.value}:${scope.value}:${selectedAgentId.value ?? ""}`);
const document = ref<MemoryDocument | null>(null);
const version = ref(0);
const draft = ref("");
const savedMarkdown = ref("");
const ready = ref(false);
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const conflict = ref(false);
const latest = ref<{ document: MemoryDocument | null; version: number } | null>(null);
const loadingLatest = ref(false);
const pendingRestore = ref<MemoryVersion | null>(null);
const editor = ref<HTMLTextAreaElement | null>(null);
const restoreConfirm = ref<HTMLButtonElement | null>(null);
const bytes = computed(() => new TextEncoder().encode(draft.value).length);
const invalidUnicode = computed(() => {
  for (const character of draft.value) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) return true;
  }
  return false;
});
const exceedsLimit = computed(() => settings.value !== null && bytes.value > settings.value.maxDocumentBytes);
const dirty = computed(() => draft.value !== savedMarkdown.value);
const canSave = computed(() => ready.value && !loading.value && !metadataLoading.value && !saving.value && !conflict.value && !projectReadonly.value && !exceedsLimit.value && !invalidUnicode.value && (dirty.value || version.value === 0));
let request = 0;
let metadataRequest = 0;
let disposed = false;
let lastAttempt: { markdown: string; expectedVersion: number; clientMutationId: string } | null = null;
useProjectDraft(() => dirty.value || saving.value, () => { draft.value = savedMarkdown.value; });
interface Selection { projectId: string; agentId: string | null; generation: number; request: number; key: string }
function capture(): Selection | null {
  const projectId = currentProjectId.value;
  return projectId && metadataProject.value === projectId && targetAvailable.value ? { projectId, agentId: selectedAgentId.value, generation: context.generation.value, request, key: selectionKey.value } : null;
}
function current(ticket: Selection): boolean {
  return !disposed && ticket.projectId === currentProjectId.value && ticket.generation === context.generation.value && ticket.request === request && ticket.key === selectionKey.value;
}
async function loadProject(): Promise<void> {
  const projectId = currentProjectId.value;
  if (!projectId) return;
  const ticket = ++metadataRequest, generation = context.generation.value;
  const valid = () => !disposed && ticket === metadataRequest && projectId === currentProjectId.value && generation === context.generation.value;
  metadataLoading.value = true; metadataError.value = null;
  try {
    const [org, list, config] = await Promise.all([api.getOrg(projectId), memoryApi.list(projectId), memoryApi.settings()]);
    if (!valid()) return;
    members.value = org.members; nodes.value = org.nodes; documents.value = list.documents; settings.value = config.settings; metadataProject.value = projectId;
  } catch (err) { if (valid()) metadataError.value = err instanceof Error ? err.message : "记忆目录读取失败，请重试。"; }
  finally { if (valid()) metadataLoading.value = false; }
}
async function selectScope(nextScope: "shared" | "members"): Promise<void> {
  if (metadataLoading.value || nextScope === scope.value) return;
  const query = { ...route.query };
  if (nextScope === "shared") { delete query["scope"]; delete query["agentId"]; }
  else { query["scope"] = "members"; if (targets.value[0]) query["agentId"] = targets.value[0].id; }
  await router.push({ path: route.path, query });
}
async function selectAgent(event: Event): Promise<void> {
  const control = event.target as HTMLSelectElement;
  if (targets.value.some((target) => target.id === control.value)) await router.push({ path: route.path, query: { ...route.query, scope: "members", agentId: control.value } });
  control.value = selectedAgentId.value ?? "";
}
async function load(keepDraft = false): Promise<void> {
  if (saving.value) return;
  request++;
  const ticket = capture();
  if (!ticket) return;
  loading.value = true; error.value = null;
  try {
    const head = await memoryApi.read(ticket.projectId, ticket.agentId);
    if (!current(ticket)) return;
    document.value = head.document; version.value = head.version;
    savedMarkdown.value = head.document?.markdown ?? "";
    if (!keepDraft) draft.value = savedMarkdown.value;
    ready.value = true;
  } catch (err) {
    if (current(ticket)) error.value = err instanceof Error ? err.message : "记忆读取失败，请重试。";
  } finally { if (current(ticket)) loading.value = false; }
}
async function save(): Promise<void> {
  const ticket = capture();
  if (!ticket || !canSave.value) return;
  const markdown = draft.value;
  if (!lastAttempt || lastAttempt.markdown !== markdown || lastAttempt.expectedVersion !== version.value) {
    lastAttempt = { markdown, expectedVersion: version.value, clientMutationId: crypto.randomUUID() };
  }
  saving.value = true; error.value = null; notice.value = null;
  try {
    const result = await memoryApi.write(ticket.projectId, ticket.agentId, lastAttempt);
    if (!current(ticket)) return;
    document.value = result.document; version.value = result.document.version; savedMarkdown.value = result.document.markdown;
    lastAttempt = null;
    notice.value = `已保存为版本 ${result.writtenVersion.version}。${draft.value !== markdown ? "你继续输入的内容仍在草稿中。" : ""}`;
    latest.value = null;
    if (result.document.version > result.writtenVersion.version && result.document.markdown !== markdown) {
      conflict.value = true;
      latest.value = { document: result.document, version: result.document.version };
      notice.value = `已确认保存版本 ${result.writtenVersion.version}，当前记录已更新到版本 ${result.document.version}。请核对最新正文。`;
    }
  } catch (err) {
    if (current(ticket)) {
      conflict.value = err instanceof ApiError && err.status === 409;
      error.value = `${err instanceof Error ? err.message : "保存失败"}。你的草稿已保留。`;
    }
  } finally { if (current(ticket)) saving.value = false; }
}
async function readLatest(): Promise<void> {
  const ticket = capture();
  if (!ticket || saving.value || loadingLatest.value) return;
  loadingLatest.value = true; error.value = null;
  try {
    const result = await memoryApi.read(ticket.projectId, ticket.agentId);
    if (current(ticket)) latest.value = result;
  } catch (err) {
    if (current(ticket)) error.value = `${err instanceof Error ? err.message : "最新版本读取失败"}。草稿和保存基准保持不变。`;
  } finally { if (current(ticket)) loadingLatest.value = false; }
}
function acceptLatest(): void {
  if (!latest.value || loadingLatest.value || saving.value) return;
  document.value = latest.value.document; version.value = latest.value.version; savedMarkdown.value = latest.value.document?.markdown ?? "";
  lastAttempt = null; conflict.value = false; error.value = null;
  notice.value = `保存基准已更新为版本 ${version.value}。你的草稿保持不变，请核对后保存。`;
  void nextTick(() => editor.value?.focus?.());
}
function useVersion(entry: MemoryVersion): void {
  if (!ready.value || projectReadonly.value || saving.value) return;
  if (dirty.value && draft.value !== entry.markdown) {
    pendingRestore.value = entry;
    void nextTick(() => restoreConfirm.value?.focus?.());
  }
  else applyVersion(entry);
}
function cancelRestore(): void { pendingRestore.value = null; void nextTick(() => editor.value?.focus?.()); }
function applyVersion(entry: MemoryVersion): void {
  if (!ready.value || projectReadonly.value || saving.value) return;
  draft.value = entry.markdown; pendingRestore.value = null; lastAttempt = null;
  notice.value = `版本 ${entry.version} 的正文已放入草稿。保存后将生成新版本。`;
  void nextTick(() => editor.value?.focus?.());
}
function resetDocument(): void {
  request++; ready.value = false; loading.value = false; saving.value = false;
  document.value = null; version.value = 0; draft.value = ""; savedMarkdown.value = ""; error.value = null; notice.value = null; lastAttempt = null;
  conflict.value = false; latest.value = null; loadingLatest.value = false;
  pendingRestore.value = null;
}
watch(currentProjectId, () => {
  metadataRequest++; metadataProject.value = null; members.value = []; nodes.value = []; documents.value = []; settings.value = null; metadataError.value = null;
  void loadProject();
}, { immediate: true });
watch([selectionKey, metadataProject, targetAvailable], () => {
  resetDocument();
  void load();
}, { immediate: true });
onBeforeUnmount(() => { disposed = true; request++; metadataRequest++; });
</script>

<template>
  <section class="page memory-page">
    <header class="page-header"><div><h1>记忆</h1><p class="page-description">留下项目共识，让下一次协作有据可循。</p></div></header>
    <div v-if="!currentProjectId" class="panel empty-state"><h2>选择一个项目</h2><p>在当前项目中查看与维护记忆。</p><RouterLink to="/projects">前往项目</RouterLink></div>
    <template v-else>
      <p v-if="projectReadonly" class="notice" role="status">项目已归档，记忆与历史可查看，无法修改。</p>
      <div class="memory-toolbar"><div class="memory-scopes" role="group" aria-label="记忆范围"><button type="button" :aria-pressed="scope === 'shared'" :disabled="metadataLoading" data-testid="memory-scope-shared" @click="selectScope('shared')">项目共享</button><button type="button" :aria-pressed="scope === 'members'" :disabled="metadataLoading" data-testid="memory-scope-members" @click="selectScope('members')">成员记忆</button></div><label v-if="scope === 'members'" class="field memory-target">Agent 成员<select :value="selectedAgentId ?? ''" :disabled="metadataLoading || targets.length === 0" data-testid="memory-agent" @change="selectAgent"><option v-if="!selectedTarget" :value="selectedAgentId ?? ''" disabled>{{ selectedAgentId ? '该成员不可用' : '暂无 Agent 成员' }}</option><option v-for="target in targets" :key="target.id" :value="target.id">{{ target.name }} · {{ target.description }}</option></select></label></div>
      <p v-if="metadataLoading" class="muted" role="status">正在读取记忆目录…</p>
      <div v-if="metadataError" class="error" role="alert">{{ metadataError }} <button type="button" class="text-button" :disabled="metadataLoading" data-testid="memory-retry-directory" @click="loadProject">重新读取目录</button></div>
      <div v-if="!metadataLoading && !metadataError && scope === 'members' && !targetAvailable" class="panel empty-state"><h2>{{ selectedAgentId ? '该成员记忆不可用' : '还没有 Agent 成员' }}</h2><p>{{ selectedAgentId ? '请从当前项目的可维护记忆中选择成员。' : '添加 Agent 成员后，可以维护其在本项目中的记忆。' }}</p></div>
      <div v-if="error" class="error" role="alert" data-testid="memory-error">{{ error }} <button v-if="!conflict" type="button" class="text-button" :disabled="loading || saving" @click="load(dirty)">重新读取（保留草稿）</button></div>
      <p v-if="notice" class="notice" role="status" data-testid="memory-notice">{{ notice }}</p>
      <section v-if="pendingRestore" class="notice" role="region" aria-labelledby="memory-restore-title"><h2 id="memory-restore-title">替换当前编辑草稿？</h2><p>你的草稿尚未保存。确认后将用版本 {{ pendingRestore.version }} 的正文替换草稿；已保存的记忆保持原样。</p><div class="actions"><button type="button" data-testid="memory-restore-cancel" @click="cancelRestore">保留当前草稿</button><button ref="restoreConfirm" type="button" :disabled="projectReadonly || saving" data-testid="memory-restore-confirm" @click="applyVersion(pendingRestore)">用历史正文替换草稿</button></div></section>
      <section v-if="conflict || latest" class="panel memory-comparison" aria-labelledby="memory-conflict-title" data-testid="memory-conflict">
        <h2 id="memory-conflict-title">{{ conflict ? '记忆已更新，请核对版本' : '最新版本参考' }}</h2>
        <p class="small">本地草稿已保留，读取最新正文不会替换输入，也不会自动保存。</p>
        <button v-if="conflict" type="button" :disabled="loadingLatest || saving" data-testid="memory-read-latest" @click="readLatest">{{ loadingLatest ? '正在读取…' : '读取最新版本' }}</button>
        <template v-if="latest"><h3>版本 {{ latest.version }}</h3><pre data-testid="memory-latest-text">{{ latest.document?.markdown || '此版本正文为空。' }}</pre><button v-if="conflict" type="button" :disabled="loadingLatest || saving" data-testid="memory-rebase" @click="acceptLatest">以此版本为基准，继续编辑我的草稿</button></template>
      </section>
      <section v-if="metadataProject === currentProjectId && targetAvailable" class="panel memory-document" aria-labelledby="memory-title" :aria-busy="loading">
        <div class="memory-document-heading"><div><h2 id="memory-title">{{ scope === 'shared' ? '项目共享' : selectedTarget?.name }}</h2><p class="muted small">{{ scope === 'shared' ? '维护项目成员共同遵循的事实、约定与协作方式。' : '保存这位 Agent 在当前项目中的上下文与经验。' }}</p></div><span v-if="ready" class="badge" data-testid="memory-version">{{ version ? `版本 ${version}` : '尚未创建' }}</span></div>
        <p v-if="loading" role="status" class="muted">正在读取记忆…</p>
        <p v-else-if="ready && !document" class="muted small">还没有这份记忆。写下值得保留的内容，保存后创建第一个版本。</p>
        <p v-if="document" class="muted small memory-meta">{{ document.updatedBy.displayName }} · {{ memorySourceLabel(document.source) }} · <time :datetime="document.updatedAt">{{ memoryTime(document.updatedAt) }}</time></p>
        <form @submit.prevent="save">
          <label class="field" for="memory-body">记忆正文</label>
          <textarea id="memory-body" ref="editor" v-model="draft" rows="12" class="memory-editor" :disabled="!ready || loading || projectReadonly" :aria-invalid="exceedsLimit || invalidUnicode" :aria-describedby="`memory-help memory-count${invalidUnicode ? ' memory-unicode-error' : ''}`" data-testid="memory-editor" />
          <div class="memory-editor-meta"><p id="memory-help" class="muted small">支持 Markdown 源文本。正文与预览均按普通文本显示。</p><p id="memory-count" class="small" :class="exceedsLimit ? 'warning-text' : 'muted'" data-testid="memory-byte-count">{{ invalidUnicode ? '—' : bytes.toLocaleString('en-US') }} / {{ settings?.maxDocumentBytes.toLocaleString('en-US') ?? '—' }} 字节</p></div>
          <p v-if="exceedsLimit" class="error" role="alert">正文超过当前字节上限，请精简后保存。草稿不会被截断。</p>
          <p v-if="invalidUnicode" id="memory-unicode-error" class="error" role="alert">正文包含无效的 Unicode 字符，请移除或重新输入后保存。</p>
          <div class="actions memory-save-actions"><button type="submit" class="primary" :disabled="!canSave" data-testid="memory-save">{{ saving ? '正在保存…' : version ? '保存记忆' : '创建记忆' }}</button><span v-if="dirty" class="muted small">有未保存的更改</span></div>
        </form>
        <details class="memory-preview"><summary>预览正文</summary><pre data-testid="memory-preview-text">{{ draft || '暂无内容。' }}</pre></details>
      </section>
      <MemoryHistory v-if="ready" :key="selectionKey" :project-id="currentProjectId" :agent-id="selectedAgentId" :current-version="version" :readonly="projectReadonly || saving" @use="useVersion" />
      <MemorySummaryRequests v-if="ready && selectedAgentId && selectedTarget" :key="selectionKey" :project-id="currentProjectId" :agent-id="selectedAgentId" :current-version="version" :active="selectedTarget.active" :readonly="projectReadonly" />
      <details v-if="settings" class="panel memory-settings"><summary>记忆设置 <span class="muted small">当前生效配置</span></summary><dl><div><dt>文档上限</dt><dd>{{ settings.maxDocumentBytes.toLocaleString('en-US') }} 字节</dd></div><div><dt>消息触发阈值</dt><dd>每 {{ settings.messageThreshold }} 条首次实际投递的可见消息</dd></div><div><dt>自动注入上限</dt><dd>{{ settings.maxInjectedBytes.toLocaleString('en-US') }} 字节</dd></div><div><dt>总结输入上限</dt><dd>{{ settings.summaryInputBytes.toLocaleString('en-US') }} 字节</dd></div><div><dt>总结等待时限</dt><dd>{{ Math.round(settings.summaryAttemptTimeoutMs / 60000) }} 分钟</dd></div></dl><p class="muted small">这些值来自服务启动时读取的配置。修改配置后重新启动服务生效。</p></details>
    </template>
  </section>
</template>

<style scoped>
.memory-toolbar { display: flex; align-items: end; justify-content: space-between; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.25rem; }
.memory-scopes { display: flex; flex-wrap: wrap; gap: .25rem; padding: .25rem; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-subtle); }
.memory-scopes button { background: transparent; border-color: transparent; }.memory-scopes button[aria-pressed="true"] { background: var(--card-bg); border-color: var(--border); color: var(--accent); }
.memory-target { flex: 0 1 420px; min-width: 0; }.memory-target select { max-width: 100%; }
.memory-document-heading, .memory-editor-meta { display: flex; align-items: start; justify-content: space-between; flex-wrap: wrap; gap: .75rem; }
.memory-document-heading h2 { margin: 0; }.memory-document-heading p { margin-bottom: 1rem; }
.memory-document-heading > div { flex: 1 1 220px; min-width: 0; }
.memory-meta { overflow-wrap: anywhere; }.memory-editor { width: 100%; min-height: 280px; resize: vertical; line-height: 1.65; }
.memory-editor-meta p { margin: .6rem 0; }.memory-save-actions { margin-top: .5rem; }
.memory-preview { border-top: 1px solid var(--border); margin-top: 1.25rem; padding-top: 1rem; }
.memory-preview pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 1.65; }
.memory-comparison { margin-bottom: 1rem; }.memory-comparison pre { max-height: 20rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 1.65; }
.memory-settings { margin-top: 1.25rem; }.memory-settings dl { display: grid; gap: .75rem; margin: 1rem 0; }
.memory-settings dl > div { display: flex; flex-wrap: wrap; gap: .5rem 1rem; }.memory-settings dt { color: var(--muted); min-width: 8rem; }.memory-settings dd { margin: 0; }
@media (max-width: 760px) { .memory-editor { min-height: 240px; }.memory-editor-meta { gap: 0; }.memory-save-actions .primary { width: 100%; } }
</style>
