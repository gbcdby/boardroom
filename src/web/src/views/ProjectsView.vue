<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import CreationDialog from "../components/CreationDialog.vue";
import PurgeImpact from "../components/PurgeImpact.vue";
import { useConfirmedAction } from "../composables/useConfirmedAction.ts";
import { useToast } from "../composables/useToast.ts";
import {
  ApiError,
  api,
  type GroupDto,
  type GroupPurgeConfirmation,
  type MemberDto,
  type MemberStatusDto,
  type ProjectPurgeConfirmation,
} from "../api/client.ts";

/**
 * T1（#14）项目工作台 + T1（#48）项目/群组生命周期 + T3（#50）成员生命周期：
 * 创建项目、管理成员、指定顶层 manager、创建群组选参与者，以及
 * **归档 / 恢复 / 永久删除（人二次确认）** 与 **成员暂停 / 恢复**。
 *
 * 生命周期规则（与 `src/server/api.ts` 一致）：
 * - 归档是可恢复的非活跃态：默认列表隐藏（勾选「显示已归档」可见），归档对象拒绝新写入。
 * - 永久删除要两刀：第一刀只取级联清单与一次性确认凭据，第二刀带同一凭据才真正清除。
 *   项目清除其群组/群聊/成员与状态；群组只清群聊与参与者关系，成员保留。
 * - 成员生命周期（active/disabled/pending）与在线/运行状态分开：暂停保留历史、数据与岗位、
 *   可随时恢复，不物理删除；断连不删除成员、不改写该状态（#50）。
 *
 * 阶段 1 只验收单个项目；页面允许切换项目。真实 agent 成员由 T2（MCP 入群）产生。
 */

import { projectPath, useCurrentProject, useProjectDraft } from "../composables/useCurrentProject.ts";
const props = defineProps<{ mode?: "list" | "overview" | "members" | "settings" | "groups" }>();
const route = useRoute();
const viewMode = computed(() => props.mode ?? (!route.params["projectId"] ? "list" : route.meta["projectSection"] === "members" ? "members" : route.meta["projectSection"] === "settings" ? "settings" : route.query["manage"] === "groups" ? "groups" : "overview"));
const creation = ref<"project" | "group" | null>(null);
const projectSearch = computed({ get: () => typeof route.query["q"] === "string" ? route.query["q"] : "", set: value => { void router.replace({ path: route.path, query: { ...route.query, q: value || undefined }, hash: route.hash }); } });
const memberCreateOpen = ref(false);
const pageTitle = computed(() => ({ list: "所有项目", overview: "项目概览", members: "项目成员", settings: "项目设置", groups: "群组管理" })[viewMode.value]);
const router = useRouter();
const context = useCurrentProject();
const { currentProjectId: activeProjectId, currentProject: activeProject, readonly: projectReadonly } = context;
const projects = computed(() => context.projects.value.filter((project) => (showArchived.value || !project.archivedAt) && project.name.toLocaleLowerCase().includes(projectSearch.value.trim().toLocaleLowerCase())));
let disposed = false;
let projectRequest = 0;
const members = ref<MemberDto[]>([]);
const groups = ref<GroupDto[]>([]);
/** 群组 id → 参与者列表。 */
const participants = ref<Record<string, MemberDto[]>>({});
/** 项目成员在线/连接状态（T2）：memberId → 状态视图。 */
const statuses = ref<Record<string, MemberStatusDto>>({});
/** 「显示已归档」开关：项目与群组列表一起受影响。 */
const showArchived = ref(route.query["archived"] === "1");
/** 等待人二次确认的永久删除（#48）。 */
const pendingProjectPurge = ref<ProjectPurgeConfirmation | null>(null);
const pendingGroupPurge = ref<GroupPurgeConfirmation | null>(null);
const confirmationKind = ref<"project-purge" | "group-purge" | "normal">("normal");

const pendingRequests = ref(0);
const loading = ref(true);
const loadingProject = ref(false);
const busy = computed(() => pendingRequests.value > 0 || loading.value || loadingProject.value);
const error = ref<string | null>(null);
const toast = useToast();
const confirmation = useConfirmedAction({ success: toast.success, refreshError: (message) => { error.value = message; } });
const { action: confirmationAction, phase: confirmationPhase, error: confirmationError, pending: confirmationPending, canConfirm } = confirmation;

const newProjectName = ref("");
const newMemberName = ref("");
const newGroupName = ref("");
/** 新群组默认选中的成员 id。 */
const newGroupSelection = ref<string[]>([]);

const manager = computed<MemberDto | null>(() => activeProject.value?.manager ?? null);

function clearMessages(): void {
  error.value = null;
}

async function run<T>(fn: () => Promise<T>, success?: string, preserveFeedback = false): Promise<T | null> {
  if (!preserveFeedback) clearMessages();
  const generation = context.generation.value;
  pendingRequests.value++;
  try {
    const result = await fn();
    if (disposed || generation !== context.generation.value) return null;
    if (success !== undefined) toast.success(success);
    return result;
  } catch (err) {
    if (!disposed && generation === context.generation.value) error.value = err instanceof ApiError ? err.message : (err as Error).message;
    return null;
  } finally {
    pendingRequests.value--;
  }
}

