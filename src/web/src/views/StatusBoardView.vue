<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { api, ApiError, type MemberDto, type ProjectDto } from "../api/client.ts";
import StatusBoard from "../components/StatusBoard.vue";
import { useStatusBoardSocket } from "../composables/useStatusBoardSocket.ts";

/**
 * T4（#17）状态看板页面。
 *
 * - 选择项目后，通过 WebSocket 声明 presence（「人在 WebUI 在线」）并接收实时 `status_update`；
 * - 状态由服务端推导（连接层 + 运行层 + 心跳超时），前端只渲染；
 * - 页面加载时也用 HTTP `member-statuses` 做一次初始快照，WS 连上后由实时事件接管；
 * - 人的在线 = 本页 WS 连接；人**不会**显示 waiting/working。
 *
 * 边界（诚实说明）：真实浏览器 DOM/Playwright 交互不在本用例范围（仓库未引入浏览器驱动）；
 * 本页的 HTTP/WS 契约由自动化测试覆盖，WebUI E2E 通过构建产物文本 + 同一组接口验证。
 */

const projects = ref<ProjectDto[]>([]);
const activeProjectId = ref<string | null>(null);
const humanMemberId = ref<string | null>(null);
const members = ref<MemberDto[]>([]);
const error = ref<string | null>(null);
const busy = ref(false);

const board = useStatusBoardSocket();

const activeProject = computed(() => projects.value.find((p) => p.id === activeProjectId.value) ?? null);
const wsLabel = computed(() =>
  board.connection.value === "connected"
    ? "实时已连接"
    : board.connection.value === "connecting"
      ? "连接中"
      : "已断开（自动重连）",
);

async function loadProjects(): Promise<void> {
  try {
    const result = await api.listProjects();
    projects.value = result.projects;
    if (activeProjectId.value === null || !projects.value.some((p) => p.id === activeProjectId.value)) {
      activeProjectId.value = projects.value[0]?.id ?? null;
    }
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : (err as Error).message;
  }
}

async function loadMembers(projectId: string): Promise<void> {
  try {
    const result = await api.listMembers(projectId);
    members.value = result.members;
    // 默认把「人」成员作为本文档的 presence 身份（阶段 1 单用户；取第一个 human 成员）。
    humanMemberId.value = result.members.find((m) => m.kind === "human")?.id ?? null;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : (err as Error).message;
  }
}

async function refreshMembers(): Promise<void> {
  const projectId = activeProjectId.value;
  if (projectId === null) {
    members.value = [];
    return;
  }
  busy.value = true;
  try {
    const result = await api.listMembers(projectId);
    members.value = result.members;
    if (humanMemberId.value === null || !result.members.some((m) => m.id === humanMemberId.value)) {
      humanMemberId.value = result.members.find((m) => m.kind === "human")?.id ?? null;
    }
    // 用 HTTP 初始快照兜底（WS 事件到达即覆盖）。
    const statuses = await api.listMemberStatuses(projectId);
    if (board.statuses.value.length === 0) {
      board.statuses.value = statuses.memberStatuses.map((s) => ({
        projectId: s.projectId,
        memberId: s.memberId,
        kind: s.kind ?? "agent",
        displayName: s.displayName ?? "",
        state: (s.state ?? "offline") as "online" | "offline" | "waiting" | "working",
        connection: s.connection,
        heartbeatTimedOut: s.heartbeatTimedOut,
        heartbeatStale: s.heartbeatStale,
        stale: s.stale,
        disconnected: s.disconnected,
        lastHeartbeatAt: s.lastHeartbeatAt,
        connectedAt: s.connectedAt,
        disconnectedAt: s.disconnectedAt,
        hostType: s.hostType,
        updatedAt: s.updatedAt,
      }));
    }
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : (err as Error).message;
  } finally {
    busy.value = false;
  }
}

watch(activeProjectId, (projectId) => {
  if (projectId === null) {
    board.setProject(null);
    members.value = [];
    return;
  }
  // 声明 presence：人类成员 id 若已知则带上。
  board.setProject(projectId, humanMemberId.value ?? undefined);
  void loadMembers(projectId).then(() => {
    board.setProject(projectId, humanMemberId.value ?? undefined);
    void refreshMembers();
  });
});

onMounted(async () => {
  await loadProjects();
  if (activeProjectId.value !== null) {
    board.setProject(activeProjectId.value);
    await loadMembers(activeProjectId.value);
    board.setProject(activeProjectId.value, humanMemberId.value ?? undefined);
    await refreshMembers();
  }
});
</script>

<template>
  <section class="card">
    <h1>状态看板</h1>
    <p class="muted">
      显示成员在线/离线与等待/工作状态。在线以 MCP 连接/心跳为准，不靠终端画面推断；
      waiting/working 由显式状态信号（等待循环 / 状态上报）驱动。人在 WebUI 连接时只显示在线/离线。
    </p>

    <p v-if="error" class="error" data-testid="status-error">{{ error }}</p>

    <div class="toolbar">
      <label class="small muted">
        项目
        <select v-model="activeProjectId" data-testid="project-select">
          <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
        </select>
      </label>
      <span class="badge ws" :class="board.connection.value" data-testid="ws-state">{{ wsLabel }}</span>
      <button type="button" :disabled="busy" data-testid="status-refresh" @click="refreshMembers">刷新</button>
    </div>

    <p v-if="projects.length === 0" class="muted">还没有项目。请先在「项目与群组」创建项目。</p>
    <template v-else>
      <h2 class="project-title">{{ activeProject?.name }}</h2>
      <StatusBoard :entries="board.statuses.value" />
      <p class="muted small">
        当前项目成员：{{ members.map((m) => m.displayName).join("、") || "（无）" }}
        · 快照时间：{{ board.serverTime.value ?? "—" }}
      </p>
    </template>
  </section>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin: 0.75rem 0 1rem;
}

select {
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--card-bg);
  color: var(--fg);
  margin-left: 0.35rem;
}

button {
  padding: 0.35rem 0.8rem;
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

.badge.ws {
  font-size: 0.75rem;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  background: rgba(127, 127, 127, 0.16);
}

.badge.ws.connected {
  color: var(--ok);
}

.badge.ws.disconnected {
  color: var(--bad);
}

.project-title {
  font-size: 1.05rem;
  margin: 0.5rem 0;
}

.error {
  color: var(--bad);
}
</style>
