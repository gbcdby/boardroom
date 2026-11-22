<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import AppIcon from "../components/AppIcon.vue";
import CollabGraphCanvas from "../components/CollabGraphCanvas.vue";
import TaskFlowBoard from "../components/TaskFlowBoard.vue";
import type { GraphCanvasData } from "../components/collabGraphLayout.ts";
import { api } from "../api/client.ts";
import { useCollabGraph } from "../composables/useCollabGraph.ts";
import { buildTaskFlowBoard, toGraphCanvasData } from "../composables/collabGraphProjection.ts";
import {
  toInspectorMessage, useGroupConversationInspector, type InspectorScope,
} from "../composables/groupConversationInspector.ts";
import { initialConversationSelection, isProjectSwitch, reconcileConversationSelection } from "../composables/collabGraphSelection.ts";
import { projectPath, useCurrentProject } from "../composables/useCurrentProject.ts";
interface HealthReport {
  status: "ok" | "degraded"; uptimeSeconds: number; serverTime: string;
  database: { status: string; writable: boolean; error?: string };
  migrations: { version: number; applied: number; pending: number };
  heartbeat: { intervalMs: number; timeoutMs: number }; webui: { built: boolean };
}

// P01 中央图、顶部计数与右侧动态均来自当前项目真实只读 API；空数据就是空图。
const context = useCurrentProject();
const graphProjectId = computed(() => context.currentProjectId.value);
const { graph, loading: graphLoading, error: graphError, load: loadGraph } = useCollabGraph(graphProjectId);
const graphCanvasData = computed<GraphCanvasData>(() => toGraphCanvasData(graph.value));
const messageLayerStatus = computed(() => {
  const layer = graph.value.messageDirection;
  if (!messageLayerVisible.value) return `消息层已关闭，${layer.totalCount} 条真实消息仍照常更新`;
  const overflow = layer.overflowCount ? ` · 聚合 ${layer.overflowCount} 条` : "";
  return `消息层：${layer.markers.length} 条标记${overflow} · 共 ${layer.totalCount} 条`;
});
const graphScopeName = computed(() => context.projects.value.find((project) => project.id === graphProjectId.value)?.name ?? "");
const selectedMemberId = ref<string | null>(null);
const pendingConversationIntent = ref(initialConversationSelection(new URLSearchParams(location.search).get("view")).pendingDeepLink);
watch([graphProjectId, () => context.generation.value], () => { void loadGraph(); }, { immediate: true });
watch(
  [graphProjectId, graphCanvasData, graphLoading, graphError] as const,
  ([projectId, data, loading, error], previous) => {
    const result = reconcileConversationSelection(
      { selectedId: selectedMemberId.value, pendingDeepLink: pendingConversationIntent.value },
      data.groups.flatMap(group => group.members).map(member => member.id),
      { loading, failed: error !== null, projectChanged: isProjectSwitch(previous?.[0], projectId) },
    );
    selectedMemberId.value = result.selectedId;
    pendingConversationIntent.value = result.pendingDeepLink;
  },
  { immediate: true },
);

// P03 只读看板：任务、负责人与资料缺口都来自 useCollabGraph 的当前项目真实快照。
const activeView = ref<"members" | "tasks">("members");
const tasksTab = ref<HTMLButtonElement | null>(null);
const selectedTaskId = ref<string | null>(null);
const taskColumns = computed(() => buildTaskFlowBoard(graph.value.tasks));
const selectedTask = computed(() => graph.value.tasks.find((task) => task.id === selectedTaskId.value) ?? null);
watch([graphProjectId, graphLoading, graphError] as const, ([projectId, loading, error], previous) => {
  if (previous && projectId === previous[0] && !loading && !error) return;
  selectedTaskId.value = null;
});
function selectTask(id: string): void { selectedTaskId.value = id; }
function refreshTaskFlow(): void { void loadGraph().finally(() => tasksTab.value?.focus()); }
// 图层开关与暂停只改变画布表现；图投影与消息事实仍照常更新。
const relationLayerVisible = ref(true);
const messageLayerVisible = ref(true);
const animationPaused = ref(false);
function switchView(view: "members" | "tasks"): void { activeView.value = view; unavailableReason.value = null; }

// P02 已接为图内真实检查器：节点/群入口只决定 scope，正文按该群绑定读取真实 Boardroom 消息。
const selectedNode = computed(() => graphCanvasData.value.groups.flatMap(group => group.members).find(member => member.id === selectedMemberId.value) ?? null);
const selectedGroupId = ref<string | null>(null);
const {
  scope: inspectorState, messages: inspectorMessages,
  loading: inspectorLoading, error: inspectorError,
  select: selectInspector, clear: clearInspector,
} = useGroupConversationInspector(async (scope) => {
  const { messages } = await api.listMessages(scope.groupId);
  return messages.map(toInspectorMessage);
});
const selectedGroup = computed(() => graphCanvasData.value.groups.find(group =>
  (selectedGroupId.value !== null && group.id === selectedGroupId.value)
  || group.members.some(member => member.id === selectedMemberId.value)) ?? null);
