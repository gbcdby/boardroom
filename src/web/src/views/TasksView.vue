<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { ApiError, api, type MemberDto, type OrgNodeDto } from "../api/client.ts";
import { draftInput, emptyTaskDraft, taskStates, taskStateLabel, tasksApi, type Task, type TaskSettings } from "../api/tasks.ts";
import TaskFields from "../components/TaskFields.vue";
import { projectPath, useCurrentProject, useProjectDraft } from "../composables/useCurrentProject.ts";
import { beginTaskListRender, useTaskListViewState } from "../composables/useTaskListViewState.ts";

const context = useCurrentProject();
const { currentProjectId, readonly: projectReadonly } = context;
const tasks = ref<Task[]>([]);
const members = ref<MemberDto[]>([]);
const nodes = ref<OrgNodeDto[]>([]);
const settings = ref<TaskSettings | null>(null);
const defaultReviewer = ref("");
const draft = ref(emptyTaskDraft());
const createOpen = ref(false);
const { layout, filter } = useTaskListViewState(context);
const loading = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const conflict = ref(false);
let request = 0;
let scopeVersion = 0;
let pendingRender: ReturnType<typeof beginTaskListRender> | null = null;
let disposed = false;
const activeAgents = computed(() => members.value.filter((member) => member.kind === "agent" && member.status === "active"));
const defaultReviewerName = computed(() => settings.value?.reviewerValid ? members.value.find((member) => member.id === settings.value?.defaultReviewerMemberId)?.displayName ?? null : null);
const resolvedReviewer = computed(() => draft.value.reviewerMemberId || (settings.value?.reviewerValid ? settings.value.defaultReviewerMemberId : null));
const canCreate = computed(() => !projectReadonly.value && !loading.value && !busy.value && draft.value.title.trim() !== "" && members.value.some((member) => member.id === draft.value.assigneeMemberId && member.status === "active") && activeAgents.value.some((member) => member.id === resolvedReviewer.value) && resolvedReviewer.value !== draft.value.assigneeMemberId);
const visibleTasks = computed(() => tasks.value.filter((task) => !filter.value || task.state === filter.value));
const groups = computed(() => taskStates.filter((state) => !filter.value || state.value === filter.value).map((state) => ({ ...state, tasks: visibleTasks.value.filter((task) => task.state === state.value) })));
const hasDraft = () => Object.values(draft.value).some(Boolean) || (settings.value !== null && defaultReviewer.value !== (settings.value.defaultReviewerMemberId ?? ""));
useProjectDraft(hasDraft, () => { draft.value = emptyTaskDraft(); defaultReviewer.value = settings.value?.defaultReviewerMemberId ?? ""; createOpen.value = false; });
function nameOf(id: string | null): string { return members.value.find((member) => member.id === id)?.displayName ?? (id ? "成员已不可用" : "待重新指派"); }
function positionOf(id: string): string { return nodes.value.find((node) => node.memberId === id)?.name ?? "未分配岗位"; }
function current(projectId: string, generation: number, scope: number): boolean { return !disposed && currentProjectId.value === projectId && context.generation.value === generation && scopeVersion === scope; }

async function load(): Promise<void> {
  const projectId = currentProjectId.value;
  if (!projectId) return;
  const version = ++request;
  const generation = context.generation.value, scope = scopeVersion;
  const render = beginTaskListRender(context, projectId);
  pendingRender = render;
  loading.value = true; error.value = null;
  try {
    const [result, settingResult, org] = await Promise.all([tasksApi.list(projectId), tasksApi.settings(projectId), api.getOrg(projectId)]);
    if (!current(projectId, generation, scope) || version !== request) return;
    tasks.value = result.tasks; members.value = org.members; nodes.value = org.nodes;
    const keepSelection = settings.value && defaultReviewer.value !== (settings.value.defaultReviewerMemberId ?? "");
    settings.value = settingResult.settings;
    if (!keepSelection) defaultReviewer.value = settingResult.settings.defaultReviewerMemberId ?? "";
  } catch (err) { if (current(projectId, generation, scope) && version === request) error.value = err instanceof Error ? err.message : "任务读取失败，请重试。"; }
  finally {
    if (current(projectId, generation, scope) && version === request) {
      loading.value = false;
      await nextTick();
      if (current(projectId, generation, scope) && version === request) render.complete();
    }
  }
}