async function loadProjects(): Promise<void> {
  loading.value = true;
  try { await context.refreshProjects(); if (!disposed) await loadActiveProject(); }
  finally { if (!disposed) loading.value = false; }
}

async function toggleShowArchived(): Promise<void> {
  if (busy.value) return;
  clearMessages();
  await router.replace({ path: route.path, query: { ...route.query, archived: showArchived.value ? undefined : "1" }, hash: route.hash });
}

async function loadActiveProject(): Promise<void> {
  const projectId = activeProjectId.value;
  const version = ++projectRequest;
  if (projectId === null || viewMode.value === "list") {
    members.value = [];
    groups.value = [];
    participants.value = {};
    statuses.value = {};
    loadingProject.value = false;
    return;
  }
  loadingProject.value = true;
  try {
    const [memberResult, groupResult] = await Promise.all([
      run(() => api.listMembers(projectId), undefined, true),
      run(() => api.listGroups(projectId, { includeArchived: showArchived.value }), undefined, true),
    ]);
    if (disposed || version !== projectRequest || activeProjectId.value !== projectId) return;
    if (memberResult) members.value = memberResult.members;
    if (groupResult) {
      groups.value = groupResult.groups;
      await loadParticipants(projectId);
    }
    await loadStatuses();
  } finally {
    if (!disposed && version === projectRequest) loadingProject.value = false;
  }
}

async function loadParticipants(projectId: string): Promise<void> {
  const map: Record<string, MemberDto[]> = {};
  await Promise.all(
    groups.value.map(async (group) => {
      const result = await run(() => api.listParticipants(group.id), undefined, true);
      map[group.id] = result?.participants ?? [];
    }),
  );
  if (activeProjectId.value === projectId) participants.value = map;
}

async function loadStatuses(): Promise<void> {
  const projectId = activeProjectId.value;
  if (projectId === null) {
    statuses.value = {};
    return;
  }
  const result = await run(() => api.listMemberStatuses(projectId), undefined, true);
  if (!result || activeProjectId.value !== projectId) return;
  const map: Record<string, MemberStatusDto> = {};
  for (const status of result.memberStatuses) map[status.memberId] = status;
  statuses.value = map;
}

async function selectProject(projectId: string): Promise<void> { await router.push(projectPath(projectId)); }
useProjectDraft(() => !!newProjectName.value || !!newMemberName.value || !!newGroupName.value || newGroupSelection.value.length > 0,
  () => { newProjectName.value = ""; newMemberName.value = ""; newGroupName.value = ""; newGroupSelection.value = []; pendingProjectPurge.value = null; pendingGroupPurge.value = null; });

async function createProject(): Promise<void> {
  if (busy.value) return;
  const name = newProjectName.value.trim();
  if (name === "") {
    error.value = "项目名称不能为空。";
    return;
  }
  const result = await run(() => api.createProject(name), `项目「${name}」已创建。`);
  if (!result) return;
  newProjectName.value = ""; creation.value = null;
  await context.refreshProjects();
  await router.push(projectPath(result.project.id));
}

async function addMember(): Promise<void> {
  if (busy.value || projectReadonly.value) return;
  const projectId = activeProjectId.value;
  const name = newMemberName.value.trim();
  if (projectId === null) return;
  if (name === "") {
    error.value = "成员名称不能为空。";
    return;
  }
  const result = await run(() => api.addHumanMember(projectId, name), `成员「${name}」已添加。`);
  if (!result) return;
  newMemberName.value = "";
  await loadActiveProject();
}

function removeMember(member: MemberDto): void {
  if (busy.value || projectReadonly.value || confirmationAction.value) return;
  const projectId = activeProjectId.value;
  if (projectId === null) return;
  const memberId = member.id, generation = context.generation.value;
  const projectName = activeProject.value?.name ?? projectId;
  clearMessages(); confirmationKind.value = "normal";
  void confirmation.open({
    key: `member.remove:${projectId}:${memberId}`,
    title: `移除成员「${member.displayName}」？`, description: `此成员将离开项目「${projectName}」与群组，相关执行会失效；成员身份与历史记录保留。`,
    confirmLabel: "确认移除成员", successMessage: `成员「${member.displayName}」已移除。`,
    isCurrent: () => !disposed && projectId === activeProjectId.value && generation === context.generation.value,
    execute: () => api.removeMember(projectId, memberId),
    reconcile: async (isActive) => {
      await requireProjectScope(projectId);
      const latest = (await api.listMembers(projectId)).members.find(item => item.id === memberId);
      if (isActive() && latest && confirmationAction.value) {
        confirmationAction.value.title = `移除成员「${latest.displayName}」？`;
        confirmationAction.value.successMessage = `成员「${latest.displayName}」已移除。`;
      }
      return !latest;
    },
    afterSuccess: async () => { newGroupSelection.value = newGroupSelection.value.filter(id => id !== memberId); await loadActiveProject(); },
  });
}

async function requireProjectScope(projectId: string): Promise<void> {
  const result = await api.listProjects({ includeArchived: true });
  if (!result.projects.some(project => project.id === projectId)) throw new Error("原项目已不存在或当前作用域不可用，无法核对这次操作。");
}