const activeInspectorScope = computed<InspectorScope | null>(() => {
  const group = selectedGroup.value;
  if (!group?.id) return null;
  const member = selectedMemberId.value
    ? group.members.find(item => item.id === selectedMemberId.value) ?? null
    : null;
  if (selectedMemberId.value && !member) return null;
  return {
    groupId: group.id,
    groupName: group.name,
    memberId: member?.memberId ?? null,
    memberName: member?.name ?? null,
  };
});
watch(activeInspectorScope, (next) => { void selectInspector(next); }, { immediate: true });
watch(graphCanvasData, (data) => {
  if (selectedGroupId.value && !data.groups.some(group => group.id === selectedGroupId.value)) selectedGroupId.value = null;
});
function openConversation(memberId: string): void {
  selectedMemberId.value = memberId;
  selectedGroupId.value = null;
}
function openGroupConversation(groupId: string): void {
  selectedGroupId.value = groupId;
  selectedMemberId.value = null;
}
function closeConversation(): void {
  selectedMemberId.value = null;
  selectedGroupId.value = null;
  clearInspector();
}
function messageTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
const demoPending = [{ title: "扩大工具使用范围", detail: "项目策略要求确认" }];

const health = ref<HealthReport | null>(null);
const healthError = ref<string | null>(null);
const projects = computed(() => context.projects.value.filter((project) => project.archivedAt === null));
const projectError = context.error;
const loading = ref(true);
const refreshing = ref(false);
const connection = ref<"connecting" | "connected" | "disconnected">("connecting");
const lastEvent = ref<string | null>(null);
let socket: WebSocket | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;
const activeCount = computed(() => projects.value.filter((project) => project.status === "active").length);
const groupCount = computed(() => projects.value.reduce((total, project) => total + (project.groupCount ?? 0), 0));
const connectedLabel = computed(() => healthError.value ? "连接异常" : !health.value ? "连接中" : health.value.status === "ok" ? "已连接" : "服务降级");
const serviceLabel = computed(() => healthError.value ? "暂时无法连接" : !health.value ? "正在连接" : health.value.status === "ok" ? "服务正常" : "服务需要关注");
const wsLabel = computed(() => connection.value === "connected" ? "实时连接正常" : connection.value === "connecting" ? "实时连接中" : "连接中断，正在重连");
const unavailableReason = ref<string | null>(null);
function explainUnavailable(label: string): void {
  unavailableReason.value = `「${label}」是静态演示控件，本批未接入真实交互。`;
}
async function refreshHealth(): Promise<void> {
  try {
    const response = await fetch("/api/health");
    if (!response.ok && response.status !== 503) throw new Error(`服务返回 ${response.status}`);
    const result = await response.json() as HealthReport;
    if (!disposed) { health.value = result; healthError.value = null; }
  } catch (error) { if (!disposed) healthError.value = (error as Error).message; }
}
async function refresh(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  await Promise.allSettled([refreshHealth(), context.refreshProjects()]);
  void loadGraph();
  if (!disposed) { loading.value = false; refreshing.value = false; }
}
function connect(): void {
  if (disposed) return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  connection.value = "connecting";
  socket.addEventListener("open", () => { if (!disposed) connection.value = "connected"; });
  socket.addEventListener("message", (event) => { if (!disposed) lastEvent.value = String(event.data); });
  socket.addEventListener("close", () => { if (!disposed) { connection.value = "disconnected"; reconnectTimer = setTimeout(connect, 2000); } });
  socket.addEventListener("error", () => { if (!disposed) connection.value = "disconnected"; });
}
function recentActivity(value?: string | null): string {
  if (!value) return "暂无对话";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function uptime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes < 1 ? "不到 1 分钟" : minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}
onMounted(() => {
  void refresh(); connect(); healthTimer = setInterval(() => void refreshHealth(), 15000);
  // 原型浏览 split view 可经 query 直达 P02（成员会话）/P03（任务流转）。
  const view = new URLSearchParams(location.search).get("view");
  if (view === "tasks") activeView.value = "tasks";
});
onUnmounted(() => { disposed = true; socket?.close(); if (healthTimer) clearInterval(healthTimer); if (reconnectTimer) clearTimeout(reconnectTimer); });
</script>

