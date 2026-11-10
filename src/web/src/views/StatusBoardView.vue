<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { api, ApiError, type MemberDto, type ProjectDto } from "../api/client.ts";
import StatusBoard from "../components/StatusBoard.vue";
import { useStatusBoardSocket } from "../composables/useStatusBoardSocket.ts";

const route = useRoute();
const projects = ref<ProjectDto[]>([]);
const activeProjectId = ref<string | null>(null);
const members = ref<MemberDto[]>([]);
const error = ref<string | null>(null);
const listFailed = ref(false);
const busy = ref(false);
const loadingProjects = ref(true);
const showArchived = ref(false);
const board = useStatusBoardSocket();
let listRequest = 0;
let memberRequest = 0;
let disposed = false;

const activeProject = computed(() => projects.value.find((p) => p.id === activeProjectId.value) ?? null);
const wsLabel = computed(() => board.connection.value === "connected" ? "实时已连接" : board.connection.value === "connecting" ? "正在连接" : "已断开，正在重连");

function statusLabel(status: ProjectDto["status"]): string {
  if (status === "active") return "有成员在线";
  if (status === "archived") return "已归档";
  if (status === "idle") return "暂无成员在线";
  return "状态未知";
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "暂无记录";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function errorMessage(err: unknown): string {
  return err instanceof ApiError || err instanceof Error ? err.message : "请求失败，请重试。";
}

async function loadProjects(): Promise<void> {
  const request = ++listRequest;
  loadingProjects.value = true;
  error.value = null;
  listFailed.value = false;
  try {
    const result = await api.listProjects({ includeArchived: showArchived.value });
    if (disposed || request !== listRequest) return;
    projects.value = result.projects;
    if (activeProjectId.value === null || !projects.value.some((p) => p.id === activeProjectId.value)) {
      const requested = typeof route.query["projectId"] === "string" ? route.query["projectId"] : "";
      activeProjectId.value = projects.value.find((p) => p.id === requested)?.id ?? projects.value[0]?.id ?? null;
    }
  } catch (err) {
    if (!disposed && request === listRequest) {
      error.value = errorMessage(err);
      listFailed.value = true;
    }
  } finally {
    if (!disposed && request === listRequest) loadingProjects.value = false;
  }
}

async function refreshMembers(): Promise<void> {
  const projectId = activeProjectId.value;
  if (projectId === null) return;
  const request = ++memberRequest;
  const socketSnapshot = board.serverTime.value;
  busy.value = true;
  if (!listFailed.value) error.value = null;
  try {
    const [memberResult, statusResult] = await Promise.all([api.listMembers(projectId), api.listMemberStatuses(projectId)]);
    if (disposed || request !== memberRequest || activeProjectId.value !== projectId) return;
    members.value = memberResult.members;
    const humanMemberId = memberResult.members.find((member) => member.kind === "human")?.id;
    board.setProject(projectId, humanMemberId);
    // HTTP 用作初始/手动刷新；请求期间若已收到 WS 快照，不用较旧的响应覆盖它。
    if (board.serverTime.value === socketSnapshot) {
      board.statuses.value = statusResult.memberStatuses.map((status) => ({
        projectId: status.projectId,
        memberId: status.memberId,
        kind: status.kind ?? "agent",
        displayName: status.displayName ?? "",
        state: status.state ?? "offline",
        connection: status.connection,
        heartbeatTimedOut: status.heartbeatTimedOut,
        heartbeatStale: status.heartbeatStale,
        stale: status.stale,
        disconnected: status.disconnected,
        lastHeartbeatAt: status.lastHeartbeatAt,
        connectedAt: status.connectedAt,
        disconnectedAt: status.disconnectedAt,
        hostType: status.hostType,
        updatedAt: status.updatedAt,
      }));
    }
  } catch (err) {
    if (!disposed && request === memberRequest && activeProjectId.value === projectId) error.value = errorMessage(err);
  } finally {
    if (!disposed && request === memberRequest) busy.value = false;
  }
}

function selectProject(projectId: string): void {
  activeProjectId.value = projectId;
}

function retryLoad(): void {
  if (listFailed.value) void loadProjects();
  else void refreshMembers();
}

watch(activeProjectId, (projectId) => {
  memberRequest += 1;
  members.value = [];
  board.statuses.value = [];
  board.serverTime.value = null;
  board.setProject(projectId);
  if (projectId !== null) void refreshMembers();
  else busy.value = false;
}, { flush: "sync" });
watch(() => route.query["projectId"], (projectId) => {
  if (typeof projectId === "string" && projects.value.some((project) => project.id === projectId)) activeProjectId.value = projectId;
});

onMounted(() => void loadProjects());
onBeforeUnmount(() => { disposed = true; listRequest += 1; memberRequest += 1; });
</script>

<template>
  <section class="page status-page">
    <header class="page-header">
      <div><h1>状态看板</h1><p class="page-description">查看各项目近况，以及成员当前的连接和工作状态。</p></div>
      <span class="badge ws" :class="board.connection.value" data-testid="ws-state" role="status">{{ wsLabel }}</span>
    </header>

    <div v-if="error" class="error" role="alert" data-testid="status-error">
      <span>{{ error }}</span><button type="button" class="text-button" :disabled="busy || loadingProjects" @click="retryLoad">重新加载</button>
    </div>

    <section class="overview panel" data-testid="cross-project-overview" aria-labelledby="project-overview-heading">
      <div class="overview-head">
        <h2 id="project-overview-heading">跨项目概览</h2>
        <label class="archive-toggle small muted"><input v-model="showArchived" type="checkbox" :disabled="loadingProjects" data-testid="show-archived" @change="loadProjects" />显示已归档</label>
      </div>
      <p v-if="loadingProjects && projects.length === 0" class="muted" role="status">正在加载项目…</p>
      <ul v-else-if="projects.length > 0" class="overview-list" aria-label="选择要查看的项目">
        <li v-for="project in projects" :key="project.id">
          <button type="button" class="overview-item" :class="{ active: project.id === activeProjectId }" :aria-pressed="project.id === activeProjectId" :data-testid="`overview-item-${project.id}`" @click="selectProject(project.id)">
            <span class="project-name-row"><span class="name">{{ project.name }}</span><span v-if="project.status === 'archived'" class="badge archived">已归档</span></span>
            <span class="project-state"><span class="dot" :class="project.status" aria-hidden="true" />{{ statusLabel(project.status) }}</span>
            <span class="metrics"><span><strong>{{ project.memberCount ?? 0 }}</strong> 成员</span><span><strong>{{ project.groupCount ?? 0 }}</strong> 群组</span><span><strong>{{ project.messageCount ?? 0 }}</strong> 消息</span><span><strong>{{ project.onlineCount ?? 0 }}</strong> 在线</span></span>
            <span class="last">最近活跃 {{ formatTime(project.lastActivityAt) }}</span>
          </button>
        </li>
      </ul>
      <div v-else-if="!listFailed" class="empty-state"><h3>还没有项目</h3><p class="muted">创建项目并添加成员后，可以在这里查看协作状态。</p><RouterLink class="primary" to="/projects">前往项目与群组</RouterLink></div>
    </section>

    <section v-if="activeProject" class="panel member-panel" aria-labelledby="member-status-heading" :aria-busy="busy">
      <div class="status-toolbar">
        <div><h2 id="member-status-heading">成员状态</h2><p class="muted small">{{ activeProject.name }}</p></div>
        <div class="status-actions">
          <label class="field"><span class="visually-hidden">项目</span><select v-model="activeProjectId" aria-label="项目" data-testid="project-select"><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label>
          <button type="button" :disabled="busy" data-testid="status-refresh" @click="refreshMembers">{{ busy ? '刷新中…' : '刷新' }}</button>
        </div>
      </div>
      <p v-if="busy && board.statuses.value.length === 0" class="muted" role="status">正在读取成员状态…</p>
      <StatusBoard v-else :entries="board.statuses.value" />
      <p class="snapshot small muted">{{ members.length }} 位项目成员 · 实时快照：{{ formatTime(board.serverTime.value) }}</p>
    </section>

    <details class="status-help small muted"><summary>状态说明</summary><p>在线状态依据连接和心跳。Agent 的“等待中”和“工作中”来自实际状态上报，不代表任务已领取或完成；人的成员身份只显示在线或离线。项目概览是本次读取的汇总，成员状态会实时更新。</p></details>
  </section>
</template>

<style scoped>
.ws.connected { color: var(--ok); }
.ws.disconnected { color: var(--warn); }
.overview-head, .status-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.25rem; }
.overview-head h2, .status-toolbar h2 { margin: 0; font-size: 1.05rem; }
.archive-toggle { display: inline-flex; align-items: center; gap: 0.5rem; cursor: pointer; min-height: 38px; }
.overview-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 290px), 1fr)); gap: 0.75rem; list-style: none; padding: 0; margin: 0; }
.overview-list li { min-width: 0; }
.overview-item { display: flex; flex-direction: column; gap: 0.65rem; width: 100%; height: 100%; padding: 1rem 1.125rem; text-align: left; border: 1px solid var(--border); border-radius: 12px; color: var(--fg); background: var(--card-bg); }
.overview-item:hover { background: var(--surface-subtle); }
.overview-item.active { background: var(--accent-soft); border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.project-name-row { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
.name { font-size: 0.95rem; font-weight: 600; overflow-wrap: anywhere; }
.project-state { display: flex; align-items: center; gap: 0.4rem; color: var(--muted); font-size: 0.8rem; }
.metrics { display: flex; flex-wrap: wrap; gap: 0.45rem 1rem; font-size: 0.8rem; color: var(--muted); }
.metrics strong { color: var(--fg); font-weight: 600; font-variant-numeric: tabular-nums; }
.last { color: var(--muted); font-size: 0.8rem; overflow-wrap: anywhere; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex: 0 0 auto; }
.dot.active { background: var(--ok); }
.dot.idle { background: var(--muted); }
.status-toolbar > div { min-width: 0; }
.status-toolbar p { margin: 0.3rem 0 0; overflow-wrap: anywhere; }
.status-actions { display: flex; gap: 0.65rem; align-items: center; max-width: 100%; }
.status-actions .field { min-width: 0; max-width: 22rem; }
.status-actions select { width: 100%; min-width: 0; }
.status-actions button { flex: 0 0 auto; }
.snapshot { margin: 1rem 0 0; overflow-wrap: anywhere; }
.status-help summary { padding: 0.4rem 0; cursor: pointer; }
.status-help p { max-width: 80ch; }
@media (max-width: 720px) {
  .status-toolbar { align-items: stretch; }
  .status-actions { width: 100%; }
  .status-actions .field { flex: 1; max-width: none; }
}
</style>