async function createTask(): Promise<void> {
  const projectId = currentProjectId.value;
  if (!projectId || !canCreate.value) return;
  const generation = context.generation.value, scope = scopeVersion;
  busy.value = true; error.value = null; notice.value = null;
  try {
    const result = await tasksApi.create(projectId, draftInput(draft.value));
    if (!current(projectId, generation, scope)) return;
    tasks.value = [result.task, ...tasks.value];
    draft.value = emptyTaskDraft(); createOpen.value = false;
    notice.value = `已创建「${result.task.title}」。负责人会收到任务分配事件。`;
  } catch (err) { if (current(projectId, generation, scope)) error.value = err instanceof Error ? err.message : "创建失败，填写内容已保留。"; }
  finally { if (current(projectId, generation, scope)) busy.value = false; }
}

async function saveSettings(): Promise<void> {
  const projectId = currentProjectId.value;
  if (!projectId || !settings.value || busy.value || projectReadonly.value) return;
  const generation = context.generation.value, scope = scopeVersion;
  busy.value = true; error.value = null; notice.value = null; conflict.value = false;
  try {
    const result = await tasksApi.setSettings(projectId, settings.value.revision, defaultReviewer.value || null);
    if (!current(projectId, generation, scope)) return;
    settings.value = result.settings; notice.value = "默认 reviewer 已保存。新建任务可直接使用此设置。";
  } catch (err) {
    if (!current(projectId, generation, scope)) return;
    conflict.value = err instanceof ApiError && err.status === 409;
    error.value = conflict.value ? "项目设置已变更。你的选择已保留，请载入最新设置并核对后再保存。" : err instanceof Error ? err.message : "保存失败，请重试。";
  } finally { if (current(projectId, generation, scope)) busy.value = false; }
}

function cancelCreate(): void {
  if (Object.values(draft.value).some(Boolean) && typeof window !== "undefined" && !window.confirm("丢弃尚未创建的任务内容？")) return;
  draft.value = emptyTaskDraft(); createOpen.value = false;
}
watch(currentProjectId, () => {
  pendingRender?.cancel(); pendingRender = null;
  scopeVersion++; request++;
  busy.value = false; loading.value = false; error.value = null; notice.value = null; conflict.value = false;
  tasks.value = []; settings.value = null; members.value = []; nodes.value = []; void load();
}, { immediate: true });
onBeforeUnmount(() => { disposed = true; request++; pendingRender?.cancel(); });
</script>

