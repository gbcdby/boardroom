<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { ApiError, type MemberDto, type OrgNodeDto } from "../api/client.ts";
import { draftInput, emptyTaskDraft, NO_REVIEWER, taskFieldErrors, taskStates, taskStateLabel, tasksApi, type Task, type TaskSettings, type TaskFieldErrors } from "../api/tasks.ts";
import TaskFields from "../components/TaskFields.vue";
import CreationDialog from "../components/CreationDialog.vue";
import ResourceSyncStatus from "../components/ResourceSyncStatus.vue";
import { acceptsTaskList, readTaskList, type TaskListResource } from "../api/task-resources.ts";
import { useResourceReconciliation } from "../composables/useResourceReconciliation.ts";
import { projectPath, useCurrentProject, useProjectDraft } from "../composables/useCurrentProject.ts";
import { beginTaskListRender, useTaskListViewState } from "../composables/useTaskListViewState.ts";
import { useToast } from "../composables/useToast.ts";

const context = useCurrentProject();
const toast = useToast();
const { currentProjectId, readonly: projectReadonly } = context;
const tasks = ref<Task[]>([]);
const members = ref<MemberDto[]>([]);
const nodes = ref<OrgNodeDto[]>([]);
const settings = ref<TaskSettings | null>(null);
const settingsBase = ref<TaskSettings | null>(null);
const defaultReviewer = ref("");
const draft = ref(emptyTaskDraft());
const createOpen = ref(false);
const { layout, filter } = useTaskListViewState(context);
const createError = ref<string | null>(null);
const createUnknown = ref(false);
const createFields = ref<TaskFieldErrors>({});
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const conflict = ref(false);
let scopeVersion = 0;
let pendingRender: ReturnType<typeof beginTaskListRender> | null = null;
let disposed = false;
const settingsDirty = computed(() => settingsBase.value !== null && defaultReviewer.value !== (settingsBase.value.defaultReviewerMemberId ?? ""));
const settingsRemoteChanged = computed(() => settingsDirty.value && settings.value?.revision !== settingsBase.value?.revision);
const resource = useResourceReconciliation<TaskListResource>({
  read: (scope, reader) => readTaskList(reader, scope.projectId), accepts: acceptsTaskList,
  onValue(snapshot, source) {
    // 已存在的行保持相对顺序和 keyed 控件；后台刷新不重置展示或创建草稿。
    const byId = new Map(snapshot.tasks.map(task => [task.id, task]));
    const previousIds = new Set(tasks.value.map(task => task.id));
    tasks.value = source === "mutation" ? snapshot.tasks : [...tasks.value.filter(task => byId.has(task.id)).map(task => byId.get(task.id)!), ...snapshot.tasks.filter(task => !previousIds.has(task.id))];
    members.value = snapshot.org.members; nodes.value = snapshot.org.nodes;
    const keepSelection = settingsDirty.value;
    settings.value = snapshot.settings;
    if (!keepSelection) { settingsBase.value = snapshot.settings; defaultReviewer.value = snapshot.settings.defaultReviewerMemberId ?? ""; }
  },
});
const loading = computed(() => resource.loading.value && resource.value.value === null);
const displayError = computed(() => error.value ?? resource.error.value);
const activeAgents = computed(() => members.value.filter((member) => member.kind === "agent" && member.status === "active"));
const defaultReviewerName = computed(() => settings.value?.reviewerValid ? members.value.find((member) => member.id === settings.value?.defaultReviewerMemberId)?.displayName ?? null : null);
const resolvedReviewer = computed(() => draft.value.reviewerMemberId === NO_REVIEWER ? null : draft.value.reviewerMemberId || (settings.value?.reviewerValid && settings.value.defaultReviewerMemberId !== draft.value.assigneeMemberId ? settings.value.defaultReviewerMemberId : null));
const canCreate = computed(() => !createUnknown.value && !projectReadonly.value && !loading.value && !busy.value && draft.value.title.trim() !== ""
  && (!draft.value.assigneeMemberId || members.value.some((member) => member.id === draft.value.assigneeMemberId && member.status === "active"))
  && (!resolvedReviewer.value || activeAgents.value.some((member) => member.id === resolvedReviewer.value))
  && (!resolvedReviewer.value || resolvedReviewer.value !== draft.value.assigneeMemberId));
