<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import AppIcon from "../components/AppIcon.vue";
import { projectPath, useCurrentProject } from "../composables/useCurrentProject.ts";
import { useCollabGraph } from "../composables/useCollabGraph.ts";
interface HealthReport {
  status: "ok" | "degraded"; uptimeSeconds: number; serverTime: string;
  database: { status: string; writable: boolean; error?: string };
  migrations: { version: number; applied: number; pending: number };
  heartbeat: { intervalMs: number; timeoutMs: number }; webui: { built: boolean };
}

// 中央关系图来自真实只读 API（useCollabGraph）：节点=真实成员/群，边来源=真实消息发送者。
// 空数据即空图，不注入示例节点。顶部“已连接”与底部“本地服务”来自 /api/health 与 /ws。
const health = ref<HealthReport | null>(null);
const healthError = ref<string | null>(null);
const context = useCurrentProject();
const collabGraph = useCollabGraph(context.currentProjectId);
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
const expandedEdge = ref<string | null>(null);
const selectedGroupId = ref<string | null>(null);
const activeView = ref<"members" | "tasks" | "capabilities">("members");
const taskColumns = [
  { state: "todo", label: "待办" }, { state: "in-progress", label: "进行中" },
  { state: "review", label: "评审中" }, { state: "blocked", label: "受阻" }, { state: "done", label: "已完成" },
] as const;
function tasksFor(state: string) { return collabGraph.graph.value.tasks.filter((t) => t.state === state); }
const selectedConversation = computed(() => collabGraph.graph.value.conversations.find((c) => c.groupId === selectedGroupId.value) ?? null);
function toggleEdge(id: string): void { expandedEdge.value = expandedEdge.value === id ? null : id; }
function openInspector(groupId: string): void { selectedGroupId.value = selectedGroupId.value === groupId ? null : groupId; }
function closeInspector(): void { selectedGroupId.value = null; }
function explainUnavailable(label: string): void {
  unavailableReason.value = `「${label}」尚未接通真实交互，等待协作读模型后续实现。`;
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
  await collabGraph.load();
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
watch(context.currentProjectId, () => {
  if (disposed) return;
  selectedGroupId.value = null;
  expandedEdge.value = null;
  void collabGraph.load();
});
onMounted(() => { void refresh(); connect(); healthTimer = setInterval(() => void refreshHealth(), 15000); });
onUnmounted(() => { disposed = true; socket?.close(); if (healthTimer) clearInterval(healthTimer); if (reconnectTimer) clearTimeout(reconnectTimer); });
</script>

<template>
  <section class="page home-page">
    <p class="demo-banner" role="note" data-testid="p01-demo-banner"><AppIcon name="layers" :size="15" />本页关系图由当前项目的真实数据生成（成员、群、状态、消息均来自本地服务）；没有数据时显示空图，不注入示例。</p>
    <nav class="collab-breadcrumb" aria-label="当前位置"><RouterLink to="/">工作台</RouterLink><span aria-hidden="true"> / </span><span>{{ context.currentProject.value?.name ?? 'Boardroom' }}</span></nav>
    <header class="page-header collab-header">
      <div><h1>协作总览</h1><p class="page-description">{{ collabGraph.graph.value.groups.length }} 个群组 · {{ collabGraph.graph.value.memberCount }} 位成员 · {{ collabGraph.graph.value.messageCount }} 条消息</p></div>
      <div class="collab-header-meta">
        <button type="button" class="toolbar-control scope-control" aria-disabled="true" title="范围切换尚未接通" data-testid="p01-scope" @click="explainUnavailable('范围切换')">范围：{{ context.currentProject.value?.name ?? '全部项目' }}<AppIcon name="chevron" :size="14" /></button>
        <span class="connected-state" :class="healthError || health?.status === 'degraded' ? 'bad' : health ? 'ok' : 'muted'" data-testid="p01-connected"><span class="connected-dot" aria-hidden="true"></span>{{ connectedLabel }}</span>
      </div>
    </header>
    <div v-if="projectError" class="error" role="alert">项目暂时无法加载：{{ projectError }} <button type="button" class="text-button" :disabled="refreshing" @click="refresh">重新加载</button></div>

    <section class="collab-toolbar" aria-label="协作总览工具条">
      <div class="toolbar-views" role="group" aria-label="视图切换">
        <button type="button" class="view-tab" :aria-pressed="activeView === 'members'" @click="activeView = 'members'">成员关系</button>
        <button type="button" class="view-tab" :aria-pressed="activeView === 'tasks'" @click="activeView = 'tasks'">任务流转</button>
        <button type="button" class="view-tab" :aria-pressed="activeView === 'capabilities'" @click="activeView = 'capabilities'">角色与能力</button>
      </div>
      <div class="toolbar-layers" role="group" aria-label="关系图层，静态演示">
        <label class="layer-option"><input type="checkbox" checked aria-disabled="true" @click.prevent="explainUnavailable('协作关系图层')" />协作关系</label>
        <label class="layer-option"><input type="checkbox" checked aria-disabled="true" title="消息方向来自真实消息发送者，见画布下方标记" @click.prevent="explainUnavailable('消息方向图层')" />消息方向</label>
      </div>
      <button type="button" class="toolbar-control filter-control" aria-disabled="true" title="成员筛选是静态演示控件" @click="explainUnavailable('成员筛选')">全部成员<AppIcon name="chevron" :size="14" /></button>
    </section>
    <p v-if="unavailableReason" class="collab-status muted small" role="status" data-testid="p01-unconnected-status">{{ unavailableReason }}</p>

    <div class="collab-workspace">
      <div class="collab-main">
        <section v-if="activeView === 'members'" class="panel graph-panel" aria-labelledby="graph-title">
          <div class="section-heading"><div><h2 id="graph-title">协作关系图<span class="demo-chip real-chip">真实数据</span></h2></div></div>
          <div class="graph-canvas" data-testid="p01-graph-canvas">
            <div v-if="collabGraph.loading.value" class="graph-loading muted small" role="status">正在读取协作关系…</div>
            <p v-else-if="collabGraph.error.value" class="error" role="alert">关系图读取失败：{{ collabGraph.error.value }}</p>
            <div v-else-if="!collabGraph.graph.value.groups.length && !collabGraph.graph.value.root && !collabGraph.graph.value.lead" class="graph-empty" data-testid="p01-graph-empty">
              <AppIcon name="layers" :size="30" />
              <strong>当前项目还没有可展示的协作关系</strong>
              <p>为项目添加成员、创建群组并产生消息后，这里会按真实数据生成关系图。此处不注入示例节点。</p>
              <RouterLink v-if="context.currentProjectId" :to="projectPath(context.currentProjectId.value!, 'overview')" class="secondary">管理这个项目<AppIcon name="arrow" :size="15" /></RouterLink>
            </div>
            <div v-else class="demo-tree" role="group" :aria-label="`按项目真实数据组织的归属层级：${collabGraph.graph.value.groups.length} 个群组，${collabGraph.graph.value.memberCount} 位成员，${collabGraph.graph.value.messageCount} 条消息。节点来自真实成员与群，连线表示群成员归属，消息方向见下方由真实发送者生成的箭头。`">
              <div v-if="collabGraph.graph.value.root" class="tree-node root-node">
                <span class="avatar avatar-0"><AppIcon name="message" :size="17" /></span>
                <strong>{{ collabGraph.graph.value.root.name }}</strong><small>{{ collabGraph.graph.value.root.role }}</small>
              </div>
              <div v-if="collabGraph.graph.value.root || collabGraph.graph.value.lead" class="tree-stem" aria-hidden="true"></div>
              <div v-if="collabGraph.graph.value.lead" class="tree-node lead-node">
                <span class="avatar" :class="`avatar-${collabGraph.graph.value.lead.avatarSeed}`">{{ collabGraph.graph.value.lead.initials }}</span>
                <span><strong>{{ collabGraph.graph.value.lead.name }}</strong><small>{{ collabGraph.graph.value.lead.role }}</small></span>
                <span class="status-badge" :class="collabGraph.graph.value.lead.tone">{{ collabGraph.graph.value.lead.status }}</span>
              </div>
              <div v-if="collabGraph.graph.value.lead && collabGraph.graph.value.groups.length" class="tree-stem" aria-hidden="true"></div>
              <div class="tree-groups">
                <div v-for="group in collabGraph.graph.value.groups" :key="group.id" class="tree-group">
                  <button type="button" class="tree-group-head group-open-btn" :aria-pressed="selectedGroupId === group.id" aria-controls="p01-inspector" :title="`查看「${group.name}」的真实会话`" @click="openInspector(group.id)"><span class="group-icon"><AppIcon :name="group.icon" :size="16" /></span><strong>{{ group.name }}</strong><span class="group-count">{{ group.members.length }} 人</span><AppIcon name="chevron" :size="14" /></button>
                  <div class="group-body">
                    <template v-for="(member, index) in group.members" :key="member.id">
                      <div v-if="index > 0" class="member-connector" aria-hidden="true"></div>
                      <div class="member-row">
                        <span class="avatar" :class="`avatar-${member.avatarSeed}`">{{ member.initials }}</span>
                        <span class="member-copy"><strong>{{ member.name }}</strong><small>{{ member.role }}</small></span>
                        <span class="status-badge" :class="member.tone">{{ member.status }}</span>
                      </div>
                    </template>
                    <p v-if="!group.members.length" class="group-empty muted small">该群暂无成员</p>
                  </div>
                  <div class="group-flow"><span class="flow-arrow" aria-hidden="true">→</span>真实消息 {{ group.messageCount }} 条 · {{ group.senderCount }} 位发送者</div>
                </div>
              </div>
            </div>
            <div v-if="collabGraph.graph.value.messageEdges.length" class="message-arrow-layer" data-testid="p01-message-arrows">
              <h3 class="message-arrow-title">消息方向<span class="side-demo-tag real-tag">真实消息 · 每条可追溯</span></h3>
              <ul class="message-arrow-list">
                <li v-for="edge in collabGraph.graph.value.messageEdges" :key="edge.id" class="message-arrow-item">
                  <button type="button" class="message-arrow-btn" :aria-expanded="expandedEdge === edge.id" @click="toggleEdge(edge.id)">
                    <span class="arrow-from"><span class="avatar avatar-sm" :class="`avatar-${edge.avatarSeed}`">{{ edge.sender.slice(0, 1) }}</span>{{ edge.sender }}</span>
                    <span class="arrow-dir" aria-hidden="true">→</span>
                    <span class="arrow-to">{{ edge.groupName }}</span>
                    <span class="arrow-time">{{ recentActivity(edge.createdAt) }}</span>
                    <span class="arrow-id" :title="`消息逻辑 ID：${edge.id}`">#{{ edge.id.slice(-6) }}</span>
                  </button>
                  <p v-if="expandedEdge === edge.id" class="message-arrow-detail"><span class="muted small">来源消息 {{ edge.id }}：</span>{{ edge.text }}</p>
                </li>
              </ul>
              <p class="message-arrow-note muted small">箭头方向来自真实消息发送者 → 所属群，最多显示 6 条；历史/补发不伪装为实时。</p>
            </div>
            <div v-if="selectedConversation" id="p01-inspector" class="inspector" role="region" :aria-label="`${selectedConversation.groupName} 的真实会话`" data-testid="p01-inspector">
              <div class="inspector-head"><h3><AppIcon name="message" :size="16" />{{ selectedConversation.groupName }}<span class="side-demo-tag real-tag">真实会话</span></h3><button type="button" class="inspector-close" aria-label="关闭会话检查器" @click="closeInspector"><AppIcon name="close" :size="16" /></button></div>
              <p class="inspector-note muted small">严格对应本群的真实记录，按来源时间显示；无 transcript 不编造工具或思考，切换节点即取消旧选择。</p>
              <ul v-if="selectedConversation.messages.length" class="inspector-messages">
                <li v-for="msg in selectedConversation.messages" :key="msg.id" class="inspector-msg">
                  <span class="avatar avatar-sm" :class="`avatar-${msg.avatarSeed}`">{{ msg.sender.slice(0, 1) }}</span>
                  <span class="inspector-msg-body"><span class="inspector-msg-meta"><strong>{{ msg.sender }}</strong><time :datetime="msg.createdAt">{{ recentActivity(msg.createdAt) }}</time></span><span class="inspector-msg-text">{{ msg.text }}</span><span class="inspector-msg-id">来源 {{ msg.id }}</span></span>
                </li>
              </ul>
              <p v-else class="muted small inspector-empty">该群暂无真实消息记录。</p>
            </div>
          </div>
          <div class="graph-footer">
            <ul class="graph-legend" aria-label="关系图图例"><li><span class="legend-line" aria-hidden="true"></span>群成员归属</li><li><span class="legend-line legend-arrow" aria-hidden="true"></span>消息方向</li><li><span class="legend-dot ok" aria-hidden="true"></span>连接正常</li><li class="legend-note">协作/依赖边尚未接入读模型</li></ul>
            <div class="graph-controls" role="group" aria-label="画布操作，静态演示">
              <button type="button" aria-label="缩小画布，静态演示" aria-disabled="true" title="静态演示控件" @click="explainUnavailable('缩小画布')">−</button>
              <span class="zoom-value">100%</span>
              <button type="button" aria-label="放大画布，静态演示" aria-disabled="true" title="静态演示控件" @click="explainUnavailable('放大画布')">+</button>
              <button type="button" aria-label="适应画布，静态演示" aria-disabled="true" title="静态演示控件" @click="explainUnavailable('适应画布')">适应画布</button>
            </div>
          </div>
        </section>
        <section v-else-if="activeView === 'tasks'" class="panel taskflow-panel" aria-labelledby="taskflow-title" data-testid="p01-taskflow">
          <div class="section-heading"><div><h2 id="taskflow-title">任务流转<span class="demo-chip real-chip">真实数据</span></h2><p class="muted small">按真实任务状态分列；readiness 为资料观察，不代表执行放行。</p></div></div>
          <p v-if="collabGraph.loading.value" class="muted small" role="status">正在读取任务…</p>
          <p v-else-if="collabGraph.error.value" class="error" role="alert">任务读取失败：{{ collabGraph.error.value }}</p>
          <div v-else-if="!collabGraph.graph.value.tasks.length" class="taskflow-empty">
            <AppIcon name="grid" :size="30" />
            <strong>当前项目暂无任务</strong>
            <p>任务创建后会按真实状态显示在各列。此处不注入示例任务。</p>
          </div>
          <div v-else class="taskflow-board">
            <div v-for="column in taskColumns" :key="column.state" class="taskflow-column">
              <h3 class="taskflow-col-title">{{ column.label }}<span class="taskflow-col-count">{{ tasksFor(column.state).length }}</span></h3>
              <div v-for="task in tasksFor(column.state)" :key="task.id" class="taskflow-card">
                <strong class="taskflow-card-title">{{ task.title }}</strong>
                <span v-if="task.assignee" class="taskflow-card-assignee"><span class="avatar avatar-sm avatar-6">{{ task.assignee.slice(0, 1) }}</span>{{ task.assignee }}</span>
                <span v-else class="taskflow-card-assignee muted">未指派</span>
                <p v-if="task.blockedReason" class="taskflow-card-blocked">受阻：{{ task.blockedReason }}</p>
                <div v-if="task.readinessCodes.length" class="taskflow-card-readiness">
                  <span v-for="code in task.readinessCodes" :key="code" class="readiness-chip">{{ code }}</span>
                </div>
                <span class="taskflow-card-id" :title="`任务 ID：${task.id}`">#{{ task.id.slice(-6) }} · r{{ task.revision }}</span>
              </div>
              <p v-if="!tasksFor(column.state).length" class="taskflow-col-empty muted small">无</p>
            </div>
          </div>
          <p class="taskflow-note muted small">负责人、阶段、readiness 原因码均来自真实任务资料；不把拖动或标注当作执行完成。</p>
        </section>
        <section v-else class="panel capability-panel" aria-labelledby="capability-title" data-testid="p01-capabilities">
          <div class="section-heading"><div><h2 id="capability-title">角色与能力<span class="demo-chip real-chip">真实状态</span></h2><p class="muted small">角色能力来自组织目录；运行时支持状态来自真实宿主观测。加载与授权动作尚未接通。</p></div></div>
          <h3 class="capability-sub">角色能力目录<span class="side-demo-tag real-tag">org.roles</span></h3>
          <div v-if="collabGraph.graph.value.roles.length" class="role-table">
            <div v-for="role in collabGraph.graph.value.roles" :key="role.role" class="role-row">
              <strong class="role-name">{{ role.role }}</strong>
              <span class="role-caps" tabindex="0" :aria-label="`${role.role} 的能力点，可滚动`"><span v-for="cap in role.capabilities" :key="cap" class="cap-chip">{{ cap }}</span></span>
              <span class="role-node muted small">{{ role.nodeRole ? '岗位角色' : '内建主体' }}</span>
            </div>
          </div>
          <p v-else class="muted small capability-empty">组织目录未返回角色能力数据。</p>
          <h3 class="capability-sub">运行时能力状态<span class="side-demo-tag real-tag">runtimes</span></h3>
          <div v-if="collabGraph.graph.value.runtimeCapabilities.length" class="runtime-table">
            <div v-for="cap in collabGraph.graph.value.runtimeCapabilities" :key="cap.bindingId" class="runtime-row">
              <span class="runtime-name"><strong>{{ cap.runtimeName }}</strong><small class="muted">{{ cap.groupName }}</small></span>
              <span class="runtime-support" :class="cap.supported ? 'yes' : 'no'">{{ cap.supported ? '支持' : '不支持' }}</span>
              <span class="runtime-isolation" :class="cap.isolation">{{ cap.isolation }}</span>
              <span class="runtime-state muted small">{{ cap.runnerState }}</span>
              <span class="runtime-reason muted small" :title="cap.reason">{{ cap.reason }}</span>
            </div>
          </div>
          <p v-else class="muted small capability-empty">当前项目没有运行时绑定，无能力状态可显示。</p>
          <p class="capability-note muted small">此处只读展示真实能力与宿主状态；Skills 选择、MCP 授权与按需加载属于配置流程（#181/#182 写操作），尚未接通，不做假状态。</p>
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
            <div v-else-if="!projectError && projects.length === 0" class="empty-state"><h3>当前没有未归档项目</h3><p>上方关系图按所选项目的真实数据显示；当前没有可展示的项目数据。</p></div>
            <ul v-else class="home-projects"><li v-for="project in projects" :key="project.id"><RouterLink :to="projectPath(project.id)" class="home-project-link"><span class="project-monogram">{{ project.name.slice(0, 1) }}</span><span class="project-copy"><strong>{{ project.name }}</strong><span>{{ project.memberCount ?? 0 }} 位成员 · {{ project.groupCount ?? 0 }} 个群组</span></span><span class="project-activity"><span class="badge" :class="{ ok: project.status === 'active' }">{{ project.status === 'active' ? '活跃' : '空闲' }}</span><small>{{ recentActivity(project.lastActivityAt) }}</small></span><AppIcon name="chevron" :size="16" /></RouterLink></li></ul>
          </section>
        </details>
      </div>
      <aside class="collab-side" aria-label="动态与待我处理">
        <section class="panel side-panel" aria-labelledby="activity-title">
          <div class="side-heading"><h2 id="activity-title">实时动态</h2><span class="side-demo-tag real-tag">真实消息</span></div>
          <ul v-if="collabGraph.graph.value.recent.length" class="activity-list"><li v-for="(item, index) in collabGraph.graph.value.recent" :key="item.id"><span class="activity-rail" aria-hidden="true"><span class="rail-dot" :class="{ first: index === 0 }"></span></span><span class="activity-copy"><small>{{ recentActivity(item.createdAt) }} · {{ item.groupName }}</small><span class="activity-bubble"><span class="avatar avatar-sm" :class="`avatar-${item.avatarSeed}`">{{ item.sender.slice(0, 1) }}</span>{{ item.sender }}：{{ item.text }}</span></span></li></ul>
          <p v-else class="muted small side-empty">当前项目暂无真实消息。发送群消息后，这里会按时间显示最近动态。</p>
        </section>
        <section class="panel side-panel" aria-labelledby="pending-title">
          <div class="side-heading"><h2 id="pending-title">待我处理</h2><span class="side-demo-tag">尚未接通</span></div>
          <p class="muted small side-empty">真实待办读模型（#177）尚未接入，此处不展示示例事项。当前可到各群查看需要你参与的消息与任务。</p>
        </section>
        <section class="quick-access" aria-labelledby="quick-access-title"><h2 id="quick-access-title">继续工作</h2><RouterLink to="/chat" class="shortcut"><span class="shortcut-icon"><AppIcon name="message" :size="21" /></span><span><strong>进入群聊</strong><small>与成员交流，让工作继续</small></span><AppIcon name="chevron" :size="16" /></RouterLink><RouterLink to="/status" class="shortcut"><span class="shortcut-icon"><AppIcon name="activity" :size="21" /></span><span><strong>查看成员状态</strong><small>了解谁在线、谁正在工作</small></span><AppIcon name="chevron" :size="16" /></RouterLink><p class="quick-note">每个项目都有自己的成员、群组和协作记录。</p></section>
      </aside>
    </div>
    <details class="service-details"><summary><span class="service-title"><AppIcon name="server" :size="18" />本地服务</span><span class="service-state" :class="healthError || health?.status === 'degraded' ? 'bad' : health ? 'ok' : 'muted'">{{ serviceLabel }}</span></summary><div class="service-body"><p class="muted small">{{ wsLabel }}。此处显示服务连接情况，成员的工作状态请查看状态看板。</p><p v-if="healthError" class="error" role="alert">健康检查失败：{{ healthError }}</p><dl class="service-grid"><div><dt>数据库</dt><dd>{{ healthError ? '连接未知' : !health ? '正在检查…' : health.database.writable ? '可读写' : '需要检查' }}</dd></div><div><dt>运行时长</dt><dd>{{ health ? uptime(health.uptimeSeconds) : '—' }}</dd></div><div><dt>数据库版本</dt><dd>{{ health?.migrations.version ?? '—' }}</dd></div><div><dt>心跳间隔 / 超时</dt><dd>{{ health ? `${health.heartbeat.intervalMs / 1000}s / ${health.heartbeat.timeoutMs / 1000}s` : '—' }}</dd></div></dl><details v-if="lastEvent" class="event-details"><summary>最近连接事件</summary><pre>{{ lastEvent }}</pre></details></div></details>
  </section>
</template>

<style scoped>
.demo-banner { display: flex; align-items: center; gap: 8px; margin: 0 0 14px; padding: 9px 14px; border: 1px dashed var(--warn); border-radius: 9px; background: color-mix(in srgb, var(--warn) 8%, transparent); color: var(--warn); font-size: .8rem; overflow-wrap: anywhere; }
.collab-breadcrumb { font-size: .78rem; color: var(--muted); margin-bottom: 8px; }.collab-breadcrumb a { color: var(--muted); text-decoration: none; }.collab-breadcrumb a:hover { color: var(--accent); }
.collab-header { align-items: flex-end; }.demo-inline { color: var(--muted); font-size: .78rem; font-weight: 400; }
.collab-header-meta { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; justify-content: flex-end; }
.scope-control { min-height: 36px; padding: .3rem .7rem; }
.connected-state { display: inline-flex; align-items: center; gap: 7px; font-size: .82rem; color: var(--muted); white-space: nowrap; }.connected-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--relation); }.connected-state.ok .connected-dot { background: var(--ok); }.connected-state.bad .connected-dot { background: var(--bad); }.connected-state.muted .connected-dot { background: var(--muted); }
.collab-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 12px 16px; margin: 18px 0 16px; box-shadow: var(--shadow); }
.toolbar-control[aria-disabled="true"], .view-tab[aria-disabled="true"], .graph-controls button[aria-disabled="true"] { cursor: not-allowed; color: var(--muted); }
.toolbar-views, .toolbar-layers { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border); border-radius: 9px; padding: 3px; background: var(--surface-subtle); }
.view-tab { min-height: 30px; padding: .2rem .8rem; font-size: .85rem; border-color: transparent; background: transparent; }.view-tab[aria-pressed="true"] { color: var(--fg); background: var(--card-bg); border-color: var(--border); }
.layer-option { display: inline-flex; align-items: center; gap: 6px; font-size: .85rem; color: var(--fg); white-space: nowrap; cursor: pointer; padding: 0 .4rem; }
.collab-status { margin: 0 0 16px; overflow-wrap: anywhere; }
.collab-workspace { display: grid; grid-template-columns: minmax(0,1fr) minmax(260px,320px); gap: 24px; align-items: start; }
.collab-main, .collab-side { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
.graph-panel .section-heading { margin-bottom: 16px; }.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 9px; }.section-heading h2 { margin: 0; font-size: 1.02rem; }
.demo-chip { display: inline-block; margin-left: 8px; padding: 2px 7px; border-radius: 5px; background: var(--accent-soft); color: var(--accent); font-size: .68rem; font-weight: 600; vertical-align: middle; }
.demo-chip.real-chip { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.message-arrow-layer { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); }
.message-arrow-title { display: flex; align-items: center; gap: 10px; font-size: .92rem; margin: 0 0 10px; }
.message-arrow-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.message-arrow-item { flex: 1 1 240px; min-width: 0; }
.message-arrow-btn { width: 100%; display: flex; align-items: center; gap: 6px; padding: 8px 10px; font-size: .78rem; border: 1px solid var(--border); border-radius: 8px; background: var(--card-bg); color: var(--fg); text-align: left; }
.message-arrow-btn:hover { background: var(--surface-subtle); }
.arrow-from { display: inline-flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.arrow-dir { color: var(--accent); font-weight: 600; flex: none; }
.arrow-to { color: var(--accent); font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.arrow-time, .arrow-id { margin-left: auto; color: var(--muted); font-size: .7rem; flex: none; }
.arrow-id { margin-left: 0; }
.message-arrow-detail { margin: 6px 0 0; padding: 8px 10px; border-radius: 7px; background: var(--surface-subtle); font-size: .8rem; overflow-wrap: anywhere; }
.message-arrow-note { margin: 10px 0 0; }
.inspector { margin-top: 18px; padding: 16px; border: 1px solid var(--accent); border-radius: 10px; background: var(--card-bg); }
.inspector-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }.inspector-head h3 { display: flex; align-items: center; gap: 8px; font-size: .95rem; margin: 0; }.inspector-head .app-icon { color: var(--accent); }.inspector-close { width: 32px; min-height: 32px; display: grid; place-items: center; border-color: transparent; background: transparent; color: var(--muted); }
.inspector-note { margin: 10px 0 0; line-height: 1.6; }
.inspector-messages { list-style: none; margin: 16px 0 0; padding: 0; max-height: 320px; overflow-y: auto; }.inspector-msg { display: flex; gap: 10px; padding: 10px 0; border-top: 1px solid var(--border); }.inspector-msg-body { flex: 1; min-width: 0; }.inspector-msg-meta { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }.inspector-msg-meta strong { font-size: .84rem; }.inspector-msg-meta time { font-size: .7rem; color: var(--muted); }.inspector-msg-text { display: block; margin-top: 4px; font-size: .84rem; overflow-wrap: anywhere; }.inspector-msg-id { display: block; margin-top: 5px; font-size: .68rem; color: var(--muted); overflow-wrap: anywhere; }.inspector-empty { margin-top: 16px; }
.capability-panel .section-heading p { margin: 6px 0 0; }
.capability-sub { display: flex; align-items: center; gap: 8px; font-size: .9rem; margin: 18px 0 10px; }
.role-table, .runtime-table { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.role-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; }.role-row + .role-row { border-top: 1px solid var(--border); }.role-name { font-size: .82rem; text-transform: capitalize; flex: 0 0 110px; }.role-caps { display: flex; flex-wrap: wrap; gap: 5px; flex: 1; min-width: 0; }.cap-chip { font-size: .68rem; padding: 2px 7px; border-radius: 5px; background: var(--accent-soft); color: var(--accent); overflow-wrap: anywhere; }.role-node { flex: none; }
.runtime-row { display: grid; grid-template-columns: minmax(0,1.4fr) 64px 84px 68px minmax(0,1fr); align-items: center; gap: 10px; padding: 10px 14px; }.runtime-row + .runtime-row { border-top: 1px solid var(--border); }.runtime-name strong { display: block; font-size: .82rem; }.runtime-name small { display: block; font-size: .7rem; margin-top: 2px; }.runtime-support { font-size: .74rem; font-weight: 600; }.runtime-support.yes { color: var(--ok); }.runtime-support.no { color: var(--bad); }.runtime-isolation { font-size: .7rem; padding: 2px 6px; border-radius: 5px; text-align: center; background: var(--surface-subtle); }.runtime-isolation.verified { color: var(--ok); }.runtime-isolation.unverified { color: var(--warn); }.runtime-reason { font-size: .72rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.capability-empty { padding: 14px; border: 1px dashed var(--border); border-radius: 9px; }.capability-note { margin: 16px 0 0; line-height: 1.6; }
@media (max-width: 760px) {
  .runtime-row { grid-template-columns: minmax(0,1fr) 60px; }.runtime-isolation, .runtime-state, .runtime-reason { grid-column: 1 / -1; }
  .role-row { flex-direction: column; align-items: flex-start; gap: 8px; }
  .role-name { flex: none; }
  .role-caps { width: 100%; max-height: 132px; overflow-y: auto; }
  .role-node { align-self: flex-end; }
}
.taskflow-panel .section-heading p { margin: 6px 0 0; }
.taskflow-board { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; align-items: start; }
.taskflow-column { min-width: 0; background: var(--surface-subtle); border-radius: 10px; padding: 10px; }
.taskflow-col-title { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: .82rem; margin: 0 0 10px; padding: 0 2px; }
.taskflow-col-count { font-size: .7rem; color: var(--muted); background: var(--card-bg); border-radius: 20px; padding: 1px 7px; }
.taskflow-card { display: flex; flex-direction: column; gap: 7px; padding: 11px; margin-bottom: 8px; border: 1px solid var(--border); border-radius: 9px; background: var(--card-bg); box-shadow: var(--shadow); }
.taskflow-card-title { font-size: .82rem; line-height: 1.4; overflow-wrap: anywhere; }
.taskflow-card-assignee { display: inline-flex; align-items: center; gap: 6px; font-size: .74rem; color: var(--muted); }
.taskflow-card-blocked { margin: 0; font-size: .72rem; color: var(--bad); overflow-wrap: anywhere; }
.taskflow-card-readiness { display: flex; flex-wrap: wrap; gap: 4px; }
.readiness-chip { font-size: .63rem; padding: 1px 5px; border-radius: 4px; background: color-mix(in srgb, var(--warn) 12%, transparent); color: var(--warn); overflow-wrap: anywhere; }
.taskflow-card-id { font-size: .66rem; color: var(--muted); }
.taskflow-col-empty { margin: 0; padding: 6px 2px; }
.taskflow-empty { min-height: 260px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 10px; color: var(--muted); }.taskflow-empty strong { color: var(--fg); }.taskflow-empty p { font-size: .84rem; margin: 0; max-width: 24rem; }
.taskflow-note { margin: 14px 0 0; line-height: 1.6; }
@media (max-width: 1100px) { .taskflow-board { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 620px) { .taskflow-board { grid-template-columns: 1fr; } }
.graph-loading { padding: 48px 0; text-align: center; }
.graph-empty { min-height: 280px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 10px; color: var(--muted); padding: 24px; }.graph-empty .app-icon { color: var(--muted); }.graph-empty strong { color: var(--fg); font-size: 1rem; }.graph-empty p { font-size: .84rem; max-width: 28rem; margin: 0; overflow-wrap: anywhere; }
.group-count { margin-left: auto; font-size: .7rem; color: var(--muted); }
.side-empty { margin: 14px 0 0; line-height: 1.6; }
.side-demo-tag.real-tag { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--border)); }
.graph-canvas { border: 1px solid var(--border); border-radius: 10px; background: var(--surface-subtle); padding: 22px 18px; overflow-x: auto; }
.demo-tree { min-width: 620px; display: flex; flex-direction: column; align-items: center; }
.tree-node { display: flex; align-items: center; gap: 10px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); padding: 9px 13px; }
.tree-node strong { font-size: .9rem; font-weight: 600; }.tree-node small { display: block; font-size: .74rem; color: var(--muted); margin-top: 2px; }
.root-node { flex-direction: column; gap: 6px; padding: 10px 18px; }.root-node strong { font-size: .92rem; }
.lead-node { min-width: 210px; }
.tree-stem { width: 2px; height: 26px; background: var(--relation); flex: none; }
.tree-groups { width: 100%; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; position: relative; }
.tree-groups::before { content: ""; position: absolute; top: -13px; left: 16.66%; right: 16.66%; height: 2px; background: var(--relation); }
.tree-group { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); padding: 12px; position: relative; }
.tree-group::before { content: ""; position: absolute; top: -13px; left: 50%; width: 2px; height: 13px; background: var(--relation); }
.tree-group-head { display: flex; align-items: center; gap: 8px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }.tree-group-head strong { font-size: .86rem; font-weight: 600; }.group-icon { color: var(--accent); display: inline-flex; }
.group-open-btn { width: 100%; text-align: left; border: 0; background: transparent; color: var(--fg); padding: 0 0 10px; border-bottom: 1px solid var(--border); border-radius: 0; }
.group-open-btn:hover { background: transparent; }.group-open-btn > .app-icon { margin-left: 0; color: var(--muted); flex: none; }.group-open-btn[aria-expanded="true"] > .app-icon { transform: rotate(90deg); color: var(--accent); }
.group-body { padding-top: 10px; }
.member-row { display: flex; align-items: center; gap: 8px; padding: 7px; border: 1px solid var(--border); border-radius: 9px; background: var(--card-bg); }
.member-copy { flex: 1; min-width: 0; }.member-copy strong { display: block; font-size: .8rem; font-weight: 600; }.member-copy small { display: block; font-size: .7rem; color: var(--muted); margin-top: 1px; }
.avatar { flex: none; width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; color: #1d1d1f; font-size: .78rem; font-weight: 600; background: #dfe3ea; }
.avatar-0 { background: #d8dee9; }.avatar-1 { background: #f0d9c8; }.avatar-2 { background: #cfe0d4; }.avatar-3 { background: #d9d4ea; }.avatar-4 { background: #e8dcb8; }.avatar-5 { background: #cfdce8; }.avatar-6 { background: #d5d9df; }
.avatar-sm { width: 24px; height: 24px; font-size: .7rem; }
.status-badge { flex: none; font-size: .68rem; padding: 2px 7px; border-radius: 20px; white-space: nowrap; font-weight: 600; }
.status-badge.ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }.status-badge.active { color: var(--accent); background: var(--accent-soft); }.status-badge.wait { color: var(--warn); background: color-mix(in srgb, var(--warn) 10%, transparent); }
.member-connector { position: relative; height: 30px; display: flex; align-items: center; justify-content: flex-start; padding-left: 18px; }.member-connector::before { content: ""; position: absolute; left: 21px; top: 0; bottom: 0; width: 2px; background: var(--relation); }.member-connector::after { content: ""; position: absolute; left: 21px; top: 50%; width: 8px; height: 2px; background: var(--relation); }
.flow-label { position: relative; font-size: .66rem; color: var(--muted); background: var(--card-bg); border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px; margin-left: 10px; }
.group-flow { margin-top: 10px; font-size: .7rem; color: var(--accent); display: flex; align-items: center; gap: 6px; }.flow-arrow { font-size: .9rem; }
.tree-cross-flow { width: 100%; display: flex; justify-content: space-between; padding: 10px 30px 0; font-size: .66rem; color: var(--muted); }
.graph-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; margin-top: 14px; }
.graph-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; list-style: none; margin: 0; padding: 0; font-size: .8rem; color: var(--muted); }.graph-legend li { display: inline-flex; align-items: center; gap: 6px; }
.legend-line { width: 22px; height: 0; border-top: 2px solid var(--relation); }.legend-arrow { position: relative; }.legend-arrow::after { content: "›"; position: absolute; right: -4px; top: -11px; font-size: 1rem; color: var(--relation); }.legend-dot { width: 8px; height: 8px; border-radius: 50%; }.legend-dot.ok { background: var(--ok); }
.graph-controls { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 8px; }.graph-controls button { min-height: 34px; padding: .25rem .65rem; font-size: .84rem; }.zoom-value { color: var(--muted); font-size: .82rem; font-variant-numeric: tabular-nums; }
.real-data-fold { border: 1px solid var(--border); border-radius: 11px; background: var(--card-bg); overflow: hidden; }.real-data-fold > summary { padding: 13px 16px; font-size: .82rem; color: var(--muted); cursor: pointer; }.real-data-fold > summary:hover { color: var(--fg); }.real-data-fold .overview-metrics, .real-data-fold .project-overview { margin: 0; border-radius: 0; border: 0; box-shadow: none; border-top: 1px solid var(--border); }
.overview-metrics { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); padding: 20px 0; }.overview-metrics > div { padding: 0 24px; }.overview-metrics > div + div { border-left: 1px solid var(--border); }.overview-metrics dt { font-size: .85rem; color: var(--muted); }.overview-metrics dd { margin: 5px 0 3px; font-size: 2rem; font-weight: 600; line-height: 1.3; font-variant-numeric: tabular-nums; }.overview-metrics span { font-size: .76rem; color: var(--muted); }
.project-overview { padding: 16px; }.home-projects { list-style: none; margin: 0; padding: 0; }.home-projects li + li { border-top: 1px solid var(--border); }.home-project-link { display: flex; gap: 12px; align-items: center; padding: 14px 8px; border-radius: 8px; color: var(--fg); }.home-project-link:hover { background: var(--surface-subtle); text-decoration: none; }.project-monogram { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 9px; color: var(--accent); background: var(--accent-soft); font-weight: 600; flex: none; }.project-copy { flex: 1; min-width: 0; }.project-copy strong { display: block; font-size: .9rem; }.project-copy > span { display: block; color: var(--muted); font-size: .78rem; margin-top: 3px; }.project-activity { text-align: right; flex: none; }.project-activity small { display: block; margin-top: 4px; color: var(--muted); font-size: .72rem; }.badge { font-size: .7rem; padding: 2px 8px; border-radius: 20px; background: var(--surface-subtle); color: var(--muted); }.badge.ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }.loading-state, .empty-state { padding: 30px 8px; }.empty-state h3 { font-size: .95rem; margin: 0 0 6px; }.empty-state p { font-size: .82rem; color: var(--muted); margin: 0; }
.side-panel h2 { font-size: 1.02rem; margin: 0; }.side-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }.side-demo-tag { font-size: .68rem; color: var(--muted); padding: 2px 7px; border: 1px solid var(--border); border-radius: 5px; }
.activity-list { list-style: none; margin: 14px 0 0; padding: 0; }.activity-list li { display: flex; gap: 10px; padding-bottom: 14px; }.activity-rail { flex: none; position: relative; width: 10px; display: flex; justify-content: center; }.activity-rail::before { content: ""; position: absolute; top: 4px; bottom: -14px; width: 2px; background: var(--border); }.activity-list li:last-child .activity-rail::before { display: none; }.rail-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border); position: relative; z-index: 1; }.rail-dot.first { background: var(--accent); }.activity-copy { flex: 1; min-width: 0; }.activity-copy > small { font-size: .7rem; color: var(--muted); }.activity-bubble { display: flex; align-items: center; gap: 7px; margin-top: 5px; padding: 9px 10px; border: 1px solid var(--border); border-radius: 9px; background: var(--card-bg); font-size: .78rem; overflow-wrap: anywhere; }
.pending-list { margin-top: 14px; }.pending-card { display: flex; align-items: center; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--card-bg); }.pending-icon { color: var(--ok); display: inline-flex; }.pending-copy { flex: 1; min-width: 0; }.pending-copy strong { display: block; font-size: .82rem; }.pending-copy small { display: block; font-size: .72rem; color: var(--muted); margin-top: 2px; }.pending-link { font-size: .72rem; color: var(--accent); display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.quick-access { padding: 6px 0; }.quick-access h2 { font-size: 1.02rem; margin-bottom: 10px; }.shortcut { display: flex; align-items: center; gap: 13px; padding: 14px 0; color: var(--fg); border-bottom: 1px solid var(--border); }.shortcut:hover { color: var(--accent); text-decoration: none; }.shortcut-icon { color: var(--muted); }.shortcut > span:nth-child(2) { flex: 1; min-width: 0; }.shortcut strong { display: block; font-weight: 500; font-size: .9rem; }.shortcut small { display: block; color: var(--muted); font-size: .78rem; margin-top: 3px; }.shortcut > .app-icon { color: var(--muted); }.quick-note { color: var(--muted); font-size: .78rem; margin-top: 16px; }
.service-details { margin-top: 30px; border: 1px solid var(--border); border-radius: 11px; background: var(--card-bg); }.service-details > summary { padding: 16px 20px; font-size: .85rem; }.service-title { display: inline-flex; align-items: center; gap: 10px; margin-left: 6px; }.service-state { float: right; font-size: .8rem; font-weight: 400; }.service-body { border-top: 1px solid var(--border); padding: 18px 24px; }.service-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 16px; margin: 20px 0 0; }.service-grid dt { font-size: .8rem; color: var(--muted); }.service-grid dd { margin: 6px 0 0; font-size: .9rem; }.event-details { margin-top: 20px; font-size: .8rem; }.event-details pre { max-height: 150px; overflow: auto; }
@media (max-width: 1100px) { .collab-workspace { grid-template-columns: 1fr; gap: 20px; }.collab-side { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); align-items: start; gap: 16px; }.collab-side .quick-access { grid-column: 1 / -1; } }
@media (max-width: 760px) {
  .collab-workspace { gap: 16px; }.collab-main, .collab-side { gap: 16px; }.collab-side { display: flex; flex-direction: column; }
  .collab-toolbar { padding: 10px 12px; gap: 8px 10px; }.toolbar-views, .toolbar-layers { flex-wrap: wrap; }
  .collab-header-meta { justify-content: flex-start; }
  .graph-canvas { padding: 16px 12px; }.graph-footer { align-items: flex-start; }
  .overview-metrics { padding: 18px 0; }.overview-metrics > div { padding: 0 14px; }.overview-metrics dd { font-size: 1.7rem; }.overview-metrics span { display: none; }.overview-metrics dt { font-size: .78rem; }
  .service-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }.project-activity small { display: none; }
  .service-details > summary { padding: 14px; }.service-body { padding: 16px; }
}
</style>