<template>
  <section class="page home-page">
    <header class="page-header collab-header">
      <div class="header-title"><span class="page-icon"><AppIcon name="layers" :size="24" /></span><div><h1>协作总览</h1><p class="page-description" data-testid="p01-counts">{{ graph.groups.length }} 个群组 · {{ graph.memberCount }} 位成员 · {{ graph.messageCount }} 条消息</p></div></div>
      <div class="collab-header-meta">
        <button type="button" class="toolbar-control scope-control" aria-disabled="true" title="范围切换是静态演示控件" data-testid="p01-scope" @click="explainUnavailable('范围切换')">范围：{{ graphScopeName || '未选择项目' }}<AppIcon name="chevron" :size="14" /></button>
        <span class="connected-state" :class="healthError || health?.status === 'degraded' ? 'bad' : health ? 'ok' : 'muted'" data-testid="p01-connected"><span class="connected-dot" aria-hidden="true"></span>{{ connectedLabel }} · 刚刚更新</span>
      </div>
    </header>
    <div v-if="projectError" class="error" role="alert">项目暂时无法加载：{{ projectError }} <button type="button" class="text-button" :disabled="refreshing" @click="refresh">重新加载</button></div>

    <section class="collab-toolbar" aria-label="协作总览工具条">
      <div class="toolbar-views" role="group" aria-label="视图切换">
        <button type="button" class="view-tab" :aria-pressed="activeView === 'members'" @click="switchView('members')">成员关系</button>
        <button type="button" ref="tasksTab" class="view-tab" :aria-pressed="activeView === 'tasks'" data-testid="p03-tasks-tab" @click="switchView('tasks')">任务流转</button>
      </div>
      <template v-if="activeView === 'tasks'">
        <span class="task-select-label" data-testid="p03-task-count">任务：{{ graph.tasks.length }} 项 · 当前项目真实数据（只读）</span>
      </template>
      <template v-else>
        <div class="toolbar-layers" role="group" aria-label="关系图层">
          <label class="layer-option"><input type="checkbox" v-model="relationLayerVisible" data-testid="p01-relation-layer-toggle" />协作关系</label>
          <label class="layer-option"><input type="checkbox" v-model="messageLayerVisible" data-testid="p01-message-layer-toggle" />消息方向</label>
          <button
            type="button"
            class="toolbar-control pause-control"
            :aria-pressed="animationPaused"
            :disabled="!messageLayerVisible"
            data-testid="p01-message-pause-toggle"
            @click="animationPaused = !animationPaused"
          >{{ animationPaused ? "继续动态" : "暂停动态" }}</button>
        </div>
        <button type="button" class="toolbar-control filter-control" aria-disabled="true" title="成员筛选是静态演示控件" @click="explainUnavailable('成员筛选')">全部成员<AppIcon name="chevron" :size="14" /></button>
      </template>
    </section>
    <p v-if="unavailableReason" class="collab-status muted small" role="status" data-testid="p01-unconnected-status">{{ unavailableReason }}</p>

    <div class="collab-workspace">
      <div class="collab-main">
        <section v-if="activeView === 'members'" class="panel graph-panel" aria-label="协作关系图（当前项目真实数据）">
          <div class="graph-canvas" data-testid="p01-graph-canvas">
            <p v-if="graphError" class="graph-empty error" role="alert" data-testid="p01-graph-error">关系图读取失败：{{ graphError }} <button type="button" class="text-button" @click="loadGraph()">重试</button></p>
            <p v-else-if="graphLoading" class="graph-empty muted" role="status" data-testid="p01-graph-loading">正在读取当前项目的真实成员与群…</p>
            <p v-else-if="graph.groups.length === 0" class="graph-empty" data-testid="p01-graph-empty">当前范围没有可读取的群与成员，关系图为空。<RouterLink to="/projects">选择或创建项目</RouterLink></p>
            <!-- 保持画布实例跨刷新存活：新逻辑 ID 才能触发一次流动标记，历史重载不重放。 -->
            <CollabGraphCanvas
              v-show="!graphError && !graphLoading && graph.groups.length > 0"
              :data="graphCanvasData"
              :selected-id="selectedMemberId"
              :message-direction="graph.messageDirection"
              :relation-layer="relationLayerVisible"
              :message-layer="messageLayerVisible"
              :paused="animationPaused"
              :scope-key="graphProjectId"
              @select="openConversation"
              @select-group="openGroupConversation"
            />
          </div>
          <div class="graph-footer">
            <ul class="graph-legend" aria-label="关系图图例"><li><span class="legend-line" aria-hidden="true"></span>协作关系</li><li><span class="legend-line legend-arrow" aria-hidden="true"></span>消息方向</li><li><span class="legend-dot ok" aria-hidden="true"></span>连接正常</li></ul>
            <p class="graph-layer-status small muted" data-testid="p01-message-layer-status">{{ messageLayerStatus }}</p>
            <div class="graph-controls" role="group" aria-label="画布操作，静态演示">
              <button type="button" aria-label="缩小画布，静态演示" aria-disabled="true" title="静态演示控件" @click="explainUnavailable('缩小画布')">−</button>
              <span class="zoom-value">100%</span>
              <button type="button" aria-label="放大画布，静态演示" aria-disabled="true" title="静态演示控件" @click="explainUnavailable('放大画布')">+</button>
              <button type="button" aria-label="适应画布，静态演示" aria-disabled="true" title="静态演示控件" @click="explainUnavailable('适应画布')">适应画布</button>
            </div>
          </div>
        </section>
        <section v-else class="panel taskflow-panel" aria-labelledby="taskflow-title" data-testid="p03-taskflow">
          <div class="section-heading">
            <h2 id="taskflow-title">任务流转<span class="real-chip">真实数据</span></h2>
            <span class="board-scope small muted" data-testid="p03-board-source">来源：当前项目「{{ graphScopeName || '未选择项目' }}」的只读任务 API</span>
          </div>
          <TaskFlowBoard
            :columns="taskColumns"
            :tasks="graph.tasks"
            :loading="graphLoading"
            :error="graphError"
            :selected-id="selectedTaskId"
            @select="selectTask"
            @refresh="refreshTaskFlow"
          />
        </section>
        <details class="real-data-fold" data-testid="p01-real-data-fold">
          <summary>真实数据（当前环境）：{{ loading ? '读取中…' : `${projects.length} 个项目 · ${activeCount} 个活跃 · ${groupCount} 个群组` }}</summary>
          <dl class="overview-metrics" :aria-busy="loading">
            <div><dt>进行中的项目</dt><dd>{{ loading || projectError ? '—' : projects.length }}</dd><span>未归档的协作空间</span></div>
            <div><dt>当前活跃</dt><dd>{{ loading || projectError ? '—' : activeCount }}</dd><span>有成员在线的项目</span></div>
            <div><dt>群组</dt><dd>{{ loading || projectError ? '—' : groupCount }}</dd><span>按项目组织交流</span></div>
          </dl>
          <section class="panel project-overview" aria-labelledby="projects-title">
            <div class="section-heading"><h2 id="projects-title">你的项目</h2><button type="button" class="text-button" :disabled="refreshing" @click="refresh">{{ refreshing ? '刷新中…' : '刷新' }}</button></div>
            <p v-if="loading" class="muted loading-state" role="status">正在读取项目…</p>
            <div v-else-if="!projectError && projects.length === 0" class="empty-state"><h3>当前没有未归档项目</h3><p>上方关系图只展示当前项目的真实数据；无数据时不会显示示例节点。</p></div>
            <ul v-else class="home-projects"><li v-for="project in projects" :key="project.id"><RouterLink :to="projectPath(project.id)" class="home-project-link"><span class="project-monogram">{{ project.name.slice(0, 1) }}</span><span class="project-copy"><strong>{{ project.name }}</strong><span>{{ project.memberCount ?? 0 }} 位成员 · {{ project.groupCount ?? 0 }} 个群组</span></span><span class="project-activity"><span class="badge" :class="{ ok: project.status === 'active' }">{{ project.status === 'active' ? '活跃' : '空闲' }}</span><small>{{ recentActivity(project.lastActivityAt) }}</small></span><AppIcon name="chevron" :size="16" /></RouterLink></li></ul>
          </section>
        </details>
      </div>
      <aside class="collab-side" :aria-label="activeView === 'tasks' ? '任务详情' : '动态与待我处理'">
        <template v-if="activeView === 'tasks'">
          <section class="panel side-panel task-detail" aria-labelledby="task-detail-title" data-testid="p03-task-detail">
            <div class="side-heading"><h2 id="task-detail-title">任务详情<span class="real-chip">真实数据</span></h2></div>
            <template v-if="selectedTask">
              <div class="task-detail-title">
                <strong data-testid="p03-detail-title">{{ selectedTask.title }}</strong>
                <span class="status-badge" :class="selectedTask.state === 'blocked' ? 'wait' : selectedTask.state === 'done' ? 'ok' : 'active'">{{ selectedTask.stateLabel }}</span>
              </div>
              <dl class="task-facts">
                <div><dt>任务 ID</dt><dd data-testid="p03-detail-id">{{ selectedTask.id }}</dd></div>
                <div><dt>版本</dt><dd data-testid="p03-detail-revision">v{{ selectedTask.revision }}</dd></div>
                <div><dt>负责人</dt><dd data-testid="p03-detail-assignee">{{ selectedTask.assignee ?? '未指派' }}<small v-if="selectedTask.assigneeMemberId"> · {{ selectedTask.assigneeMemberId }}</small></dd></div>
                <div><dt>评审人</dt><dd>{{ selectedTask.reviewer ?? '未指派' }}<small v-if="selectedTask.reviewerMemberId"> · {{ selectedTask.reviewerMemberId }}</small></dd></div>
                <div><dt>受阻原因</dt><dd data-testid="p03-detail-blocked">{{ selectedTask.blockedReason ?? '无' }}</dd></div>
                <div><dt>评审来源</dt><dd>repoPath：{{ selectedTask.repoPath ?? '未填' }} · fixedPoint：{{ selectedTask.fixedPoint ?? '未填' }}</dd></div>
                <div><dt>更新时间</dt><dd>{{ selectedTask.updatedAt }}</dd></div>
                <div><dt>执行接入</dt><dd data-testid="p03-detail-admission">{{ selectedTask.executionAdmission }}（非执行放行）</dd></div>
              </dl>
              <div class="task-section">
                <h3>资料缺口（服务端字段级）</h3>
                <ul v-if="selectedTask.readinessIssues.length" class="checklist">
                  <li v-for="(issue, index) in selectedTask.readinessIssues" :key="`${issue.stage}:${issue.field}:${issue.code}:${index}`" data-testid="p03-detail-issue" :data-field="issue.field" :data-code="issue.code">
                    <span class="rail-dot first" aria-hidden="true"></span>{{ issue.stage }} · {{ issue.field }} · {{ issue.code }}：{{ issue.message }}
                  </li>
                </ul>
                <p v-else class="muted small">服务端未报告资料缺口。</p>
              </div>
              <div class="task-section">
                <h3>下一步（仅文字提示）</h3>
                <ul v-if="selectedTask.readinessIssues.length" class="checklist">
                  <li v-for="(issue, index) in selectedTask.readinessIssues" :key="`hint:${issue.stage}:${issue.field}:${index}`">{{ issue.hint }}</li>
                </ul>
                <p v-else class="muted small">当前无可回溯的下一步，需查领域权威。</p>
              </div>
            </template>
            <p v-else class="muted small" data-testid="p03-detail-empty">未选择任务；详情只展示当前项目真实任务，不填充示例。</p>
          </section>
        </template>
        <template v-else>
          <section v-if="selectedMemberId || selectedGroupId" class="panel side-panel conversation-panel" aria-labelledby="conversation-title" data-testid="p02-conversation">
            <div class="side-heading"><h2 id="conversation-title">群内检查器<span class="real-chip">仅 Boardroom 消息</span></h2><button type="button" class="inspector-close" aria-label="关闭会话检查器" @click="closeConversation"><AppIcon name="close" :size="16" /></button></div>
            <div class="conv-person"><span class="avatar conv-avatar" :class="`avatar-${selectedNode?.avatar ?? 0}`">{{ selectedNode?.initials ?? '群' }}</span><span class="conv-person-copy"><strong>{{ inspectorState?.memberName ?? inspectorState?.groupName ?? '未选择' }}</strong><small>{{ inspectorState?.memberName ? `${inspectorState?.groupName} · ` : '' }}真实群绑定 · 未接入宿主完整会话</small></span><span v-if="selectedNode" class="status-badge" :class="selectedNode.tone === 'active' ? 'active' : selectedNode.tone === 'wait' ? 'wait' : 'ok'">{{ selectedNode.status }}</span></div>
            <button type="button" class="conv-task" aria-disabled="true" title="阶段 2 未接通" @click="explainUnavailable('当前任务')"><span class="conv-task-icon"><AppIcon name="layers" :size="16" /></span><span>当前任务：未接入（阶段 2）</span><AppIcon name="chevron" :size="14" /></button>
            <p class="conv-sync muted small">仅展示已持久保存且允许读取的 Boardroom 群消息：发送者、正文、来源消息 ID 与时间。UI 阅读标记不代表业务送达、领取或完成。</p>
            <div class="conv-tabs" role="tablist" aria-label="群内检查器内容"><button type="button" role="tab" aria-selected="true">会话</button><button type="button" role="tab" aria-selected="false" aria-disabled="true" @click="explainUnavailable('活动')">活动（未接通）</button><button type="button" role="tab" aria-selected="false" aria-disabled="true" @click="explainUnavailable('产物')">产物（未接通）</button></div>
            <p v-if="inspectorLoading" class="muted small" role="status" data-testid="p02-inspector-loading">正在读取该群已保存的 Boardroom 消息…</p>
            <p v-else-if="inspectorError" class="error small" role="alert" data-testid="p02-inspector-error">该群消息暂不可读：{{ inspectorError }}（不跨群取用其他内容）</p>
            <p v-else-if="inspectorMessages.length === 0" class="muted small" data-testid="p02-inspector-empty">该群暂无已保存且可读取的 Boardroom 消息。</p>
            <div v-else class="conv-messages" data-testid="p02-inspector-messages">
              <div v-for="msg in inspectorMessages" :key="msg.id" class="conv-msg" :data-message-id="msg.id">
                <span class="avatar avatar-sm" :class="`avatar-${(msg.senderMemberId.charCodeAt(0) % 6) + 1}`">{{ msg.sender.slice(0, 1) }}</span>
                <div class="conv-msg-body">
                  <div class="conv-msg-meta"><strong>{{ msg.sender }}</strong><span class="conv-tag">{{ messageTime(msg.createdAt) }}</span></div>
                  <p class="conv-bubble">{{ msg.text }}</p>
                  <small class="conv-source">来源消息 ID：{{ msg.id }} · 发送者 ID：{{ msg.senderMemberId }} · 群 {{ inspectorState?.groupName }}</small>
                </div>
              </div>
            </div>
            <button type="button" class="conv-locate" aria-disabled="true" title="阶段 2 未接通" @click="explainUnavailable('定位消息')">定位消息（阶段 2 未接通）</button>
            <div class="conv-footer"><span>仅 Boardroom 消息 · 不含宿主完整会话</span><button type="button" aria-disabled="true" title="阶段 2 未接通" @click="explainUnavailable('展开完整会话')">展开完整会话（未接通）</button></div>
          </section>
          <template v-else>
          <section class="panel side-panel" aria-labelledby="activity-title">
            <div class="side-heading"><h2 id="activity-title">实时动态<span class="real-chip">真实消息</span></h2><button type="button" class="follow-toggle" aria-pressed="true" @click="explainUnavailable('自动跟随')"><span aria-hidden="true"></span>自动跟随</button></div>
            <p v-if="graph.recent.length === 0" class="muted small" data-testid="p01-activity-empty">当前项目暂无真实消息。</p>
            <ul v-else class="activity-list" data-testid="p01-activity-list"><li v-for="(item, index) in graph.recent" :key="item.id" :data-message-id="item.id" :title="`消息 ID ${item.id} · ${item.createdAt}`"><span class="activity-rail" aria-hidden="true"><span class="rail-dot" :class="{ first: index === 0 }"></span></span><span class="activity-copy"><small>{{ recentActivity(item.createdAt) }} · {{ item.groupName }}</small><span class="activity-bubble"><span class="avatar avatar-sm" :class="`avatar-${item.avatarSeed}`">{{ item.sender.slice(0, 1) }}</span>{{ item.sender }}：{{ item.text }}</span></span></li></ul>
          </section>
          <section class="panel side-panel" aria-labelledby="pending-title">
            <div class="side-heading"><h2 id="pending-title">待我处理<span class="demo-chip">示例数据</span></h2></div>
            <div class="pending-list"><div v-for="item in demoPending" :key="item.title" class="pending-card"><span class="pending-icon"><AppIcon name="check" :size="18" /></span><span class="pending-copy"><strong>{{ item.title }}</strong><small>{{ item.detail }}</small></span><span class="pending-link">查看事项<AppIcon name="arrow" :size="14" /></span></div></div>
          </section>
          <section class="quick-access" aria-labelledby="quick-access-title"><h2 id="quick-access-title">继续工作</h2><RouterLink to="/chat" class="shortcut"><span class="shortcut-icon"><AppIcon name="message" :size="21" /></span><span><strong>进入群聊</strong><small>与成员交流，让工作继续</small></span><AppIcon name="chevron" :size="16" /></RouterLink><RouterLink to="/status" class="shortcut"><span class="shortcut-icon"><AppIcon name="activity" :size="21" /></span><span><strong>查看成员状态</strong><small>了解谁在线、谁正在工作</small></span><AppIcon name="chevron" :size="16" /></RouterLink></section>
          </template>
        </template>
      </aside>
    </div>
    <details class="service-details"><summary><span class="service-title"><AppIcon name="server" :size="18" />本地服务</span><span class="service-state" :class="healthError || health?.status === 'degraded' ? 'bad' : health ? 'ok' : 'muted'">{{ serviceLabel }}</span></summary><div class="service-body"><p class="muted small">{{ wsLabel }}。此处显示服务连接情况，成员的工作状态请查看状态看板。</p><p v-if="healthError" class="error" role="alert">健康检查失败：{{ healthError }}</p><dl class="service-grid"><div><dt>数据库</dt><dd>{{ healthError ? '连接未知' : !health ? '正在检查…' : health.database.writable ? '可读写' : '需要检查' }}</dd></div><div><dt>运行时长</dt><dd>{{ health ? uptime(health.uptimeSeconds) : '—' }}</dd></div><div><dt>数据库版本</dt><dd>{{ health?.migrations.version ?? '—' }}</dd></div><div><dt>心跳间隔 / 超时</dt><dd>{{ health ? `${health.heartbeat.intervalMs / 1000}s / ${health.heartbeat.timeoutMs / 1000}s` : '—' }}</dd></div></dl><details v-if="lastEvent" class="event-details"><summary>最近连接事件</summary><pre>{{ lastEvent }}</pre></details></div></details>
  </section>