<template>
  <section class="page tasks-page">
    <header class="page-header"><div><h1>任务</h1><p class="page-description">让目标、负责人和评审结论保持清楚。</p></div><button type="button" class="primary" :disabled="!currentProjectId || projectReadonly || loading || busy" data-testid="task-create-open" @click="createOpen = true">创建任务</button></header>
    <div v-if="error" class="error" role="alert" data-testid="task-error">{{ error }} <button v-if="!busy" type="button" class="text-button" @click="load">{{ conflict ? '载入最新设置（保留选择）' : '重新加载' }}</button></div>
    <p v-if="notice" class="notice" role="status" data-testid="task-notice">{{ notice }}</p>
    <p v-if="projectReadonly" class="notice" role="status">项目已归档，可查看任务、评论与评审记录，无法修改。</p>
    <section v-if="createOpen" class="panel task-create-panel" aria-label="创建任务">
      <h2>创建任务</h2>
      <form @submit.prevent="createTask"><TaskFields v-model="draft" :members="members" :nodes="nodes" :disabled="busy || projectReadonly" :default-reviewer="defaultReviewerName" />
        <p v-if="resolvedReviewer && resolvedReviewer === draft.assigneeMemberId" class="warning-text small">负责人不能评审自己的任务，请另选 reviewer。</p>
        <p v-else-if="!resolvedReviewer" class="muted small">请选择一位 reviewer，或先在项目任务设置中配置默认 reviewer。</p>
        <div class="actions task-form-actions"><button type="submit" class="primary" :disabled="!canCreate" data-testid="task-create">{{ busy ? '正在创建…' : '创建任务' }}</button><button type="button" :disabled="busy" @click="cancelCreate">取消</button></div>
      </form>
    </section>
    <div class="task-toolbar">
      <label class="field">筛选状态<select v-model="filter" data-testid="task-state-filter"><option value="">全部状态</option><option v-for="state in taskStates" :key="state.value" :value="state.value">{{ state.label }}</option></select></label>
      <div class="actions" aria-label="任务显示方式"><button type="button" :aria-pressed="layout === 'board'" @click="layout = 'board'">看板</button><button type="button" :aria-pressed="layout === 'list'" @click="layout = 'list'" data-testid="task-list-mode">列表</button></div>
    </div>
    <p v-if="loading" role="status" class="muted">正在加载任务…</p>
    <div v-if="!currentProjectId" class="panel empty-state"><h2>选择一个项目</h2><p>选择项目后查看任务，或先创建项目。</p><RouterLink to="/projects">前往项目</RouterLink></div>
    <div v-else-if="!loading && !error && tasks.length === 0" class="panel empty-state"><h2>从一项明确的任务开始</h2><p>写下目标与验收条件，选择负责人和 reviewer。</p></div>
    <div v-if="currentProjectId" data-testid="task-board">
      <div v-if="layout === 'board'" class="task-board">
        <section v-for="group in groups" :key="group.value" class="task-column" :aria-label="group.label" :data-state="group.value"><h2>{{ group.label }} <span class="badge">{{ group.tasks.length }}</span></h2><ul><li v-for="task in group.tasks" :key="task.id" class="task-card"><RouterLink :to="projectPath(currentProjectId, 'tasks', task.id)" class="task-card-title">{{ task.title }}</RouterLink><p class="small muted">{{ nameOf(task.assigneeMemberId) }}</p><p v-if="task.blockedReason" class="small warning-text">{{ task.blockedReason }}</p><div class="actions"><span v-for="label in task.labels" :key="label" class="badge">{{ label }}</span></div></li><li v-if="group.tasks.length === 0" class="small muted task-column-empty">暂无任务</li></ul></section>
      </div>
      <ul v-else class="task-list"><li v-for="task in visibleTasks" :key="task.id" class="panel task-list-item"><div><RouterLink :to="projectPath(currentProjectId, 'tasks', task.id)" class="task-card-title">{{ task.title }}</RouterLink><p class="small muted">负责人：{{ nameOf(task.assigneeMemberId) }} · Reviewer：{{ nameOf(task.reviewerMemberId) }}</p><p v-if="task.blockedReason" class="small warning-text">{{ task.blockedReason }}</p></div><span class="badge" :class="`task-state-${task.state}`">{{ taskStateLabel(task.state) }}</span></li><li v-if="visibleTasks.length === 0 && tasks.length > 0" class="panel empty-state">该状态下暂无任务。</li></ul>
    </div>
    <details v-if="currentProjectId" class="panel task-settings"><summary>项目任务设置 <span class="muted small">默认 reviewer</span></summary><form @submit.prevent="saveSettings"><label class="field">默认 reviewer<select v-model="defaultReviewer" :disabled="projectReadonly || busy || !settings" data-testid="task-default-reviewer"><option value="">不设默认，新建任务时逐项选择</option><option v-if="settings?.defaultReviewerMemberId && !activeAgents.some((member) => member.id === settings?.defaultReviewerMemberId)" :value="settings.defaultReviewerMemberId" disabled>原 reviewer 已不可用，请重新选择</option><option v-for="member in activeAgents" :key="member.id" :value="member.id">{{ member.displayName }} · {{ positionOf(member.id) }}</option></select></label><p v-if="settings && !settings.reviewerValid" class="warning-text small">{{ settings.invalidReason || '尚未配置有效的默认 reviewer。' }}</p><p class="muted small">仅用于新建任务。已有任务的 reviewer 由任务详情单独管理。</p><button type="submit" :disabled="projectReadonly || busy || !settings || defaultReviewer === (settings.defaultReviewerMemberId ?? '')" data-testid="task-save-settings">保存默认 reviewer</button></form></details>
  </section>
</template>

<style scoped>
.task-create-panel { margin-bottom: 1.5rem; }
.task-form-actions { margin-top: 1.25rem; }
.task-toolbar { display: flex; align-items: end; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin: 1.25rem 0; }
.task-toolbar .field { min-width: 180px; }
.task-board { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: .75rem; align-items: start; }
.task-column { min-width: 0; padding: .75rem; border-radius: 12px; background: var(--surface-subtle); }
.task-column h2 { font-size: .95rem; margin: .2rem 0 .8rem; display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
.task-column ul, .task-list { list-style: none; padding: 0; margin: 0; display: grid; gap: .75rem; }
.task-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 9px; padding: .85rem; min-width: 0; }
.task-card-title { font-weight: 600; overflow-wrap: anywhere; }
.task-card p, .task-list-item p { overflow-wrap: anywhere; margin: .5rem 0; }
.task-card .badge { overflow-wrap: anywhere; min-width: 0; }
.task-column-empty { padding: 1.2rem .25rem; text-align: center; }
.task-list-item { display: flex; justify-content: space-between; align-items: start; flex-wrap: wrap; gap: 1rem; }
.task-list-item > div { min-width: 0; flex: 1 1 220px; }
.task-settings { margin-top: 1.5rem; }.task-settings form { max-width: 600px; padding-top: 1rem; }
.task-state-blocked { color: var(--warn); }.task-state-done { color: var(--ok); }
@media (max-width: 1100px) { .task-board { grid-template-columns: repeat(3,minmax(0,1fr)); } }
@media (max-width: 760px) { .task-board { grid-template-columns: 1fr; }.task-toolbar { align-items: stretch; }.task-toolbar .field { flex: 1 1 180px; } }
</style>