function captureScope(projectId: string): () => boolean {
  const generation = context.generation.value;
  return () => !disposed && activeProjectId.value === projectId && context.generation.value === generation;
}

/** T3 #50：生命周期状态中文标签（与在线/离线、等待/工作等运行状态分开）。 */
function lifecycleLabel(member: MemberDto): string {
  switch (member.status) {
    case "active":
      return "在岗";
    case "disabled":
      return "已暂停";
    case "pending":
      return "待激活";
  }
}

/** T3 #50：暂停 / 恢复成员（无需逐次确认；可恢复、不物理删除）。 */
async function toggleMemberStatus(member: MemberDto): Promise<void> {
  if (busy.value || projectReadonly.value) return;
  const projectId = activeProjectId.value;
  if (projectId === null) return;
  const toActive = member.status !== "active";
  const result = await run(
    () => (toActive ? api.enableMember(projectId, member.id) : api.disableMember(projectId, member.id)),
    toActive
      ? `成员「${member.displayName}」已恢复在岗（岗位恢复）。`
      : `成员「${member.displayName}」已暂停（可恢复，历史与数据保留）。`,
  );
  if (!result) return;
  await loadActiveProject();
}

async function assignManager(member: MemberDto): Promise<void> {
  if (busy.value || projectReadonly.value) return;
  const projectId = activeProjectId.value;
  if (projectId === null) return;
  const result = await run(
    () => api.setManager(projectId, member.id),
    `已将「${member.displayName}」指定为顶层 manager。`,
  );
  if (!result) return;
  await loadProjects();
}

function toggleGroupSelection(memberId: string): void {
  const index = newGroupSelection.value.indexOf(memberId);
  if (index >= 0) newGroupSelection.value.splice(index, 1);
  else newGroupSelection.value.push(memberId);
}

async function createGroup(): Promise<void> {
  if (busy.value || projectReadonly.value) return;
  const projectId = activeProjectId.value;
  const name = newGroupName.value.trim();
  if (projectId === null) return;
  if (name === "") {
    error.value = "群组名称不能为空。";
    return;
  }
  const result = await run(
    () => api.createGroup(projectId, name, [...newGroupSelection.value]),
    `群组「${name}」已创建。`,
  );
  if (!result) return;
  newGroupName.value = "";
  newGroupSelection.value = []; creation.value = null;
  await loadActiveProject();
  await context.refreshProjects();
}

// ---------------------------------------------------------------------------
// T1 #48：归档 / 恢复 / 永久删除（二次确认）
// ---------------------------------------------------------------------------

async function archiveProject(): Promise<void> {
  if (busy.value || confirmationAction.value) return;
  const projectId = activeProjectId.value;
  if (projectId === null) return;
  const name = activeProject.value?.name ?? projectId;
  clearMessages(); confirmationKind.value = "normal";
  await confirmation.open({ key: `project.archive:${projectId}`, title: `归档项目「${name}」？`, description: "归档后项目保留历史，但不能继续新增或修改内容。可从归档列表恢复。",
    confirmLabel: "确认归档项目", successMessage: `项目「${name}」已归档，可在归档列表恢复。`, isCurrent: captureScope(projectId),
    execute: async () => { await api.archiveProject(projectId); },
    reconcile: async () => { const latest = (await api.listProjects({ includeArchived: true })).projects.find(item => item.id === projectId);
      if (!latest) throw new Error("原项目已不存在或当前作用域不可用，无法核对归档结果。"); return latest.archivedAt !== null; },
    afterSuccess: loadProjects,
  });
}

async function restoreProject(): Promise<void> {
  if (busy.value) return;
  const projectId = activeProjectId.value;
  if (projectId === null) return;
  const result = await run(() => api.restoreProject(projectId), `项目「${activeProject.value?.name ?? projectId}」已恢复。`);
  if (!result) return;
  await loadProjects();
}

/** 第一刀：只取级联清单与确认凭据，不删除；清单显示在确认面板里等人点「确认永久删除」。 */
async function requestProjectPurge(): Promise<void> {
  if (busy.value || confirmationAction.value) return;
  const projectId = activeProjectId.value;
  if (projectId === null) return;
  const name = activeProject.value?.name ?? projectId;
  clearMessages(); confirmationKind.value = "project-purge"; pendingProjectPurge.value = null; pendingGroupPurge.value = null;
  await confirmation.open({ key: `project.purge:${projectId}`, title: `永久删除项目「${name}」？`, description: "此操作不可恢复。请核对服务端返回的影响范围后再确认。",
    confirmLabel: "确认永久删除", successMessage: `项目「${name}」已永久删除。`, isCurrent: captureScope(projectId),
    prepare: async (isActive) => {
      const outcome = await api.purgeProject(projectId);
      if (!isActive()) return;
      if (outcome.state !== "confirmation_required" || outcome.confirmation.projectId !== projectId) throw new Error("无法获取此项目的有效预览，请重新读取。");
      pendingProjectPurge.value = outcome.confirmation;
      confirmationAction.value!.title = `永久删除项目「${outcome.confirmation.projectName}」？`;
      confirmationAction.value!.successMessage = `项目「${outcome.confirmation.projectName}」已永久删除。`;
    },
    execute: async () => {
      const preview = pendingProjectPurge.value;
      if (!preview || preview.projectId !== projectId) throw new ApiError(400, "invalid_confirmation", "请重新读取删除影响范围。");
      const outcome = await api.purgeProject(projectId, preview.token);
      if (outcome.state !== "deleted") throw new ApiError(409, "confirmation_changed", "删除范围已变化，请重新预览并再次确认。");
    },
    // includeArchived=true 返回完整全局项目列表；读取失败/403 会抛出，不能推断为不存在。
    reconcile: async () => !(await api.listProjects({ includeArchived: true })).projects.some(item => item.id === projectId),
    afterSuccess: loadProjects,
  });
}