</template>

<style scoped>
.header-title { display: flex; align-items: center; gap: 14px; min-width: 0; }
.page-icon { width: 50px; height: 50px; flex: none; display: grid; place-items: center; border-radius: 12px; background: var(--surface-subtle); color: var(--fg); }
.header-title h1 { margin: 0; font-size: 2rem; line-height: 1.25; }
.collab-header { align-items: flex-end; margin-bottom: 18px; }
.collab-header-meta { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; justify-content: flex-end; }
.scope-control { min-height: 36px; padding: .3rem .7rem; }
.connected-state { display: inline-flex; align-items: center; gap: 7px; font-size: .82rem; color: var(--muted); white-space: nowrap; }.connected-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--relation); }.connected-state.ok .connected-dot { background: var(--ok); }.connected-state.bad .connected-dot { background: var(--bad); }.connected-state.muted .connected-dot { background: var(--muted); }
.collab-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; background: transparent; border: 0; border-radius: 0; padding: 0; margin: 0 0 18px; box-shadow: none; }
.toolbar-control[aria-disabled="true"], .view-tab[aria-disabled="true"], .graph-controls button[aria-disabled="true"] { cursor: not-allowed; color: var(--muted); }
.toolbar-views, .toolbar-layers { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border); border-radius: 9px; padding: 3px; background: var(--surface-subtle); }
.view-tab { min-height: 30px; padding: .2rem .8rem; font-size: .85rem; border-color: transparent; background: transparent; }.view-tab[aria-pressed="true"] { color: var(--fg); background: var(--card-bg); border-color: var(--border); }
.layer-option { display: inline-flex; align-items: center; gap: 6px; font-size: .85rem; color: var(--fg); white-space: nowrap; cursor: pointer; padding: 0 .4rem; }
.collab-status { margin: 0 0 16px; overflow-wrap: anywhere; }
.collab-workspace { display: grid; grid-template-columns: minmax(0,1fr) minmax(260px,320px); gap: 24px; align-items: start; }
.collab-main, .collab-side { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
.graph-panel { min-height: 0; display: flex; flex-direction: column; padding: 16px; border-radius: 12px; }.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 9px; }.section-heading h2 { margin: 0; font-size: 1.02rem; }
.demo-chip { display: inline-block; margin-left: 8px; padding: 2px 7px; border-radius: 5px; background: var(--accent-soft); color: var(--accent); font-size: .68rem; font-weight: 600; vertical-align: middle; }
.real-chip { display: inline-block; margin-left: 8px; padding: 2px 7px; border-radius: 5px; background: color-mix(in srgb, var(--ok) 12%, transparent); color: var(--ok); font-size: .68rem; font-weight: 600; vertical-align: middle; }
.graph-empty { margin: 0; padding: 30px 16px; border: 1px dashed var(--border); border-radius: 10px; font-size: .86rem; line-height: 1.7; text-align: center; overflow-wrap: anywhere; }.graph-empty a { color: var(--accent); }
.graph-canvas { flex: none; display: block; height: auto; min-height: 0; border: 0; border-radius: 0; background: transparent; padding: 0; overflow: visible; }
.avatar:not(.avatar-0)::after { content: ""; position: absolute; right: -1px; bottom: -1px; width: 9px; height: 9px; border-radius: 50%; background: var(--ok); border: 2px solid var(--card-bg); }
.status-badge { flex: none; font-size: .7rem; padding: 2px 7px; border-radius: 20px; white-space: nowrap; font-weight: 600; }
.status-badge.ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }.status-badge.active { color: var(--accent); background: var(--accent-soft); }.status-badge.wait { color: var(--warn); background: color-mix(in srgb, var(--warn) 10%, transparent); }
.graph-canvas :deep(.graph-canvas-shell) { min-height: 0; }
.graph-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; margin-top: 14px; }
.graph-layer-status { margin: 0; font-size: .78rem; overflow-wrap: anywhere; }
.pause-control { min-height: 30px; padding: .15rem .65rem; font-size: .8rem; }
.graph-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; list-style: none; margin: 0; padding: 0; font-size: .8rem; color: var(--muted); }.graph-legend li { display: inline-flex; align-items: center; gap: 6px; }
.legend-line { width: 22px; height: 0; border-top: 2px solid var(--relation); }.legend-arrow { position: relative; }.legend-arrow::after { content: "›"; position: absolute; right: -4px; top: -11px; font-size: 1rem; color: var(--relation); }.legend-dot { width: 8px; height: 8px; border-radius: 50%; }.legend-dot.ok { background: var(--ok); }
.graph-controls { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 8px; }.graph-controls button { min-height: 34px; padding: .25rem .65rem; font-size: .84rem; }.zoom-value { color: var(--muted); font-size: .82rem; font-variant-numeric: tabular-nums; }
.real-data-fold { border: 1px solid var(--border); border-radius: 11px; background: var(--card-bg); overflow: hidden; }.real-data-fold > summary { padding: 13px 16px; font-size: .82rem; color: var(--muted); cursor: pointer; }.real-data-fold > summary:hover { color: var(--fg); }.real-data-fold .overview-metrics, .real-data-fold .project-overview { margin: 0; border-radius: 0; border: 0; box-shadow: none; border-top: 1px solid var(--border); }
.overview-metrics { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); padding: 20px 0; }.overview-metrics > div { padding: 0 24px; }.overview-metrics > div + div { border-left: 1px solid var(--border); }.overview-metrics dt { font-size: .85rem; color: var(--muted); }.overview-metrics dd { margin: 5px 0 3px; font-size: 2rem; font-weight: 600; line-height: 1.3; font-variant-numeric: tabular-nums; }.overview-metrics span { font-size: .76rem; color: var(--muted); }
.project-overview { padding: 16px; }.home-projects { list-style: none; margin: 0; padding: 0; }.home-projects li + li { border-top: 1px solid var(--border); }.home-project-link { display: flex; gap: 12px; align-items: center; padding: 14px 8px; border-radius: 8px; color: var(--fg); }.home-project-link:hover { background: var(--surface-subtle); text-decoration: none; }.project-monogram { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 9px; color: var(--accent); background: var(--accent-soft); font-weight: 600; flex: none; }.project-copy { flex: 1; min-width: 0; }.project-copy strong { display: block; font-size: .9rem; }.project-copy > span { display: block; color: var(--muted); font-size: .78rem; margin-top: 3px; }.project-activity { text-align: right; flex: none; }.project-activity small { display: block; margin-top: 4px; color: var(--muted); font-size: .72rem; }.badge { font-size: .7rem; padding: 2px 8px; border-radius: 20px; background: var(--surface-subtle); color: var(--muted); }.badge.ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }.loading-state, .empty-state { padding: 30px 8px; }.empty-state h3 { font-size: .95rem; margin: 0 0 6px; }.empty-state p { font-size: .82rem; color: var(--muted); margin: 0; }
.side-panel h2 { font-size: 1.02rem; margin: 0; }.side-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }.follow-toggle { display: inline-flex; align-items: center; gap: 7px; border: 0; background: transparent; color: var(--muted); font-size: .72rem; min-height: 0; padding: 2px 0; }.follow-toggle > span { width: 28px; height: 16px; border-radius: 20px; background: var(--accent-fill); position: relative; }.follow-toggle > span::after { content: ""; position: absolute; top: 2px; right: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; }
.activity-list { list-style: none; margin: 14px 0 0; padding: 0; }.activity-list li { display: flex; gap: 10px; padding-bottom: 14px; }.activity-rail { flex: none; position: relative; width: 10px; display: flex; justify-content: center; }.activity-rail::before { content: ""; position: absolute; top: 4px; bottom: -14px; width: 2px; background: var(--border); }.activity-list li:last-child .activity-rail::before { display: none; }.rail-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border); position: relative; z-index: 1; }.rail-dot.first { background: var(--accent); }.activity-copy { flex: 1; min-width: 0; }.activity-copy > small { font-size: .7rem; color: var(--muted); }.activity-bubble { display: flex; align-items: center; gap: 7px; margin-top: 5px; padding: 9px 10px; border: 1px solid var(--border); border-radius: 9px; background: var(--card-bg); font-size: .78rem; overflow-wrap: anywhere; }
.pending-list { margin-top: 14px; }.pending-card { display: flex; align-items: center; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--card-bg); }.pending-icon { color: var(--ok); display: inline-flex; }.pending-copy { flex: 1; min-width: 0; }.pending-copy strong { display: block; font-size: .82rem; }.pending-copy small { display: block; font-size: .72rem; color: var(--muted); margin-top: 2px; }.pending-link { font-size: .72rem; color: var(--accent); display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.quick-access { padding: 6px 0; }.quick-access h2 { font-size: 1.02rem; margin-bottom: 10px; }.shortcut { display: flex; align-items: center; gap: 13px; padding: 14px 0; color: var(--fg); border-bottom: 1px solid var(--border); }.shortcut:hover { color: var(--accent); text-decoration: none; }.shortcut-icon { color: var(--muted); }.shortcut > span:nth-child(2) { flex: 1; min-width: 0; }.shortcut strong { display: block; font-weight: 500; font-size: .9rem; }.shortcut small { display: block; color: var(--muted); font-size: .78rem; margin-top: 3px; }.shortcut > .app-icon { color: var(--muted); }.quick-note { color: var(--muted); font-size: .78rem; margin-top: 16px; }
.service-details { margin-top: 30px; border: 1px solid var(--border); border-radius: 11px; background: var(--card-bg); }.service-details > summary { padding: 16px 20px; font-size: .85rem; }.service-title { display: inline-flex; align-items: center; gap: 10px; margin-left: 6px; }.service-state { float: right; font-size: .8rem; font-weight: 400; }.service-body { border-top: 1px solid var(--border); padding: 18px 24px; }.service-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 16px; margin: 20px 0 0; }.service-grid dt { font-size: .8rem; color: var(--muted); }.service-grid dd { margin: 6px 0 0; font-size: .9rem; }.event-details { margin-top: 20px; font-size: .8rem; }.event-details pre { max-height: 150px; overflow: auto; }
.task-select-label { font-size: .84rem; color: var(--muted); }
.taskflow-panel { padding: 16px; }.board-scope { min-width: 0; overflow-wrap: anywhere; white-space: nowrap; }
@media (max-width: 1200px) { .board-scope { white-space: normal; } }
.task-detail-title { display: flex; align-items: center; gap: 10px; margin: 16px 0; padding-bottom: 14px; border-bottom: 1px solid var(--border); }.task-detail-title strong { flex: 1; font-size: .96rem; overflow-wrap: anywhere; }
.task-facts { margin: 0; }.task-facts > div { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--border); font-size: .82rem; }.task-facts dt { display: flex; align-items: center; gap: 7px; width: 96px; flex: none; color: var(--muted); }.task-facts dd { margin: 0; font-weight: 500; }
.task-section { margin-top: 18px; }.task-section h3 { margin: 0 0 10px; font-size: .88rem; }.checklist { list-style: none; margin: 0; padding: 0; }.checklist li { display: flex; align-items: flex-start; gap: 9px; padding: 6px 0; font-size: .82rem; overflow-wrap: anywhere; }.checkbox { width: 15px; height: 15px; border: 1px solid var(--control-border); border-radius: 4px; flex: none; }
.conv-person { display: flex; align-items: center; gap: 9px; margin: 16px 0 12px; flex-wrap: wrap; }.conv-avatar { width: 40px; height: 40px; font-size: 1rem; }.conv-person-copy { flex: 1; min-width: 0; }.conv-person-copy strong { display: block; font-size: .96rem; }.conv-person-copy small { display: block; font-size: .74rem; color: var(--muted); margin-top: 3px; }.conv-online { display: inline-flex; align-items: center; gap: 5px; font-size: .74rem; color: var(--ok); }
.conv-task { width: 100%; display: flex; align-items: center; gap: 9px; padding: 10px 11px; border: 1px solid var(--border); border-radius: 9px; background: var(--card-bg); color: var(--fg); font-size: .8rem; text-align: left; }.conv-task-icon { color: var(--muted); }.conv-task > span:nth-child(2) { flex: 1; }.conv-sync { margin: 8px 0 0; }
.conv-tabs { display: flex; gap: 22px; margin-top: 14px; border-bottom: 1px solid var(--border); }.conv-tabs button { border: 0; border-radius: 0; background: transparent; padding: 8px 0; font-size: .84rem; color: var(--muted); min-height: 0; }.conv-tabs button[aria-selected="true"] { color: var(--fg); font-weight: 600; box-shadow: inset 0 -2px var(--accent); }
.conv-day { text-align: center; font-size: .72rem; color: var(--muted); margin: 16px 0; position: relative; }.conv-day::before, .conv-day::after { content: ""; position: absolute; top: 50%; width: 28%; height: 1px; background: var(--border); }.conv-day::before { left: 0; }.conv-day::after { right: 0; }
.conv-messages { display: flex; flex-direction: column; gap: 16px; }.conv-msg { display: flex; align-items: flex-start; gap: 9px; }.conv-msg.mine { justify-content: flex-end; }.conv-msg-body { flex: 1; min-width: 0; max-width: 85%; }.conv-msg.mine .conv-msg-body { flex: none; }.conv-msg-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; font-size: .8rem; }.conv-msg-meta.right { justify-content: flex-end; }.conv-tag { font-size: .68rem; color: var(--muted); background: var(--surface-subtle); padding: 1px 6px; border-radius: 4px; }.conv-bubble { display: inline-block; margin: 0; padding: 9px 11px; border: 1px solid var(--border); border-radius: 10px; background: var(--card-bg); font-size: .82rem; line-height: 1.5; overflow-wrap: anywhere; }.conv-bubble.mine { background: var(--accent-soft); border-color: transparent; }.conv-source { display: block; margin-top: 6px; font-size: .7rem; color: var(--muted); overflow-wrap: anywhere; }.conv-locate { border: 0; background: transparent; padding: 0; cursor: pointer; }.conv-locate[aria-disabled="true"] { color: var(--muted); cursor: not-allowed; }
.conv-new { align-self: center; margin: 6px auto 0; padding: 6px 14px; font-size: .78rem; color: var(--accent); background: var(--accent-soft); border-color: transparent; border-radius: 20px; }.conv-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); font-size: .78rem; }.conv-footer > span { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }.conv-footer button { border: 0; background: transparent; color: var(--accent); font-size: .78rem; min-height: 0; padding: 0; }
@media (max-width: 1100px) { .collab-workspace { grid-template-columns: 1fr; gap: 20px; }.collab-side { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); align-items: start; gap: 16px; }.collab-side .quick-access { grid-column: 1 / -1; } }
@media (max-width: 760px) {
  .collab-workspace { gap: 16px; }.collab-main, .collab-side { gap: 16px; }.collab-side { display: flex; flex-direction: column; }
  .collab-toolbar { padding: 10px 12px; gap: 8px 10px; }.toolbar-views, .toolbar-layers { flex-wrap: wrap; }
  .collab-header-meta { justify-content: flex-start; }
  .graph-canvas { height: auto; min-height: 0; padding: 0; }.graph-footer { align-items: flex-start; }
  .overview-metrics { padding: 18px 0; }.overview-metrics > div { padding: 0 14px; }.overview-metrics dd { font-size: 1.7rem; }.overview-metrics span { display: none; }.overview-metrics dt { font-size: .78rem; }
  .service-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }.project-activity small { display: none; }
  .service-details > summary { padding: 14px; }.service-body { padding: 16px; }
}
</style>
