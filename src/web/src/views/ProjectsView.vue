<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  ApiError,
  api,
  type GroupDto,
  type GroupPurgeConfirmation,
  type MemberDto,
  type MemberStatusDto,
  type ProjectDto,
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

const projects = ref<ProjectDto[]>([]);
const activeProjectId = ref<string | null>(null);
const members = ref<MemberDto[]>([]);
const groups = ref<GroupDto[]>([]);
/** 群组 id → 参与者列表。 */
const participants = ref<Record<string, MemberDto[]>>({});
/** 项目成员在线/连接状态（T2）：memberId → 状态视图。 */
const statuses = ref<Record<string, MemberStatusDto>>({});
/** 「显示已归档」开关：项目与群组列表一起受影响。 */
const showArchived = ref(false);
/** 等待人二次确认的永久删除（#48）。 */
const pendingProjectPurge = ref<ProjectPurgeConfirmation | null>(null);
const pendingGroupPurge = ref<GroupPurgeConfirmation | null>(null);

const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const newProjectName = ref("");
const newMemberName = ref("");
const newGroupName = ref("");
/** 新群组默认选中的成员 id。 */
const newGroupSelection = ref<string[]>([]);

const activeProject = computed(() => projects.value.find((p) => p.id === activeProjectId.value) ?? null);
const manager = computed<MemberDto | null>(() => activeProject.value?.manager ?? null);

function clearMessages(): void {
  error.value = null;
  notice.value = null;
}

async function run<T>(fn: () => Promise<T>, success?: string): Promise<T | null> {
  clearMessages();
  busy.value = true;
  try {
    const result = await fn();
    if (success !== undefined) notice.value = success;
    return result;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : (err as Error).message;
    return null;
  } finally {
    busy.value = false;
  }
}

async function loadProjects(): Promise<void> {
  const result = await run(() => api.listProjects({ includeArchived: showArchived.value }));
  if (!result) return;
  projects.value = result.projects;
  if (activeProjectId.value === null || !projects.value.some((p) => p.id === activeProjectId.value)) {
    activeProjectId.value = projects.value[0]?.id ?? null;
  }
  await loadActiveProject();
}

async function toggleShowArchived(): Promise<void> {
  showArchived.value = !showArchived.value;
  await loadProjects();
}

async function loadActiveProject(): Promise<void> {
  const projectId = activeProjectId.value;
  if (projectId === null) {
    members.value = [];
    groups.value = [];
    participants.value = {};
    statuses.value = {};
    return;
  }
  const [memberResult, groupResult] = await Promise.all([
    run(() => api.listMembers(projectId)),
    run(() => api.listGroups(projectId, { includeArchived: showArchived.value })),
  ]);
  if (memberResult) members.value = memberResult.members;
  if (groupResult) {
    groups.value = groupResult.groups;
    await loadParticipants();
  }
  await loadStatuses();
}

async function loadParticipants(): Promise<void> {
  const map: Record<string, MemberDto[]> = {};
  await Promise.all(
    groups.value.map(async (group) => {
      const result = await run(() => api.listParticipants(group.id));
      map[group.id] = result?.participants ?? [];
    }),
  );
  participants.value = map;
}

async function loadStatuses(): Promise<void> {
  const projectId = activeProjectId.value;
  if (projectId === null) {
    statuses.value = {};
    return;
  }
  const result = await run(() => api.listMemberStatuses(projectId));
  if (!result) return;
  const map: Record<string, MemberStatusDto> = {};
  for (const status of result.memberStatuses) map[status.memberId] = status;
  statuses.value = map;
}

async function selectProject(projectId: string): Promise<void> {
  if (activeProjectId.value === projectId) return;
  activeProjectId.value = projectId;
  newGroupSelection.value = [];
  await loadActiveProject();
}

async function createProject(): Promise<void> {
  const name = newProjectName.value.trim();
  if (name === "") {
    error.value = "项目名称不能为空。";
    return;
  }
  const result = await run(() => api.createProject(name), "项目已创建。");
  if (!result) return;
  newProjectName.value = "";
  activeProjectId.value = result.project.id;
  await loadProjects();
}

async function addMember(): Promise<void> {
  const projectId = activeProjectId.value;
  const name = newMemberName.value.trim();
  if (projectId === null) return;
  if (name === "") {
    error.value = "成员名称不能为空。";
    return;
  }
  const result = await run(() => api.addHumanMember(projectId, name), "成员已添加。");
  if (!result) return;
  newMemberName.value = "";
  await loadActiveProject();
}

