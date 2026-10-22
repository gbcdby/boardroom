<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ApiError, api, type GroupDto, type MemberDto, type MemberStatusDto, type ProjectDto } from "../api/client.ts";

/**
 * T1（#14）项目工作台：在 WebUI 中创建项目、管理项目成员、指定顶层 manager、
 * 创建群组并选择参与者（只能从项目成员中选）。
 *
 * 阶段 1 只验收单个项目；页面允许切换项目。真实 agent 成员由 T2（MCP 入群）产生，
 * 本页只管理已存在的成员（currently 人 + 后续 T2 加入的 agent）。
 */

const projects = ref<ProjectDto[]>([]);
const activeProjectId = ref<string | null>(null);
const members = ref<MemberDto[]>([]);
const groups = ref<GroupDto[]>([]);
/** 群组 id → 参与者列表。 */
const participants = ref<Record<string, MemberDto[]>>({});
/** 项目成员在线/连接状态（T2）：memberId → 状态视图。 */
const statuses = ref<Record<string, MemberStatusDto>>({});

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
  const result = await run(() => api.listProjects());
  if (!result) return;
  projects.value = result.projects;
  if (activeProjectId.value === null || !projects.value.some((p) => p.id === activeProjectId.value)) {
    activeProjectId.value = projects.value[0]?.id ?? null;
  }
  await loadActiveProject();
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
    run(() => api.listGroups(projectId)),
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
      阶段 1 只验收单个项目；真实 agent 成员由 MCP 入群（后续），本页管理已存在的成员。
    </p>

    <p v-if="error" class="error" data-testid="error">{{ error }}</p>
    <p v-if="notice" class="notice" data-testid="notice">{{ notice }}</p>

    <!-- 新建项目 -->
    <form class="row" @submit.prevent="createProject">
      <input v-model="newProjectName" placeholder="新项目名称" data-testid="new-project-name" />
      <button type="submit" :disabled="busy" data-testid="create-project">创建项目</button>
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
        {{ project.name }}
      </button>
    </div>

    <template v-if="activeProject">
      <div class="panel" data-testid="project-detail">
        <h2>{{ activeProject.name }}</h2>
        <p class="muted small">项目 ID：<code>{{ activeProject.id }}</code></p>
        <p data-testid="manager-line">
          顶层 manager：
          <strong v-if="manager" data-testid="manager-name">{{ manager.displayName }}</strong>
          <span v-else class="muted">（未指定）</span>
        </p>
      </div>

      <!-- 成员 -->
      <div class="panel">
        <h3>成员</h3>
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
            <strong>{{ group.name }}</strong>
            <span class="small muted">参与者：{{ participantNames(group.id) }}</span>
          </li>
        </ul>
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
