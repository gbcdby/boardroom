<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { api, ApiError, type MemberDto } from "../api/client.ts";
import StatusBoard from "../components/StatusBoard.vue";
import { useStatusBoardSocket } from "../composables/useStatusBoardSocket.ts";

import { useCurrentProject } from "../composables/useCurrentProject.ts";
const { currentProjectId: activeProjectId, currentProject: activeProject } = useCurrentProject();
const members = ref<MemberDto[]>([]);
const error = ref<string | null>(null);
const busy = ref(false);
const board = useStatusBoardSocket();
let memberRequest = 0;
let disposed = false;

const wsLabel = computed(() => board.connection.value === "connected" ? "实时已连接" : board.connection.value === "connecting" ? "正在连接" : "已断开，正在重连");

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "暂无记录";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function errorMessage(err: unknown): string {
  return err instanceof ApiError || err instanceof Error ? err.message : "请求失败，请重试。";
}

async function refreshMembers(): Promise<void> {
  const projectId = activeProjectId.value;
  if (projectId === null) return;
  const request = ++memberRequest;
  const socketSnapshot = board.serverTime.value;
  busy.value = true;
  error.value = null;
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

watch(activeProjectId, (projectId) => {
  memberRequest += 1;
  members.value = [];
  board.statuses.value = [];
  board.serverTime.value = null;
  board.setProject(projectId);
  if (projectId !== null) void refreshMembers();
  else busy.value = false;
}, { flush: "sync", immediate: true });
onBeforeUnmount(() => { disposed = true; memberRequest += 1; });
</script>

<template>
  <section class="page status-page">
    <header class="page-header">
      <div><h1>状态看板</h1><p class="page-description">查看当前项目成员的连接和工作状态。</p></div>
      <span class="badge ws" :class="board.connection.value" data-testid="ws-state" role="status">{{ wsLabel }}</span>
    </header>

    <div v-if="error" class="error" role="alert" data-testid="status-error">
      <span>{{ error }}</span><button type="button" class="text-button" :disabled="busy" @click="refreshMembers">重新加载</button>
    </div>

    <div v-if="!activeProject" class="panel empty-state"><h2>选择一个项目</h2><p>在顶栏选择项目，查看成员状态。</p><RouterLink to="/projects">前往项目</RouterLink></div>

    <section v-if="activeProject" class="panel member-panel" aria-labelledby="member-status-heading" :aria-busy="busy">
      <div class="status-toolbar">
        <div><h2 id="member-status-heading">成员状态</h2><p class="muted small">{{ activeProject.name }}</p></div>
        <div class="status-actions">

          <button type="button" :disabled="busy" data-testid="status-refresh" @click="refreshMembers">{{ busy ? '刷新中…' : '刷新' }}</button>
        </div>
      </div>
      <p v-if="busy && board.statuses.value.length === 0" class="muted" role="status">正在读取成员状态…</p>
      <StatusBoard v-else :entries="board.statuses.value" />
      <p class="snapshot small muted">{{ members.length }} 位项目成员 · 实时快照：{{ formatTime(board.serverTime.value) }}</p>
    </section>

    <details class="status-help small muted"><summary>状态说明</summary><p>在线状态依据连接和心跳。Agent 的“等待中”和“工作中”来自实际状态上报，不代表任务已领取或完成；人的成员身份只显示在线或离线。成员状态会实时更新。</p></details>
  </section>
</template>

<style scoped>
.ws.connected { color: var(--ok); }
.ws.disconnected { color: var(--warn); }
.status-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.25rem; }
.status-toolbar h2 { margin: 0; font-size: 1.05rem; }
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