async function removeMember(member: MemberDto): Promise<void> {
  const projectId = activeProjectId.value;
  if (projectId === null) return;
  const result = await run(
    () => api.removeMember(projectId, member.id),
    `成员「${member.displayName}」已移除。`,
  );
  if (result === null && error.value === null) return;
  newGroupSelection.value = newGroupSelection.value.filter((id) => id !== member.id);
  await loadActiveProject();
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
  const projectId = activeProjectId.value;
  const name = newGroupName.value.trim();
  if (projectId === null) return;
  if (name === "") {
    error.value = "群组名称不能为空。";
    return;
  }
  const result = await run(
    () => api.createGroup(projectId, name, [...newGroupSelection.value]),
    "群组已创建。",
  );
  if (!result) return;
  newGroupName.value = "";
  newGroupSelection.value = [];
  await loadActiveProject();
}

// ---------------------------------------------------------------------------
// T1 #48：归档 / 恢复 / 永久删除（二次确认）
// ---------------------------------------------------------------------------

async function archiveProject(): Promise<void> {
  const projectId = activeProjectId.value;
  if (projectId === null) return;
  const result = await run(() => api.archiveProject(projectId), "项目已归档（可恢复）。");
  if (!result) return;
  await loadProjects();
}

async function restoreProject(): Promise<void> {
  const projectId = activeProjectId.value;
  if (projectId === null) return;
  const result = await run(() => api.restoreProject(projectId), "项目已恢复。");
  if (!result) return;
  await loadProjects();
}

/** 第一刀：只取级联清单与确认凭据，不删除；清单显示在确认面板里等人点「确认永久删除」。 */
async function requestProjectPurge(): Promise<void> {
  const projectId = activeProjectId.value;
  if (projectId === null) return;
  const outcome = await run(() => api.purgeProject(projectId));
  if (!outcome) return;
  if (outcome.state === "confirmation_required") pendingProjectPurge.value = outcome.confirmation;
  else pendingProjectPurge.value = null;
}

async function confirmProjectPurge(): Promise<void> {
  const confirmation = pendingProjectPurge.value;
  if (confirmation === null) return;
  const outcome = await run(() => api.purgeProject(confirmation.projectId, confirmation.token));
  if (!outcome) return;
  pendingProjectPurge.value = null;
  if (outcome.state === "deleted") {
    activeProjectId.value = null;
    await loadProjects();
  }
}

function cancelProjectPurge(): void {
  pendingProjectPurge.value = null;
  notice.value = "已取消永久删除（确认凭据过期后需重新发起）。";
}

async function archiveGroup(group: GroupDto): Promise<void> {
  const result = await run(() => api.archiveGroup(group.id), `群组「${group.name}」已归档（可恢复）。`);
  if (!result) return;
  await loadActiveProject();
}

async function restoreGroup(group: GroupDto): Promise<void> {
  const result = await run(() => api.restoreGroup(group.id), `群组「${group.name}」已恢复。`);
  if (!result) return;
  await loadActiveProject();
}

async function requestGroupPurge(group: GroupDto): Promise<void> {
  const outcome = await run(() => api.purgeGroup(group.id));
  if (!outcome) return;
  if (outcome.state === "confirmation_required") pendingGroupPurge.value = outcome.confirmation;
  else pendingGroupPurge.value = null;
}

async function confirmGroupPurge(): Promise<void> {
  const confirmation = pendingGroupPurge.value;
  if (confirmation === null) return;
  const outcome = await run(() => api.purgeGroup(confirmation.groupId, confirmation.token));
  if (!outcome) return;
  pendingGroupPurge.value = null;
  await loadActiveProject();
}