async function archiveGroup(group: GroupDto): Promise<void> {
  if (busy.value || projectReadonly.value || confirmationAction.value) return;
  const projectId = group.projectId, groupId = group.id, name = group.name;
  clearMessages(); confirmationKind.value = "normal";
  await confirmation.open({ key: `group.archive:${projectId}:${groupId}`, title: `归档群组「${name}」？`, description: `归档后项目「${activeProject.value?.name ?? projectId}」中的该群历史保留，群组不能继续新增内容。可通过恢复群组继续协作。`,
    confirmLabel: "确认归档群组", successMessage: `群组「${name}」已归档，可恢复。`, isCurrent: captureScope(projectId),
    execute: async () => { await api.archiveGroup(groupId); },
    reconcile: async () => { await requireProjectScope(projectId); const latest = (await api.listGroups(projectId, { includeArchived: true })).groups.find(item => item.id === groupId);
      if (!latest) throw new Error("原群组已不存在，无法确认归档结果，请刷新项目查看。"); return latest.archivedAt !== null; },
    afterSuccess: loadProjects,
  });
}

async function restoreGroup(group: GroupDto): Promise<void> {
  if (busy.value || projectReadonly.value) return;
  const result = await run(() => api.restoreGroup(group.id), `群组「${group.name}」已恢复。`);
  if (!result) return;
  await loadProjects();
}

async function requestGroupPurge(group: GroupDto): Promise<void> {
  if (busy.value || projectReadonly.value || confirmationAction.value) return;
  const projectId = group.projectId, groupId = group.id, name = group.name;
  clearMessages(); confirmationKind.value = "group-purge"; pendingProjectPurge.value = null; pendingGroupPurge.value = null;
  await confirmation.open({ key: `group.purge:${projectId}:${groupId}`, title: `永久删除群组「${name}」？`, description: `此操作不可恢复，将清除群聊与参与者关系；项目「${activeProject.value?.name ?? projectId}」的成员仍会保留。`,
    confirmLabel: "确认永久删除", successMessage: `群组「${name}」已永久删除。`, isCurrent: captureScope(projectId),
    prepare: async (isActive) => {
      const outcome = await api.purgeGroup(groupId);
      if (!isActive()) return;
      if (outcome.state !== "confirmation_required" || outcome.confirmation.groupId !== groupId || outcome.confirmation.projectId !== projectId) throw new Error("无法获取此群组的有效预览，请重新读取。");
      pendingGroupPurge.value = outcome.confirmation;
      confirmationAction.value!.title = `永久删除群组「${outcome.confirmation.groupName}」？`;
      confirmationAction.value!.successMessage = `群组「${outcome.confirmation.groupName}」已永久删除；项目成员保留。`;
    },
    execute: async () => {
      const preview = pendingGroupPurge.value;
      if (!preview || preview.groupId !== groupId) throw new ApiError(400, "invalid_confirmation", "请重新读取删除影响范围。");
      const outcome = await api.purgeGroup(groupId, preview.token);
      if (outcome.state !== "deleted") throw new ApiError(409, "confirmation_changed", "删除范围已变化，请重新预览并再次确认。");
    },
    reconcile: async () => { await requireProjectScope(projectId); return !(await api.listGroups(projectId, { includeArchived: true })).groups.some(item => item.id === groupId); },
    afterSuccess: loadProjects,
  });
}

/** 连接状态的中文标签（全局 MCP 会话层，D1）。 */
function connectionLabel(memberId: string): string {
  const status = statuses.value[memberId];
  if (!status) return "未知";
  switch (status.connection) {
    case "connected":
      return "已连接";
    case "disconnected":
      return "已断开";
    default:
      return "未连接";
  }
}

/** 运行状态的中文标签（项目成员层，waiting/working 只看显式上报）。 */
function stateLabel(memberId: string): string {
  const status = statuses.value[memberId];
  if (!status || status.state === null) return "—";
  switch (status.state) {
    case "online":
      return "在线";
    case "offline":
      return "离线";
    case "waiting":
      return "等待中";
    case "working":
      return "工作中";
  }
}

/** 陈旧/断线提示（T4）。完整看板见「状态看板」页。 */
function staleLabel(memberId: string): string | null {
  const status = statuses.value[memberId];
  if (!status) return null;
  if (status.disconnected) return "断线";
  if (status.heartbeatTimedOut) return "心跳超时";
  if (status.stale) return "陈旧";
  return null;
}

function isOnline(memberId: string): boolean {
  const status = statuses.value[memberId];
  return status?.connection === "connected" && status?.state !== "offline";
}