const visibleTasks = computed(() => tasks.value.filter((task) => !filter.value || task.state === filter.value));
const matchingCreatedTasks = computed(() => tasks.value.filter(task => task.title === draft.value.title.trim()).sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
const groups = computed(() => taskStates.filter((state) => !filter.value || state.value === filter.value).map((state) => ({ ...state, tasks: visibleTasks.value.filter((task) => task.state === state.value) })));
const hasDraft = () => Object.values(draft.value).some(Boolean) || settingsDirty.value;
useProjectDraft(hasDraft, () => { draft.value = emptyTaskDraft(); defaultReviewer.value = settings.value?.defaultReviewerMemberId ?? ""; createOpen.value = false; createError.value = null; createUnknown.value = false; createFields.value = {}; });
function nameOf(id: string | null): string { return members.value.find((member) => member.id === id)?.displayName ?? (id ? "成员已不可用" : "待分派"); }
function positionOf(id: string): string { return nodes.value.find((node) => node.memberId === id)?.name ?? "未分配岗位"; }
function current(projectId: string, generation: number, scope: number): boolean { return !disposed && currentProjectId.value === projectId && context.generation.value === generation && scopeVersion === scope; }

async function load(): Promise<void> {
  error.value = null; await resource.refresh(true);
}

async function createTask(): Promise<void> {
  const projectId = currentProjectId.value;
  if (!projectId || !canCreate.value) return;
  const generation = context.generation.value, scope = scopeVersion;
  busy.value = true; error.value = null; notice.value = null; createError.value = null; createFields.value = {};
  try {
    const result = await tasksApi.create(projectId, draftInput(draft.value));
    if (!current(projectId, generation, scope)) return;
    draft.value = emptyTaskDraft(); createOpen.value = false;
    toast.success(`已保存「${result.task.title}」${result.task.assigneeMemberId ? "，已记录分派通知。" : "，可稍后补齐资料与分派。"}`, `task-created:${result.task.id}`);
    await resource.committed(snapshot => snapshot ? { ...snapshot, tasks: [result.task, ...snapshot.tasks.filter(task => task.id !== result.task.id)] } : null);
  } catch (err) {
    if (!current(projectId, generation, scope)) return;
    createUnknown.value = !(err instanceof ApiError) || err.status >= 500 || err.status === 408;
    createFields.value = taskFieldErrors(err);
    createError.value = createUnknown.value ? "保存结果尚未确认。请求可能已经生效，请先读取当前任务核对，不要重复保存。" : err instanceof Error ? err.message : "创建失败，填写内容已保留。";
  }
  finally { if (current(projectId, generation, scope)) busy.value = false; }
}

async function saveSettings(): Promise<void> {
  const projectId = currentProjectId.value;
  if (!projectId || !settingsBase.value || busy.value || projectReadonly.value || settingsRemoteChanged.value) return;
  const generation = context.generation.value, scope = scopeVersion;
  busy.value = true; error.value = null; notice.value = null; conflict.value = false;
  try {
    const result = await tasksApi.setSettings(projectId, settingsBase.value.revision, defaultReviewer.value || null);
    if (!current(projectId, generation, scope)) return;
    const superseded = settings.value !== null && result.settings.revision < settings.value.revision;
    if (!superseded) settingsBase.value = result.settings;
    notice.value = superseded ? "默认 reviewer 已保存，但远端已有后续更新。你的选择和原版本已保留，请核对后再保存。" : "默认 reviewer 已保存。新建任务可直接使用此设置。";
    await resource.committed(snapshot => snapshot ? { ...snapshot, settings: result.settings } : null);
  } catch (err) {
    if (!current(projectId, generation, scope)) return;
    conflict.value = err instanceof ApiError && err.status === 409;
    error.value = conflict.value ? "项目设置已变更。你的选择已保留，请载入最新设置并核对后再保存。" : err instanceof Error ? err.message : "保存失败，请重试。";
  } finally { if (current(projectId, generation, scope)) busy.value = false; }
}

function cancelCreate(): void {
  if (!createUnknown.value) { draft.value = emptyTaskDraft(); createError.value = null; createFields.value = {}; }
  createOpen.value = false;
}
function rebaseSettings(): void { if (settings.value && !busy.value && !projectReadonly.value) settingsBase.value = settings.value; }
watch([currentProjectId, context.generation], () => {
  pendingRender?.cancel(); pendingRender = null;
  scopeVersion++;
  busy.value = false; error.value = null; notice.value = null; conflict.value = false;
  tasks.value = []; settings.value = null; settingsBase.value = null; members.value = []; nodes.value = [];
  const projectId = currentProjectId.value, generation = context.generation.value, scope = scopeVersion;
  const render = projectId ? beginTaskListRender(context, projectId) : null; pendingRender = render;
  void resource.setScope(projectId ? { projectId, key: `${projectId}:${generation}:${scope}` } : null).then(async () => {
    await nextTick(); if (projectId && current(projectId, generation, scope)) render?.complete();
  });
}, { immediate: true });
onBeforeUnmount(() => { disposed = true; pendingRender?.cancel(); });
</script>

<template>
  <section class="page tasks-page">
    <header class="page-header"><div><h1>任务</h1><p class="page-description">先记下要做的事，再补齐目标、验收和分派。</p></div><button type="button" class="primary" :disabled="!currentProjectId || projectReadonly || loading || busy" data-testid="task-create-open" @click="createOpen = true">{{ createUnknown ? '核对上次保存' : '创建任务' }}</button></header>
    <ResourceSyncStatus v-if="currentProjectId" :connection="resource.connection.value" :last-read-at="resource.lastSuccessAt.value" :failed="!!resource.error.value" />
    <div v-if="displayError" class="error" role="alert" data-testid="task-error">{{ displayError }} <button v-if="!busy" type="button" class="text-button" @click="load">{{ conflict ? '载入最新设置（保留选择）' : '重新加载' }}</button></div>
    <p v-if="notice" class="notice" role="status" data-testid="task-notice">{{ notice }}</p>
    <p v-if="projectReadonly" class="notice" role="status">项目已归档，可查看任务、评论与评审记录，无法修改。</p>
    <CreationDialog :open="createOpen" title="创建任务" :pending="busy" :dirty="!createUnknown && Object.values(draft).some(Boolean)" :error="createError" :confirm-disabled="!canCreate" confirm-label="保存任务" confirm-test-id="task-create" @confirm="createTask" @close="cancelCreate">
      <p class="muted small">只需标题即可保存为待办，其他资料可以稍后完善。</p>
      <TaskFields v-model="draft" :members="members" :nodes="nodes" :disabled="busy || projectReadonly || createUnknown" :default-reviewer="defaultReviewerName" :errors="createFields" />
        <p v-if="resolvedReviewer && resolvedReviewer === draft.assigneeMemberId" class="warning-text small">负责人不能评审自己的任务，请另选 reviewer。</p>
        <p v-if="!draft.reviewerMemberId && draft.assigneeMemberId && settings?.defaultReviewerMemberId === draft.assigneeMemberId" class="muted small">项目默认评审人与负责人相同，本次会保存为暂未选择评审人。</p>
      <section v-if="createUnknown" class="task-unknown" data-testid="task-create-unknown"><p>关闭窗口不会撤销已发出的请求。本页会保留这次输入，重新打开可继续核对。</p><button type="button" :disabled="loading" @click="load">读取当前任务（不再次保存）</button><p v-if="displayError" class="error" role="alert">{{ displayError }}</p><p class="small">当前同标题任务（请逐项核对内容与时间）：</p><ul><li v-for="item in matchingCreatedTasks" :key="item.id"><RouterLink v-if="currentProjectId" :to="projectPath(currentProjectId, 'tasks', item.id)">{{ item.title }}</RouterLink> <span class="muted small">{{ item.id }} · {{ new Date(item.createdAt).toLocaleString('zh-CN') }}</span></li></ul><p class="muted small">列表中没有看到目标也不能证明请求没有生效。核实前请勿重新录入同一任务。</p></section>
    </CreationDialog>
    <div class="task-toolbar">
      <label class="field">筛选状态<select v-model="filter" data-testid="task-state-filter"><option value="">全部状态</option><option v-for="state in taskStates" :key="state.value" :value="state.value">{{ state.label }}</option></select></label>
      <div class="actions" aria-label="任务显示方式"><button type="button" class="selection-button" :aria-pressed="layout === 'board'" data-testid="task-board-mode" @click="layout = 'board'"><span class="selection-mark" aria-hidden="true">✓</span>看板</button><button type="button" class="selection-button" :aria-pressed="layout === 'list'" @click="layout = 'list'" data-testid="task-list-mode"><span class="selection-mark" aria-hidden="true">✓</span>列表</button></div>
    </div>
    <p v-if="loading" role="status" class="muted">正在加载任务…</p>
    <div v-if="!currentProjectId" class="panel empty-state"><h2>选择一个项目</h2><p>选择项目后查看任务，或先创建项目。</p><RouterLink to="/projects">前往项目</RouterLink></div>
    <div v-else-if="!loading && !displayError && tasks.length === 0" class="panel empty-state"><h2>先记下一项任务</h2><p>标题即可保存，目标、验收条件和负责人可稍后完善。</p></div>
    <div v-if="currentProjectId" data-testid="task-board">
      <div v-if="layout === 'board'" class="task-board">
        <section v-for="group in groups" :key="group.value" class="task-column" :aria-label="group.label" :data-state="group.value"><h2>{{ group.label }} <span class="badge">{{ group.tasks.length }}</span></h2><ul><li v-for="task in group.tasks" :key="task.id" class="task-card"><RouterLink :to="projectPath(currentProjectId, 'tasks', task.id)" class="task-card-title">{{ task.title }}</RouterLink><p class="small muted">{{ nameOf(task.assigneeMemberId) }}</p><p v-if="task.state === 'todo' && task.materialStatus?.startExecution.issues.length" class="small muted">{{ task.materialStatus.startExecution.issues.map(issue => issue.message).join(' ') }}</p><p v-if="task.blockedReason" class="small warning-text">{{ task.blockedReason }}</p><div class="actions"><span v-for="label in task.labels" :key="label" class="badge">{{ label }}</span></div></li><li v-if="group.tasks.length === 0" class="small muted task-column-empty">暂无任务</li></ul></section>
      </div>
      <ul v-else class="task-list"><li v-for="task in visibleTasks" :key="task.id" class="panel task-list-item"><div><RouterLink :to="projectPath(currentProjectId, 'tasks', task.id)" class="task-card-title">{{ task.title }}</RouterLink><p class="small muted">负责人：{{ nameOf(task.assigneeMemberId) }} · 评审人：{{ nameOf(task.reviewerMemberId) }}</p><p v-if="task.state === 'todo' && task.materialStatus?.startExecution.issues.length" class="small muted">{{ task.materialStatus.startExecution.issues.map(issue => issue.message).join(' ') }}</p><p v-if="task.blockedReason" class="small warning-text">{{ task.blockedReason }}</p></div><span class="badge" :class="`task-state-${task.state}`">{{ taskStateLabel(task.state) }}</span></li><li v-if="visibleTasks.length === 0 && tasks.length > 0" class="panel empty-state">该状态下暂无任务。</li></ul>
    </div>
    <details v-if="currentProjectId" class="panel task-settings"><summary>项目任务设置 <span class="muted small">默认 reviewer</span></summary><form @submit.prevent="saveSettings"><label class="field">默认 reviewer<select v-model="defaultReviewer" :disabled="projectReadonly || busy || !settings" data-testid="task-default-reviewer"><option value="">不设默认，新建任务时逐项选择</option><option v-if="settings?.defaultReviewerMemberId && !activeAgents.some((member) => member.id === settings?.defaultReviewerMemberId)" :value="settings.defaultReviewerMemberId" disabled>原 reviewer 已不可用，请重新选择</option><option v-for="member in activeAgents" :key="member.id" :value="member.id">{{ member.displayName }} · {{ positionOf(member.id) }}</option></select></label><p v-if="settings && !settings.reviewerValid" class="warning-text small">{{ settings.invalidReason || '尚未配置有效的默认 reviewer。' }}</p><p class="muted small">仅用于新建任务。已有任务的 reviewer 由任务详情单独管理。</p><p v-if="settingsRemoteChanged" class="notice" data-testid="task-settings-conflict">远端默认 reviewer 已更新为 {{ nameOf(settings?.defaultReviewerMemberId ?? null) }}；你的选择仍基于版本 {{ settingsBase?.revision }}。<button type="button" class="text-button" :disabled="busy || projectReadonly" data-testid="task-settings-rebase" @click="rebaseSettings">已核对，保留选择并采用最新版本</button></p><button type="submit" :disabled="projectReadonly || busy || !settingsBase || !settingsDirty || settingsRemoteChanged" data-testid="task-save-settings">保存默认 reviewer</button></form></details>
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