function cancelGroupPurge(): void {
  pendingGroupPurge.value = null;
  notice.value = "已取消永久删除群组。";
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

onMounted(() => void loadProjects());
</script>

<template>
  <section class="card">
    <h1>项目</h1>
    <p class="muted">
      创建一个项目，在项目内添加成员、指定一个顶层 manager，并创建带参与者的群组。
      项目之间数据隔离；归档可恢复，永久删除需要你二次确认。
      真实 agent 成员由 MCP 入群（后续），本页管理已存在的成员。
    </p>

    <p v-if="error" class="error" data-testid="error">{{ error }}</p>
    <p v-if="notice" class="notice" data-testid="notice">{{ notice }}</p>

    <!-- 新建项目 -->
    <form class="row" @submit.prevent="createProject">
      <input v-model="newProjectName" placeholder="新项目名称" data-testid="new-project-name" />
      <button type="submit" :disabled="busy" data-testid="create-project">创建项目</button>
      <button
        type="button"
        :disabled="busy"
        class="chip"
        data-testid="toggle-archived"
        @click="toggleShowArchived"
      >
        {{ showArchived ? "隐藏已归档" : "显示已归档" }}
      </button>
    </form>

    <!-- 项目切换 -->
    <div v-if="projects.length > 0" class="tabs" data-testid="project-list">
      <button
        v-for="project in projects"
        :key="project.id"
        type="button"
        class="tab"
        :class="{ active: project.id === activeProjectId }"
        @click="selectProject(project.id)"
      >
        {{ project.name }}<template v-if="project.archivedAt">（已归档）</template>
      </button>
    </div>

    <template v-if="activeProject">
      <div class="panel" data-testid="project-detail">
        <h2>
          {{ activeProject.name }}
          <span v-if="activeProject.archivedAt" class="badge" data-testid="project-archived-badge">已归档</span>
        </h2>
        <p class="muted small">项目 ID：<code>{{ activeProject.id }}</code></p>
        <p data-testid="manager-line">
          顶层 manager：
          <strong v-if="manager" data-testid="manager-name">{{ manager.displayName }}</strong>
          <span v-else class="muted">（未指定，可稍后指定）</span>
        </p>

        <!-- T1 #48：项目生命周期 -->
        <div class="row" data-testid="project-lifecycle">
          <button
            v-if="!activeProject.archivedAt"
            type="button"
            :disabled="busy"
            data-testid="archive-project"
            @click="archiveProject"
          >
            归档项目
          </button>
          <button
            v-else
            type="button"
            :disabled="busy"
            data-testid="restore-project"
            @click="restoreProject"
          >
            恢复项目
          </button>
          <button
            type="button"
            :disabled="busy"
            class="danger"
            data-testid="purge-project"
            @click="requestProjectPurge"
          >
            永久删除项目
          </button>
        </div>

        <div v-if="pendingProjectPurge" class="confirm" data-testid="project-purge-confirm">
          <h3>确认永久删除项目「{{ pendingProjectPurge.projectName }}」？</h3>
          <p class="muted small">
            这一步不可恢复，并且会级联清除该项目下的以下内容（任务与记忆分别属于阶段 3、4，尚未落库）：
          </p>
          <ul class="small">
            <li>群组：{{ pendingProjectPurge.cascade.groups }} 个</li>
            <li>成员：{{ pendingProjectPurge.cascade.members }} 个</li>
            <li>群聊消息：{{ pendingProjectPurge.cascade.messages }} 条（投递记录 {{ pendingProjectPurge.cascade.deliveries }} 条）</li>
            <li>成员状态：{{ pendingProjectPurge.cascade.memberStatuses }} 条</li>
            <li>MCP 会话记录：{{ pendingProjectPurge.cascade.mcpSessions }} 条</li>
          </ul>
          <p class="muted small">确认凭据在 {{ pendingProjectPurge.expiresAt }} 后失效。</p>
          <div class="row">
            <button
              type="button"
              :disabled="busy"
              class="danger"
              data-testid="confirm-purge-project"
              @click="confirmProjectPurge"
            >
              确认永久删除
            </button>
            <button type="button" data-testid="cancel-purge-project" @click="cancelProjectPurge">取消</button>
          </div>
        </div>
      </div>

      <!-- 成员 -->
      <div class="panel">
        <h3>成员</h3>
        <p class="muted small">
          成员生命周期与在线状态分开建模：暂停（已暂停）保留历史、数据与岗位，可随时恢复；
          断连不删除成员，也不改写这里的生命周期状态。
        </p>
        <form class="row" @submit.prevent="addMember">
          <input v-model="newMemberName" placeholder="成员显示名（人）" data-testid="new-member-name" />
          <button type="submit" :disabled="busy" data-testid="add-member">添加成员</button>
        </form>
        <p v-if="members.length === 0" class="muted">暂无成员。</p>
        <ul v-else class="list" data-testid="member-list">
          <li v-for="member in members" :key="member.id" class="list-item">
            <span>
              <span class="dot" :class="isOnline(member.id) ? 'online' : 'offline'" data-testid="online-dot"></span>
              {{ member.displayName }}
              <span class="badge">{{ member.kind === "human" ? "人" : "agent" }}</span>
              <span v-if="member.role === 'manager'" class="badge manager">manager</span>
              <!-- T3 #50：生命周期状态（active/disabled/pending），与右侧在线/运行状态分开。 -->
              <span class="badge lifecycle" :class="`lifecycle-${member.status}`" data-testid="member-lifecycle-status">
                {{ lifecycleLabel(member) }}
              </span>
              <span v-if="member.kind === 'agent'" class="badge state" data-testid="member-state">
                {{ connectionLabel(member.id) }} / {{ stateLabel(member.id) }}
              </span>
            </span>
            <span class="actions">
              <button
                type="button"
                :disabled="busy || member.role === 'manager'"
                @click="assignManager(member)"
              >
                设为 manager
              </button>
              <button
                type="button"
                :disabled="busy"
                data-testid="toggle-member-status"
                @click="toggleMemberStatus(member)"
              >
                {{ member.status === "active" ? "暂停成员" : "恢复成员" }}
              </button>
              <button type="button" :disabled="busy" class="danger" @click="removeMember(member)">
                移除
              </button>
            </span>
          </li>
        </ul>
      </div>

      <!-- 成员在线状态（T2 基础展示；完整状态看板在 T4） -->
      <div class="panel">
        <h3>成员在线状态</h3>
        <p class="muted small">
          在线以 MCP 连接/心跳为准（不靠终端画面推断）：连接状态来自全局 MCP 会话，运行状态（等待/工作）来自成员显式上报。
        </p>
        <button type="button" :disabled="busy" data-testid="refresh-status" @click="loadStatuses">刷新状态</button>
        <p v-if="members.length === 0" class="muted">暂无成员。</p>
        <ul v-else class="list" data-testid="status-list">
          <li v-for="member in members" :key="member.id" class="list-item">
            <span>
              <span class="dot" :class="isOnline(member.id) ? 'online' : 'offline'"></span>
              {{ member.displayName }}
            </span>
            <span class="small" data-testid="status-detail">
              {{ connectionLabel(member.id) }} · {{ stateLabel(member.id) }}
              <template v-if="staleLabel(member.id)">
                · <span class="bad">{{ staleLabel(member.id) }}</span>
              </template>
            </span>
          </li>
        </ul>
      </div>

      <!-- 群组 -->
      <div class="panel">
        <h3>群组</h3>
        <div class="row">
          <input v-model="newGroupName" placeholder="新群组名称" data-testid="new-group-name" />
        </div>
        <fieldset class="participants-picker" data-testid="participant-picker">
          <legend>参与者（只能从项目成员中选择）</legend>
          <p v-if="members.length === 0" class="muted small">先添加成员，才能选择参与者。</p>
          <label v-for="member in members" :key="member.id" class="checkbox">
            <input
              type="checkbox"
              :checked="newGroupSelection.includes(member.id)"
              @change="toggleGroupSelection(member.id)"
            />
            {{ member.displayName }}
          </label>
        </fieldset>
        <button type="button" :disabled="busy" data-testid="create-group" @click="createGroup">
          创建群组
        </button>

        <p v-if="groups.length === 0" class="muted">暂无群组。</p>
        <ul v-else class="list" data-testid="group-list">
          <li v-for="group in groups" :key="group.id" class="list-item column">
            <strong>
              {{ group.name }}
              <span v-if="group.archivedAt" class="badge" data-testid="group-archived-badge">已归档</span>
              <!-- T2 #49 / #32：writable=false = 子树只读可见（可看元数据与历史，不唤醒、不能发消息）。 -->
              <span v-if="group.writable === false" class="badge" data-testid="group-readonly-badge">只读可见</span>
            </strong>
            <span class="small muted">参与者：{{ participantNames(group.id) }}</span>
            <span class="actions" data-testid="group-lifecycle">
              <button
                v-if="!group.archivedAt"
                type="button"
                :disabled="busy"
                data-testid="archive-group"
                @click="archiveGroup(group)"
              >
                归档群组
              </button>
              <button
                v-else
                type="button"
                :disabled="busy"
                data-testid="restore-group"
                @click="restoreGroup(group)"
              >
                恢复群组
              </button>
              <button
                type="button"
                :disabled="busy"
                class="danger"
                data-testid="purge-group"
                @click="requestGroupPurge(group)"
              >
                永久删除群组
              </button>
            </span>
          </li>
        </ul>

        <div v-if="pendingGroupPurge" class="confirm" data-testid="group-purge-confirm">
          <h3>确认永久删除群组「{{ pendingGroupPurge.groupName }}」？</h3>
          <p class="muted small">这一步不可恢复。删群组只清除群聊与参与者关系，项目成员本身保留。</p>
          <ul class="small">
            <li>群聊消息：{{ pendingGroupPurge.cascade.messages }} 条（投递记录 {{ pendingGroupPurge.cascade.deliveries }} 条）</li>
            <li>参与者关系：{{ pendingGroupPurge.cascade.participants }} 条</li>
            <li>MCP 会话记录：{{ pendingGroupPurge.cascade.mcpSessions }} 条</li>
          </ul>
          <div class="row">
            <button
              type="button"
              :disabled="busy"
              class="danger"
              data-testid="confirm-purge-group"
              @click="confirmGroupPurge"
            >
              确认永久删除
            </button>
            <button type="button" data-testid="cancel-purge-group" @click="cancelGroupPurge">取消</button>
          </div>
        </div>
      </div>
    </template>
    <p v-else class="muted">还没有项目，创建第一个项目开始。</p>
  </section>
</template>

<style scoped>
.row {
  display: flex;
  gap: 0.5rem;
  margin: 0.75rem 0;
  flex-wrap: wrap;
}

input {
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--card-bg);
  color: var(--fg);
  min-width: 200px;
}