function participantNames(groupId: string): string {
  return (participants.value[groupId] ?? []).map((m) => m.displayName).join("、") || "（暂无参与者）";
}

function openCreation(kind: "project" | "group"): void { if (!busy.value && !confirmationAction.value) { clearMessages(); creation.value = kind; } }
function closeCreation(): void {
  if (busy.value) return;
  creation.value = null; newProjectName.value = ""; newGroupName.value = ""; newGroupSelection.value = []; clearMessages();
  if (route.query["create"] === "project") void router.replace({ path: route.path, query: { ...route.query, create: undefined }, hash: route.hash });
}
watch(() => route.query["create"], value => { if (value === "project" && viewMode.value === "list") creation.value = "project"; }, { immediate: true });
watch(viewMode, () => { creation.value = null; void loadActiveProject(); });
watch(() => route.query["archived"], value => { showArchived.value = value === "1"; void loadActiveProject(); });
watch(() => context.generation.value, () => { confirmation.reset(); creation.value = null; });
watch(activeProjectId, () => { projectRequest++; members.value = []; groups.value = []; participants.value = {}; statuses.value = {}; loading.value = false; void loadActiveProject(); }, { immediate: true });
onBeforeUnmount(() => { disposed = true; projectRequest++; });
</script>

<template>
  <section class="page projects-page">
    <ConfirmDialog :open="!!confirmationAction" :title="confirmationAction?.title ?? ''" :description="confirmationAction?.description ?? ''" :confirm-label="confirmationAction?.confirmLabel ?? '确认'" :cancel-label="confirmationPhase === 'unknown' ? '关闭' : '取消'" :pending="confirmationPending" :disabled="!canConfirm" :error="confirmationError" :confirm-test-id="confirmationKind === 'project-purge' ? 'confirm-purge-project' : confirmationKind === 'group-purge' ? 'confirm-purge-group' : 'confirm-submit'" :cancel-test-id="confirmationKind === 'project-purge' ? 'cancel-purge-project' : confirmationKind === 'group-purge' ? 'cancel-purge-group' : 'confirm-cancel'" @cancel="confirmation.cancel" @confirm="confirmation.confirm">
      <p v-if="confirmationPhase === 'preparing'" class="muted" role="status">正在读取影响范围…</p>
      <PurgeImpact v-if="confirmationKind === 'project-purge' && pendingProjectPurge" :confirmation="pendingProjectPurge" />
      <PurgeImpact v-if="confirmationKind === 'group-purge' && pendingGroupPurge" :confirmation="pendingGroupPurge" />
      <template #recovery>
        <button v-if="confirmationPhase === 'unknown'" type="button" data-testid="confirmation-reconcile" @click="confirmation.reconcile">核对操作结果</button>
        <button v-if="confirmationPhase === 'refresh-required'" type="button" data-testid="confirmation-preview" @click="confirmation.retryPreview">重新读取影响范围</button>
      </template>
    </ConfirmDialog>
    <CreationDialog :open="creation !== null" :title="creation === 'project' ? '新建项目' : '创建群组'" :pending="busy" :dirty="creation === 'project' ? !!newProjectName : !!newGroupName || newGroupSelection.length > 0" :error="error" :confirm-label="creation === 'project' ? '创建项目' : '创建群组'" :confirm-test-id="creation === 'project' ? 'create-project' : 'create-group'" @confirm="creation === 'project' ? createProject() : createGroup()" @close="closeCreation">
      <template v-if="creation === 'project'"><label class="field" for="new-project-name">项目名称<input id="new-project-name" v-model="newProjectName" :disabled="busy" required placeholder="例如：产品研发" data-testid="new-project-name" /></label><p class="muted small">创建后可添加成员、建立群组，配置项目协作。</p></template>
      <template v-else><label class="field" for="new-group-name">群组名称<input id="new-group-name" v-model="newGroupName" :disabled="busy || projectReadonly" required placeholder="例如：设计讨论" data-testid="new-group-name" /></label><fieldset class="participants-picker" :disabled="busy || projectReadonly" data-testid="participant-picker"><legend>参与者</legend><p v-if="members.length === 0" class="muted small">暂无可选择的成员，可先建立群组。</p><label v-for="member in members" :key="member.id" class="participant-option"><input type="checkbox" :checked="newGroupSelection.includes(member.id)" @change="toggleGroupSelection(member.id)" />{{ member.displayName }}</label></fieldset><p class="muted small">已选 {{ newGroupSelection.length }} 位参与者。创建群组不会自动启动 Agent。</p></template>
    </CreationDialog>
    <header class="page-header"><div><h1>{{ pageTitle }}</h1><p class="page-description">{{ viewMode === 'list' ? '每个项目都有独立的成员、群组和工作记录。' : viewMode === 'settings' ? '管理当前项目的配置与生命周期。' : '把成员和对话放在同一个项目中，让协作井然有序。' }}</p></div><button v-if="viewMode === 'list'" type="button" class="primary" :disabled="busy" data-testid="open-create-project" @click="openCreation('project')">新建项目</button><button v-else-if="viewMode === 'groups'" type="button" class="primary" :disabled="busy || projectReadonly" data-testid="open-create-group" @click="openCreation('group')">创建群组</button></header>

    <p v-if="error && !creation" class="error" role="alert" data-testid="error">{{ error }}</p>

    <section v-if="viewMode === 'list'" class="panel project-picker" aria-labelledby="project-picker-title" :aria-busy="loading">
      <div class="section-heading">
        <h2 id="project-picker-title">我的项目 <span class="count">{{ projects.length }}</span></h2>
        <button type="button" class="text-button" :disabled="busy" :aria-pressed="showArchived" data-testid="toggle-archived" @click="toggleShowArchived">
          {{ showArchived ? "隐藏已归档" : "显示已归档" }}
        </button>
      </div>
      <label class="field project-search">筛选项目<input v-model="projectSearch" type="search" placeholder="按项目名称查找" data-testid="project-search" /></label>
      <div v-if="projects.length > 0" class="project-tabs" role="group" aria-label="浏览项目" data-testid="project-list">
        <button v-for="project in projects" :key="project.id" type="button" class="project-tab" :class="{ active: project.id === activeProjectId }" :aria-pressed="project.id === activeProjectId" :disabled="busy" @click="selectProject(project.id)">
          {{ project.name }}<span v-if="project.archivedAt" class="muted small"> · 已归档</span>
        </button>
      </div>
      <p v-if="loading && projects.length === 0" class="muted small" role="status">正在加载项目…</p>

    </section>

    <template v-if="activeProject && viewMode !== 'list'">
      <section v-if="viewMode === 'overview' || viewMode === 'settings'" class="panel project-summary" aria-labelledby="active-project-title" data-testid="project-detail">
        <div class="section-heading">
          <div>
            <h2 id="active-project-title">{{ activeProject.name }} <span v-if="activeProject.archivedAt" class="badge" data-testid="project-archived-badge">已归档</span></h2>
            <p class="muted small" data-testid="manager-line">顶层 manager：<strong v-if="manager" data-testid="manager-name">{{ manager.displayName }}</strong><span v-else>未指定</span></p>
          </div>
          <RouterLink :to="{ path: '/runtimes', query: { projectId: activeProject.id } }">管理托管 Agent <span aria-hidden="true">↗</span></RouterLink>
        </div>
        <p v-if="activeProject.archivedAt" class="muted small">项目已归档。恢复项目后，可以继续添加成员与群组。</p>
        <details class="project-management" data-testid="project-actions" :open="viewMode === 'settings'">
          <summary>项目管理</summary>
          <p class="muted small project-id">项目 ID：<code>{{ activeProject.id }}</code></p>
          <div class="actions" data-testid="project-lifecycle">
            <button v-if="!activeProject.archivedAt" type="button" class="secondary" :disabled="busy" data-testid="archive-project" @click="archiveProject">归档项目</button>
            <button v-else type="button" class="secondary" :disabled="busy" data-testid="restore-project" @click="restoreProject">恢复项目</button>
            <button type="button" :disabled="busy" class="text-button danger" data-testid="purge-project" @click="requestProjectPurge">永久删除项目</button>
          </div>
          <p class="muted small">归档可恢复；永久删除会清除项目数据，并需要再次确认。</p>

        </details>
      </section>

      <p v-if="loadingProject" class="muted small" role="status">正在更新项目内容…</p>
      <div v-if="viewMode === 'settings'" class="panel"><h2>协作配置</h2><p class="muted small">当前项目的任务默认评审者在任务页维护，成员与岗位在成员页维护。</p><div class="actions"><RouterLink :to="projectPath(activeProject.id, 'tasks')">任务与默认评审者</RouterLink><RouterLink :to="projectPath(activeProject.id, 'members')">成员与岗位</RouterLink></div></div>
      <div v-if="viewMode !== 'settings'" class="project-columns" :class="{ 'single-column': viewMode !== 'overview' }" :aria-busy="loadingProject">
        <section v-if="viewMode === 'members' || viewMode === 'overview'" class="panel members-panel" aria-labelledby="members-title">
          <div class="section-heading"><h2 id="members-title">成员 <span class="count">{{ members.length }}</span></h2></div>
          <p class="muted small section-description">添加人类成员，Agent 可通过 CLI 接入项目。</p>
          <details class="member-create-context" data-testid="member-create-context" :open="memberCreateOpen" @toggle="memberCreateOpen = ($event.target as HTMLDetailsElement).open"><summary data-testid="open-add-member">添加人类成员</summary>
          <form class="inline-create" @submit.prevent="addMember">
            <label class="field" for="new-member-name">成员显示名<input id="new-member-name" v-model="newMemberName" :disabled="busy || !!activeProject.archivedAt" required placeholder="填写成员名称" data-testid="new-member-name" /></label>
            <button type="submit" class="secondary" :disabled="busy || !!activeProject.archivedAt" data-testid="add-member">添加成员</button>
          </form>
          </details>
          <div v-if="members.length === 0 && !loadingProject" class="empty-state compact-empty"><p>暂无成员。添加第一位成员，开始协作。</p></div>
          <ul v-else class="member-list" data-testid="member-list">
            <li v-for="member in members" :key="member.id" class="member-item">
              <div class="member-info">
                <span class="member-avatar" aria-hidden="true">{{ member.displayName.slice(0, 1) }}</span>
                <div class="member-copy">
                  <div class="member-title"><strong>{{ member.displayName }}</strong><span class="badge">{{ member.kind === "human" ? "人" : "agent" }}</span><span v-if="member.role === 'manager'" class="badge manager">manager</span></div>
                  <div class="member-meta">
                    <span class="dot" :class="isOnline(member.id) ? 'online' : 'offline'" :aria-label="isOnline(member.id) ? '已连接' : '未在线'" data-testid="online-dot"></span>
                    <span class="badge lifecycle" :class="`lifecycle-${member.status}`" data-testid="member-lifecycle-status">{{ lifecycleLabel(member) }}</span>
                    <span v-if="member.kind === 'agent'" class="small muted" data-testid="member-state">{{ connectionLabel(member.id) }} / {{ stateLabel(member.id) }}</span>
                  </div>
                </div>
              </div>
              <details class="member-manage" data-testid="member-management">
                <summary>管理成员</summary>
                <p v-if="member.kind === 'agent'" class="muted small">移除后，Agent 的项目记忆保留，自总结请求随成员关系清理。保留的文档可在记忆页维护。</p>
                <div class="actions member-actions">
                  <button type="button" class="secondary" :disabled="busy || member.role === 'manager' || !!activeProject.archivedAt" @click="assignManager(member)">设为 manager</button>
                  <button type="button" class="secondary" :disabled="busy || !!activeProject.archivedAt" data-testid="toggle-member-status" @click="toggleMemberStatus(member)">{{ member.status === "active" ? "暂停成员" : "恢复成员" }}</button>
                  <button type="button" class="text-button danger" :disabled="busy || !!activeProject.archivedAt" @click="removeMember(member)">移除</button>
                </div>
              </details>
            </li>
          </ul>

          <details class="status-disclosure" data-testid="member-status-details">
            <summary>成员在线状态</summary>
            <div class="status-description"><p class="muted small">连接与在线状态独立于成员是否在岗。暂停会保留历史、数据与岗位，可随时恢复。</p><button type="button" class="text-button" :disabled="busy" data-testid="refresh-status" @click="clearMessages(); loadStatuses()">刷新状态</button></div>
            <p v-if="members.length === 0" class="muted small">暂无成员。</p>
            <ul v-else class="status-list" data-testid="status-list">
              <li v-for="member in members" :key="member.id"><span>{{ member.displayName }}</span><span class="small muted" data-testid="status-detail">{{ connectionLabel(member.id) }} · {{ stateLabel(member.id) }}<template v-if="staleLabel(member.id)"> · <span class="bad">{{ staleLabel(member.id) }}</span></template></span></li>
            </ul>
          </details>
        </section>

        <section v-if="viewMode === 'groups' || viewMode === 'overview'" class="panel groups-panel" aria-labelledby="groups-title">
          <div class="section-heading"><h2 id="groups-title">群组 <span class="count">{{ groups.length }}</span></h2><button type="button" class="text-button" :disabled="busy" :aria-pressed="showArchived" data-testid="toggle-archived" @click="toggleShowArchived">{{ showArchived ? "隐藏已归档" : "显示已归档" }}</button></div>
          <p class="muted small section-description">按协作主题建群，为每个群组选择参与者。</p>
          <button v-if="viewMode === 'overview'" type="button" class="text-button" :disabled="busy || projectReadonly" data-testid="open-create-group" @click="openCreation('group')">创建群组</button>
          <div v-if="groups.length === 0 && !loadingProject" class="empty-state compact-empty"><p>暂无群组。创建一个群组，把相关讨论放在一起。</p></div>
          <ul v-else class="group-list" data-testid="group-list">
            <li v-for="group in groups" :key="group.id" class="group-item">
              <div class="group-heading"><strong>{{ group.name }}</strong><span v-if="group.archivedAt" class="badge" data-testid="group-archived-badge">已归档</span><span v-if="group.writable === false && !(participants[group.id] ?? []).some(m => m.kind === 'human' && m.status === 'active')" class="badge" data-testid="group-readonly-badge">只读可见</span></div>
              <p class="small muted group-participants">参与者：{{ participantNames(group.id) }}</p>
              <div class="actions group-links"><RouterLink :to="projectPath(group.projectId, 'chat', group.id)">进入群聊 <span aria-hidden="true">↗</span></RouterLink><RouterLink :to="{ path: '/runtimes', query: { projectId: group.projectId, groupId: group.id } }">托管 Agent</RouterLink></div>
              <details class="group-management" data-testid="group-management">
                <summary>群组管理</summary>
                <div class="actions" data-testid="group-lifecycle">
                  <button v-if="!group.archivedAt" type="button" class="secondary" :disabled="busy || projectReadonly" data-testid="archive-group" @click="archiveGroup(group)">归档群组</button>
                  <button v-else type="button" class="secondary" :disabled="busy || projectReadonly" data-testid="restore-group" @click="restoreGroup(group)">恢复群组</button>
                  <button type="button" class="text-button danger" :disabled="busy || projectReadonly" data-testid="purge-group" @click="requestGroupPurge(group)">永久删除群组</button>
                </div>
              </details>
            </li>
          </ul>


        </section>
      </div>
    </template>
    <div v-if="viewMode === 'list' && !loading && !error && !projects.length" class="empty-state"><h2>{{ projectSearch ? '没有匹配的项目' : '从一个项目开始' }}</h2><p>新建项目后，就可以添加成员、建立群组。</p></div>
  </section>
</template>

<style scoped>
.projects-page > .panel, .project-columns { margin-top: 1.25rem; }
.section-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .75rem 1rem; }
.section-heading h2 { margin: 0; font-size: 1.05rem; overflow-wrap: anywhere; }
.section-heading p { margin: .35rem 0 0; }
.section-heading > div { min-width: 0; }
.count { color: var(--muted); font-size: .85rem; font-weight: 400; margin-left: .35rem; }
.project-tabs { display: grid; gap: 0; margin-top: 1rem; }.project-search { max-width: 25rem; margin-top: 20px; }.project-tab { justify-content: flex-start; border: 0; border-radius: 0; padding: 18px 8px; border-bottom: 1px solid var(--border); min-height: 58px; }.project-columns.single-column { grid-template-columns: minmax(0, 1fr); }.member-create-context { margin-top: 16px; padding: 12px 16px; border: 1px solid var(--border); border-radius: 9px; }.member-create-context summary { color: var(--accent); }
.project-tab { max-width: 100%; text-align: left; overflow-wrap: anywhere; background: var(--surface-subtle); }
.project-tab.active { color: var(--accent); background: var(--accent-soft); border-color: var(--accent); }
.project-create, .inline-create { display: flex; align-items: end; flex-wrap: wrap; gap: .75rem; margin-top: 1.25rem; }
.project-create .field { flex: 1; max-width: 25rem; min-width: min(100%, 15rem); }
.inline-create .field { flex: 1; min-width: min(100%, 10rem); }
.project-columns { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 1.25rem; align-items: start; }
.project-columns > .panel { min-width: 0; }
.project-management { border-top: 1px solid var(--border); padding-top: .9rem; margin-top: 1rem; }
.project-id { overflow-wrap: anywhere; }
summary { cursor: pointer; font-size: .85rem; color: var(--muted); min-height: 2rem; align-content: center; }
summary::marker { color: var(--muted); }
.section-description { margin: .5rem 0 0; }
.member-list, .group-list, .status-list { list-style: none; padding: 0; margin: 1rem 0 0; }
.member-item, .group-item { padding: 1rem 0; border-top: 1px solid var(--border); min-width: 0; }
.member-item:first-child, .group-item:first-child { border-top: 0; }
.member-info { display: flex; align-items: start; gap: .75rem; }
.member-avatar { flex: 0 0 2rem; height: 2rem; display: grid; place-items: center; border-radius: 50%; background: var(--surface-subtle); color: var(--muted); font-size: .85rem; }
.member-copy { min-width: 0; flex: 1; }
.member-title, .member-meta, .group-heading { display: flex; align-items: center; flex-wrap: wrap; gap: .35rem; overflow-wrap: anywhere; }
.member-meta { margin-top: .35rem; }
.member-title strong, .group-heading strong { min-width: 0; overflow-wrap: anywhere; }
.member-meta .badge { font-size: .75rem; }
.manager { color: var(--accent); background: var(--accent-soft); }
.lifecycle-disabled { color: var(--bad); }
.lifecycle-pending { color: var(--warn); }
.member-manage { margin: .5rem 0 0 2.75rem; }
.member-actions { margin-top: .5rem; }
.dot { width: .4rem; height: .4rem; border-radius: 50%; background: var(--muted); flex: 0 0 auto; }
.dot.online { background: var(--ok); }
.status-disclosure { margin-top: .5rem; padding-top: 1rem; border-top: 1px solid var(--border); }
.status-description p { margin: .5rem 0; }
.status-list li { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .35rem .75rem; padding: .65rem 0; border-top: 1px solid var(--border); overflow-wrap: anywhere; }
.create-section { margin-top: 1rem; padding: .75rem 1rem; background: var(--surface-subtle); border-radius: 10px; }
.create-section summary { color: var(--fg); font-weight: 500; }
.group-create { display: grid; gap: .85rem; padding-top: .75rem; }
.participants-picker { display: flex; flex-wrap: wrap; gap: .5rem .85rem; min-width: 0; padding: .65rem 0 0; margin: 0; border: 0; }
.participants-picker legend { padding: 0; font-size: .85rem; }
.participants-picker p { margin: 0; }
.participant-option { display: inline-flex; align-items: center; gap: .35rem; font-size: .85rem; min-height: 2rem; overflow-wrap: anywhere; }
.participant-option input { flex: 0 0 auto; }
.group-participants { margin: .5rem 0 .75rem; overflow-wrap: anywhere; }
.group-links { font-size: .85rem; gap: 1rem; }
.group-management { margin-top: .65rem; }
.group-management .actions { margin-top: .5rem; }
.compact-empty { padding: 1.25rem .5rem; }
@media (max-width: 1100px) { .project-columns { grid-template-columns: 1fr; } }
@media (max-width: 620px) { .project-create .field { max-width: none; width: 100%; flex-basis: 100%; } .project-tabs { gap: .4rem; } .member-manage { margin-left: 0; } }
</style>