button {
  padding: 0.4rem 0.8rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--card-bg);
  color: var(--fg);
  cursor: pointer;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

button.danger {
  color: var(--bad);
}

.tabs {
  display: flex;
  gap: 0.35rem;
  flex-wrap: wrap;
  margin: 1rem 0;
}

.tab {
  border-radius: 999px;
}

.tab.active {
  background: rgba(37, 99, 235, 0.14);
  color: var(--accent);
  border-color: var(--accent);
}

.panel {
  border-top: 1px solid var(--border);
  padding-top: 0.75rem;
  margin-top: 1rem;
}

.panel h2,
.panel h3 {
  margin: 0.25rem 0;
}

.list {
  list-style: none;
  padding: 0;
  margin: 0.5rem 0 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.list-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 8px;
}

/* T1 #48：永久删除的二次确认面板（红边提示不可恢复）。 */
.confirm {
  margin: 0.75rem 0 0;
  padding: 0.75rem 1rem;
  border: 1px solid var(--bad);
  border-radius: 8px;
  background: rgba(220, 38, 38, 0.06);
}

.confirm h3 {
  margin: 0 0 0.35rem;
  font-size: 1rem;
}

.confirm ul {
  margin: 0.25rem 0 0.5rem;
  padding-left: 1.25rem;
}

.chip {
  border-radius: 999px;
}

.list-item.column {
  flex-direction: column;
  align-items: flex-start;
}

.actions {
  display: flex;
  gap: 0.35rem;
}

.badge {
  font-size: 0.72rem;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: rgba(127, 127, 127, 0.18);
  margin-left: 0.25rem;
}

.badge.manager {
  background: rgba(37, 99, 235, 0.18);
  color: var(--accent);
}

.badge.state {
  background: rgba(127, 127, 127, 0.12);
  color: var(--muted);
}

/* T3 #50：生命周期状态徽章（暂停红、待激活黄、在岗沿用中性色）。 */
.badge.lifecycle-disabled {
  background: rgba(220, 38, 38, 0.16);
  color: var(--bad);
}

.badge.lifecycle-pending {
  background: rgba(234, 179, 8, 0.18);
}

.dot {
  display: inline-block;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  margin-right: 0.3rem;
  vertical-align: middle;
}

.dot.online {
  background: var(--ok);
}

.dot.offline {
  background: var(--muted);
}

.participants-picker {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.5rem 0.75rem;
  margin: 0.5rem 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.participants-picker legend {
  font-size: 0.8rem;
  color: var(--muted);
  padding: 0 0.25rem;
}

.checkbox {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.checkbox input {
  min-width: auto;
}

.notice {
  color: var(--ok);
  margin-top: 1rem;
}
</style>
