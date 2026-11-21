<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink } from "vue-router";
import AppIcon from "../components/AppIcon.vue";
import { projectPath, useCurrentProject } from "../composables/useCurrentProject.ts";
interface HealthReport {
  status: "ok" | "degraded"; uptimeSeconds: number; serverTime: string;
  database: { status: string; writable: boolean; error?: string };
  migrations: { version: number; applied: number; pending: number };
  heartbeat: { intervalMs: number; timeoutMs: number }; webui: { built: boolean };
}

// 本页中央关系图为静态视觉演示，节点/头像/状态/动态均为示例数据，不代表真实运行数据。
// 唯一真实数据是顶部“已连接”与底部“本地服务”，来自 /api/health 与 /ws。
interface DemoMember { name: string; initials: string; role: string; status: string; tone: "ok" | "active" | "wait"; avatar: number }
interface DemoGroup { name: string; icon: string; coordinator: DemoMember; members: DemoMember[]; flows: string[] }
const demoGroups: DemoGroup[] = [
  {
    name: "界面升级小组", icon: "grid",
    coordinator: { name: "产品设计师", initials: "产", role: "设计", status: "方案已提交", tone: "active", avatar: 1 },
    members: [{ name: "前端工程师", initials: "前", role: "实现", status: "执行中", tone: "active", avatar: 2 }],
    flows: ["设计协作", "方案 · 已送达"],
  },
  {
    name: "MCP 能力接入", icon: "layers",
    coordinator: { name: "后端工程师", initials: "后", role: "接入", status: "执行中", tone: "active", avatar: 3 },
    members: [{ name: "安全审查员", initials: "安", role: "审查", status: "等待材料", tone: "wait", avatar: 4 }],
    flows: ["接口协作", "权限复核"],
  },
  {
    name: "质量保障", icon: "check",
    coordinator: { name: "验证工程师", initials: "验", role: "验证", status: "等待版本", tone: "wait", avatar: 5 },
    members: [],
    flows: ["验证协作"],
  },
];
const demoRoot: DemoMember = { name: "总管", initials: "总", role: "协调中枢", status: "在线", tone: "ok", avatar: 0 };
const demoLead: DemoMember = { name: "项目负责人", initials: "负", role: "协调中", status: "协调中", tone: "active", avatar: 6 };
const demoActivity = [
  { when: "刚刚", who: "前端工程师", text: "已接手协作总览升级。" },
  { when: "12 秒前", who: "产品设计师", text: "发送方案。" },
  { when: "38 秒前", who: "后端工程师", text: "请求权限复核。" },
];
const demoPending = [{ title: "扩大工具使用范围", detail: "项目策略要求确认" }];

// P03 任务流转视图示例数据（静态视觉演示）
const activeView = ref<"members" | "tasks">("members");
const demoTasks = [
  { id: "assigned", title: "任务已分配", icon: "check", tone: "ok", person: "项目负责人", initials: "负", avatar: 6,
    desc: "明确需求与分工，完成任务分派。", foot: "已完成分派", active: false },
  { id: "doing", title: "执行中", icon: "arrow", tone: "active", person: "前端工程师", initials: "前", avatar: 2,
    desc: "正在实现选中与会话联动。", foot: "成员会话侧栏 · 查看成员会话", active: true },
  { id: "done", title: "完成", icon: "history", tone: "idle", person: "", initials: "", avatar: 0,
    desc: "尚未开始", sub: "通过验证与评审后，标记任务完成。", active: false },
  { id: "verify", title: "验证与评审", icon: "check", tone: "wait", person: "验证工程师", initials: "验", avatar: 5,
    desc: "尚未开始", sub: "验证功能效果与关键验收点。", active: false },
];
const demoTaskDetail = {
  title: "协作总览升级", state: "执行中", owner: "前端工程师", group: "界面升级小组", phase: "实现", next: "提交候选后进入评审",
  acceptance: ["图中查看成员会话", "消息与节点双向定位", "断线恢复不串会话"],
  discussion: "打开群聊", recent: "前端工程师已接手",
};
function switchView(view: "members" | "tasks"): void { activeView.value = view; unavailableReason.value = null; }

// P02 成员会话面板示例数据（静态视觉演示）
const selectedMemberId = ref<string | null>(null);
const demoConversation = {
  name: "前端工程师", initials: "前", avatar: 2, online: true, state: "执行中", group: "界面升级小组", instance: "当前实例",
  task: "协作总览升级", synced: "仅 Boardroom 消息 · 已同步",
  messages: [
    { who: "项目负责人", initials: "负", avatar: 6, tag: "任务指令", text: "实现成员会话侧栏，保留关系图。", mine: false },
    { who: "产品设计师", initials: "产", avatar: 1, tag: "定向消息", text: "点击成员后，右侧直接展开他的会话。", mine: false },
    { who: "前端工程师", initials: "前", avatar: 2, tag: "回复", text: "已接手，正在实现成员选中与会话联动。", mine: true },
  ],
};
function openConversation(memberId: string): void { selectedMemberId.value = memberId; }
function closeConversation(): void { selectedMemberId.value = null; }

const health = ref<HealthReport | null>(null);
const healthError = ref<string | null>(null);
const context = useCurrentProject();
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
  unavailableReason.value = `「${label}」是静态演示控件；真实交互需等协作关系读模型接入。`;
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
onMounted(() => { void refresh(); connect(); healthTimer = setInterval(() => void refreshHealth(), 15000); });
onUnmounted(() => { disposed = true; socket?.close(); if (healthTimer) clearInterval(healthTimer); if (reconnectTimer) clearTimeout(reconnectTimer); });
</script>

<template>
  <section class="page home-page">
    <p class="demo-banner" role="note" data-testid="p01-demo-banner"><AppIcon name="layers" :size="15" />静态视觉演示：中央关系图、头像、状态与动态均为示例数据，非真实运行数据。</p>
    <nav class="collab-breadcrumb" aria-label="当前位置"><RouterLink to="/">工作台</RouterLink><span aria-hidden="true"> / </span><span>Boardroom</span></nav>
    <header class="page-header collab-header">
      <div><h1>协作总览</h1><p class="page-description">3 个群组 · 5 个群内实例<span class="demo-inline">（示例数据）</span></p></div>
      <div class="collab-header-meta">
        <button type="button" class="toolbar-control scope-control" aria-disabled="true" title="范围切换是静态演示控件" data-testid="p01-scope" @click="explainUnavailable('范围切换')">范围：Boardroom<AppIcon name="chevron" :size="14" /></button>
        <span class="connected-state" :class="healthError || health?.status === 'degraded' ? 'bad' : health ? 'ok' : 'muted'" data-testid="p01-connected"><span class="connected-dot" aria-hidden="true"></span>{{ connectedLabel }} · 刚刚更新</span>
      </div>
    </header>
    <div v-if="projectError" class="error" role="alert">项目暂时无法加载：{{ projectError }} <button type="button" class="text-button" :disabled="refreshing" @click="refresh">重新加载</button></div>

    <section class="collab-toolbar" aria-label="协作总览工具条">
      <div class="toolbar-views" role="group" aria-label="视图切换">
        <button type="button" class="view-tab" :aria-pressed="activeView === 'members'" @click="switchView('members')">成员关系</button>
        <button type="button" class="view-tab" :aria-pressed="activeView === 'tasks'" @click="switchView('tasks')">任务流转</button>
      </div>
      <template v-if="activeView === 'tasks'">
        <span class="task-select-label">任务：</span>
        <button type="button" class="toolbar-control task-select" aria-disabled="true" title="任务选择是静态演示控件" @click="explainUnavailable('任务选择')">{{ demoTaskDetail.title }}<AppIcon name="chevron" :size="14" /></button>
      </template>
      <template v-else>
        <div class="toolbar-layers" role="group" aria-label="关系图层，静态演示">
          <label class="layer-option"><input type="checkbox" checked aria-disabled="true" @click.prevent="explainUnavailable('协作关系图层')" />协作关系</label>
          <label class="layer-option"><input type="checkbox" checked aria-disabled="true" @click.prevent="explainUnavailable('消息方向图层')" />消息方向</label>
        </div>
        <button type="button" class="toolbar-control filter-control" aria-disabled="true" title="成员筛选是静态演示控件" @click="explainUnavailable('成员筛选')">全部成员<AppIcon name="chevron" :size="14" /></button>
      </template>
    </section>
    <p v-if="unavailableReason" class="collab-status muted small" role="status" data-testid="p01-unconnected-status">{{ unavailableReason }}</p>

    <div class="collab-workspace">
      <div class="collab-main">
        <section v-if="activeView === 'members'" class="panel graph-panel" aria-labelledby="graph-title">
          <div class="section-heading"><div><h2 id="graph-title">协作关系图<span class="demo-chip">示例数据</span></h2></div></div>
          <div class="graph-canvas" data-testid="p01-graph-canvas">
            <div class="demo-tree" role="img" aria-label="示例协作关系图：总管连接项目负责人，项目负责人连接界面升级小组、MCP 能力接入、质量保障三个群，各群包含成员卡片与协作、消息方向箭头。全部为示例数据。">
              <div class="tree-node root-node">
                <span class="avatar avatar-0"><AppIcon name="message" :size="17" /></span>
                <strong>{{ demoRoot.name }}</strong><small>{{ demoRoot.role }}</small>
              </div>
              <div class="tree-stem" aria-hidden="true"></div>
              <div class="tree-node lead-node">
                <span class="avatar avatar-6">{{ demoLead.initials }}</span>
                <span><strong>{{ demoLead.name }}</strong><small>{{ demoLead.role }}</small></span>
                <span class="status-badge active">{{ demoLead.status }}</span>
              </div>
              <div class="tree-stem" aria-hidden="true"></div>
              <div class="tree-groups">
                <div v-for="group in demoGroups" :key="group.name" class="tree-group">
                  <div class="tree-group-head"><span class="group-icon"><AppIcon :name="group.icon" :size="16" /></span><strong>{{ group.name }}</strong></div>
                  <div class="group-body">
                    <button type="button" class="member-row member-open-btn" :class="{ 'is-selected': selectedMemberId === group.coordinator.name }" :aria-label="`查看${group.coordinator.name}的成员会话`" @click="openConversation(group.coordinator.name)">
                      <span class="avatar" :class="`avatar-${group.coordinator.avatar}`">{{ group.coordinator.initials }}</span>
                      <span class="member-copy"><strong>{{ group.coordinator.name }}</strong><small>{{ group.coordinator.role }}</small></span>
                      <span class="status-badge" :class="group.coordinator.tone">{{ group.coordinator.status }}</span>
                    </button>
                    <div v-if="group.members.length" class="member-connector" aria-hidden="true"><span class="flow-label">{{ group.flows[0] }}</span></div>
                    <button v-for="member in group.members" :key="member.name" type="button" class="member-row member-open-btn" :class="{ 'is-selected': selectedMemberId === member.name }" :aria-label="`查看${member.name}的成员会话`" @click="openConversation(member.name)">
                      <span class="avatar" :class="`avatar-${member.avatar}`">{{ member.initials }}</span>
                      <span class="member-copy"><strong>{{ member.name }}</strong><small>{{ member.role }}</small></span>
                      <span class="status-badge" :class="member.tone">{{ member.status }}</span>
                    </button>
                  </div>
                  <div class="group-flow"><span class="flow-arrow" aria-hidden="true">→</span>{{ group.flows[group.flows.length - 1] }}</div>
                </div>
              </div>
              <div class="tree-cross-flow" aria-hidden="true"><span>接口协作</span><span>验证协作</span></div>
            </div>
          </div>
          <div class="graph-footer">
            <ul class="graph-legend" aria-label="关系图图例"><li><span class="legend-line" aria-hidden="true"></span>协作关系</li><li><span class="legend-line legend-arrow" aria-hidden="true"></span>消息方向</li><li><span class="legend-dot ok" aria-hidden="true"></span>连接正常</li></ul>
            <div class="graph-controls" role="group" aria-label="画布操作，静态演示">
              <button type="button" aria-label="缩小画布，静态演示" aria-disabled="true" title="静态演示控件" @click="explainUnavailable('缩小画布')">−</button>
              <span class="zoom-value">100%</span>
              <button type="button" aria-label="放大画布，静态演示" aria-disabled="true" title="静态演示控件" @click="explainUnavailable('放大画布')">+</button>
              <button type="button" aria-label="适应画布，静态演示" aria-disabled="true" title="静态演示控件" @click="explainUnavailable('适应画布')">适应画布</button>
            </div>
          </div>
        </section>
        <section v-else class="panel taskflow-panel" aria-labelledby="taskflow-title" data-testid="p03-taskflow">
          <div class="section-heading"><div><h2 id="taskflow-title">任务流转<span class="demo-chip">示例数据</span></h2></div></div>
          <div class="taskflow-board">
            <div v-for="(task, index) in demoTasks" :key="task.id" class="taskflow-stage" :class="{ active: task.active }">
              <div class="stage-head"><span class="stage-icon" :class="task.tone"><AppIcon :name="task.icon" :size="16" /></span><strong>{{ task.title }}</strong></div>
              <div class="stage-body">
                <div v-if="task.person" class="stage-person"><span class="avatar" :class="`avatar-${task.avatar}`">{{ task.initials }}</span><strong>{{ task.person }}</strong></div>
                <p class="stage-desc">{{ task.desc }}</p>
                <p v-if="task.sub" class="stage-sub">{{ task.sub }}</p>
                <div v-if="task.id === 'doing'" class="stage-link"><span class="link-icon"><AppIcon name="message" :size="16" /></span><span><strong>成员会话侧栏</strong><small>正在实现选中与会话联动。</small></span><span class="link-cta">查看成员会话 ›</span></div>
                <div class="stage-foot"><span class="foot-icon" :class="task.tone"><AppIcon name="check" :size="14" /></span>{{ task.foot }}</div>
              </div>
              <span v-if="index === 0" class="stage-arrow" aria-hidden="true">→</span>
              <span v-if="index === 1" class="stage-arrow down" aria-hidden="true">↓</span>
              <span v-if="index === 3" class="stage-arrow left" aria-hidden="true">←</span>
            </div>
          </div>
          <div class="taskflow-handoff"><AppIcon name="arrow" :size="16" /><strong>最近交接</strong><span class="avatar avatar-1">产</span><span>产品设计师</span><span class="handoff-arrow">→</span><span class="avatar avatar-2">前</span><span>前端工程师</span><span class="handoff-note">· 已接手</span></div>
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
            <div v-else-if="!projectError && projects.length === 0" class="empty-state"><h3>当前没有未归档项目</h3><p>上方关系图是静态演示，不会因这里为空而变化。</p></div>
            <ul v-else class="home-projects"><li v-for="project in projects" :key="project.id"><RouterLink :to="projectPath(project.id)" class="home-project-link"><span class="project-monogram">{{ project.name.slice(0, 1) }}</span><span class="project-copy"><strong>{{ project.name }}</strong><span>{{ project.memberCount ?? 0 }} 位成员 · {{ project.groupCount ?? 0 }} 个群组</span></span><span class="project-activity"><span class="badge" :class="{ ok: project.status === 'active' }">{{ project.status === 'active' ? '活跃' : '空闲' }}</span><small>{{ recentActivity(project.lastActivityAt) }}</small></span><AppIcon name="chevron" :size="16" /></RouterLink></li></ul>
          </section>
        </details>
      </div>
      <aside class="collab-side" :aria-label="activeView === 'tasks' ? '任务详情' : '动态与待我处理'">
        <template v-if="activeView === 'tasks'">
          <section class="panel side-panel task-detail" aria-labelledby="task-detail-title">
            <div class="side-heading"><h2 id="task-detail-title">任务详情</h2><button type="button" class="inspector-close" aria-label="关闭任务详情" aria-disabled="true" title="静态演示控件" @click="explainUnavailable('关闭任务详情')"><AppIcon name="close" :size="16" /></button></div>
            <div class="task-detail-title"><span class="task-detail-icon"><AppIcon name="layers" :size="20" /></span><strong>{{ demoTaskDetail.title }}</strong><span class="status-badge active">{{ demoTaskDetail.state }}</span></div>
            <dl class="task-facts">
              <div><dt><AppIcon name="people" :size="15" />负责人</dt><dd>{{ demoTaskDetail.owner }}</dd></div>
              <div><dt><AppIcon name="message" :size="15" />所在群组</dt><dd>{{ demoTaskDetail.group }}</dd></div>
              <div><dt><AppIcon name="layers" :size="15" />当前阶段</dt><dd>{{ demoTaskDetail.phase }}</dd></div>
              <div><dt><AppIcon name="arrow" :size="15" />下一步</dt><dd>{{ demoTaskDetail.next }}</dd></div>
            </dl>
            <div class="task-section"><h3>验收重点</h3><ul class="checklist"><li v-for="item in demoTaskDetail.acceptance" :key="item"><span class="checkbox" aria-hidden="true"></span>{{ item }}</li></ul></div>
            <div class="task-section task-discussion"><span><AppIcon name="message" :size="16" />相关讨论</span><span class="discussion-link">打开群聊 ›</span></div>
            <div class="task-section"><h3>最近活动</h3><p class="recent-activity"><span class="rail-dot first" aria-hidden="true"></span>{{ demoTaskDetail.recent }}</p></div>
          </section>
        </template>
        <template v-else>
          <section v-if="selectedMemberId" class="panel side-panel conversation-panel" aria-labelledby="conversation-title" data-testid="p02-conversation">
            <div class="side-heading"><h2 id="conversation-title">成员会话</h2><button type="button" class="inspector-close" aria-label="关闭成员会话" @click="closeConversation"><AppIcon name="close" :size="16" /></button></div>
            <div class="conv-person"><span class="avatar conv-avatar" :class="`avatar-${demoConversation.avatar}`">{{ demoConversation.initials }}</span><span class="conv-person-copy"><strong>{{ selectedMemberId }}</strong><small>{{ demoConversation.group }} · {{ demoConversation.instance }}</small></span><span v-if="demoConversation.online" class="conv-online"><span class="connected-dot ok" aria-hidden="true"></span>在线</span><span class="status-badge active">{{ demoConversation.state }}</span></div>
            <button type="button" class="conv-task" aria-disabled="true" title="静态演示控件" @click="explainUnavailable('当前任务')"><span class="conv-task-icon"><AppIcon name="layers" :size="16" /></span><span>当前任务：<strong>{{ demoConversation.task }}</strong></span><AppIcon name="chevron" :size="14" /></button>
            <p class="conv-sync muted small">{{ demoConversation.synced }}</p>
            <div class="conv-tabs" role="tablist" aria-label="成员会话内容"><button type="button" role="tab" aria-selected="true">会话</button><button type="button" role="tab" aria-selected="false" aria-disabled="true" @click="explainUnavailable('活动')">活动</button><button type="button" role="tab" aria-selected="false" aria-disabled="true" @click="explainUnavailable('产物')">产物</button></div>
            <div class="conv-day"><span>今天 14:32</span></div>
            <div class="conv-messages">
              <div v-for="(msg, index) in demoConversation.messages" :key="index" class="conv-msg" :class="{ mine: msg.mine }">
                <template v-if="!msg.mine">
                  <span class="avatar avatar-sm" :class="`avatar-${msg.avatar}`">{{ msg.initials }}</span>
                  <div class="conv-msg-body"><div class="conv-msg-meta"><strong>{{ msg.who }}</strong><span class="conv-tag">{{ msg.tag }}</span></div><p class="conv-bubble">{{ msg.text }}</p></div>
                </template>
                <template v-else>
                  <div class="conv-msg-body"><div class="conv-msg-meta right"><span class="conv-tag">{{ msg.tag }}</span><strong>{{ msg.who }}</strong></div><p class="conv-bubble mine">{{ msg.text }}</p></div>
                  <span class="avatar avatar-sm" :class="`avatar-${msg.avatar}`">{{ msg.initials }}</span>
                </template>
              </div>
              <div class="conv-locate"><AppIcon name="layers" :size="14" />定位消息</div>
            </div>
            <button type="button" class="conv-new" aria-disabled="true" @click="explainUnavailable('新消息跳转')">2 条新消息 ↓</button>
            <div class="conv-footer"><span><span class="connected-dot ok" aria-hidden="true"></span>实时更新</span><button type="button" aria-disabled="true" @click="explainUnavailable('展开完整会话')">展开完整会话</button></div>
          </section>
          <template v-else>
          <section class="panel side-panel" aria-labelledby="activity-title">
            <div class="side-heading"><h2 id="activity-title">实时动态</h2><span class="side-demo-tag">示例数据</span></div>
            <ul class="activity-list"><li v-for="(item, index) in demoActivity" :key="item.when"><span class="activity-rail" aria-hidden="true"><span class="rail-dot" :class="{ first: index === 0 }"></span></span><span class="activity-copy"><small>{{ item.when }}</small><span class="activity-bubble"><span class="avatar avatar-sm" :class="`avatar-${index + 1}`">{{ item.who.slice(0, 1) }}</span>{{ item.who }}{{ item.text }}</span></span></li></ul>
          </section>
          <section class="panel side-panel" aria-labelledby="pending-title">
            <div class="side-heading"><h2 id="pending-title">待我处理</h2><span class="side-demo-tag">示例数据</span></div>
            <div class="pending-list"><div v-for="item in demoPending" :key="item.title" class="pending-card"><span class="pending-icon"><AppIcon name="check" :size="18" /></span><span class="pending-copy"><strong>{{ item.title }}</strong><small>{{ item.detail }}</small></span><span class="pending-link">查看事项<AppIcon name="arrow" :size="14" /></span></div></div>
          </section>
          <section class="quick-access" aria-labelledby="quick-access-title"><h2 id="quick-access-title">继续工作</h2><RouterLink to="/chat" class="shortcut"><span class="shortcut-icon"><AppIcon name="message" :size="21" /></span><span><strong>进入群聊</strong><small>与成员交流，让工作继续</small></span><AppIcon name="chevron" :size="16" /></RouterLink><RouterLink to="/status" class="shortcut"><span class="shortcut-icon"><AppIcon name="activity" :size="21" /></span><span><strong>查看成员状态</strong><small>了解谁在线、谁正在工作</small></span><AppIcon name="chevron" :size="16" /></RouterLink><p class="quick-note">每个项目都有自己的成员、群组和协作记录。</p></section>
          </template>
        </template>
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
.group-body { padding-top: 10px; }
.member-row { display: flex; align-items: center; gap: 8px; padding: 7px; border: 1px solid var(--border); border-radius: 9px; background: var(--card-bg); }
.member-open-btn { width: 100%; text-align: left; color: var(--fg); cursor: pointer; }.member-open-btn:hover { background: var(--surface-subtle); }.member-open-btn.is-selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); background: var(--accent-soft); }
.member-copy { flex: 1; min-width: 0; }.member-copy strong { display: block; font-size: .8rem; font-weight: 600; }.member-copy small { display: block; font-size: .7rem; color: var(--muted); margin-top: 1px; }
.avatar { flex: none; width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; color: #1d1d1f; font-size: .78rem; font-weight: 600; background: #dfe3ea; position: relative; }
.avatar:not(.avatar-0)::after { content: ""; position: absolute; right: -1px; bottom: -1px; width: 9px; height: 9px; border-radius: 50%; background: var(--ok); border: 2px solid var(--card-bg); }
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
.task-select-label { font-size: .84rem; color: var(--muted); }.task-select { min-height: 32px; }
.taskflow-panel .section-heading { margin-bottom: 16px; }
.taskflow-board { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 44px; }
.taskflow-stage { position: relative; border: 1px solid var(--border); border-radius: 12px; background: var(--card-bg); box-shadow: var(--shadow); }
.taskflow-stage.active { border: 2px solid var(--accent); background: var(--accent-soft); }
.stage-head { display: flex; align-items: center; gap: 9px; padding: 13px 16px; border-bottom: 1px solid var(--border); font-size: .95rem; }
.stage-icon { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; color: #fff; background: var(--ok); flex: none; }.stage-icon.active { background: var(--accent-fill); }.stage-icon.wait { background: transparent; color: var(--muted); border: 1px solid var(--control-border); }.stage-icon.idle { background: transparent; color: var(--muted); border: 1px solid var(--control-border); }
.stage-body { padding: 16px; }.stage-person { display: flex; align-items: center; gap: 9px; margin-bottom: 12px; }.stage-person strong { font-size: .9rem; }
.stage-desc { font-size: .84rem; color: var(--fg); margin: 0 0 6px; line-height: 1.5; }.stage-sub { font-size: .8rem; color: var(--muted); margin: 0 0 6px; }
.stage-link { display: flex; align-items: center; gap: 9px; margin: 14px 0; padding: 10px 11px; border: 1px solid var(--border); border-radius: 9px; background: var(--card-bg); }.link-icon { color: var(--muted); }.stage-link > span:nth-child(2) { flex: 1; min-width: 0; }.stage-link strong { display: block; font-size: .8rem; }.stage-link small { display: block; font-size: .72rem; color: var(--muted); margin-top: 2px; }.link-cta { font-size: .74rem; color: var(--accent); white-space: nowrap; }
.stage-foot { display: flex; align-items: center; gap: 7px; margin-top: 14px; font-size: .78rem; color: var(--muted); }.foot-icon { color: var(--ok); display: inline-flex; }.foot-icon.active { color: var(--accent); }.foot-icon.wait, .foot-icon.idle { color: var(--muted); }
.stage-arrow { position: absolute; right: -32px; top: 50%; transform: translateY(-50%); color: var(--muted); font-size: 1.2rem; }.stage-arrow.down { right: auto; left: 50%; top: auto; bottom: -28px; transform: translateX(-50%); }.stage-arrow.left { right: auto; left: -32px; }
.taskflow-handoff { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 20px; padding: 13px 16px; border: 1px solid var(--border); border-radius: 10px; background: var(--card-bg); font-size: .82rem; }.taskflow-handoff > .app-icon { color: var(--muted); }.taskflow-handoff strong { margin-right: 4px; }.handoff-arrow { color: var(--muted); }.handoff-note { color: var(--accent); }
.task-detail-title { display: flex; align-items: center; gap: 10px; margin: 16px 0; padding-bottom: 14px; border-bottom: 1px solid var(--border); }.task-detail-title strong { flex: 1; font-size: .96rem; }.task-detail-icon { width: 34px; height: 34px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 9px; }
.task-facts { margin: 0; }.task-facts > div { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--border); font-size: .82rem; }.task-facts dt { display: flex; align-items: center; gap: 7px; width: 96px; flex: none; color: var(--muted); }.task-facts dd { margin: 0; font-weight: 500; }
.task-section { margin-top: 18px; }.task-section h3 { margin: 0 0 10px; font-size: .88rem; }.checklist { list-style: none; margin: 0; padding: 0; }.checklist li { display: flex; align-items: center; gap: 9px; padding: 6px 0; font-size: .82rem; }.checkbox { width: 15px; height: 15px; border: 1px solid var(--control-border); border-radius: 4px; flex: none; }.task-discussion { display: flex; align-items: center; justify-content: space-between; padding-top: 14px; border-top: 1px solid var(--border); font-size: .84rem; }.task-discussion > span:first-child { display: inline-flex; align-items: center; gap: 8px; }.discussion-link { color: var(--accent); }.recent-activity { display: flex; align-items: center; gap: 8px; margin: 0; font-size: .82rem; color: var(--muted); }
.conv-person { display: flex; align-items: center; gap: 9px; margin: 16px 0 12px; flex-wrap: wrap; }.conv-avatar { width: 40px; height: 40px; font-size: 1rem; }.conv-person-copy { flex: 1; min-width: 0; }.conv-person-copy strong { display: block; font-size: .96rem; }.conv-person-copy small { display: block; font-size: .74rem; color: var(--muted); margin-top: 3px; }.conv-online { display: inline-flex; align-items: center; gap: 5px; font-size: .74rem; color: var(--ok); }
.conv-task { width: 100%; display: flex; align-items: center; gap: 9px; padding: 10px 11px; border: 1px solid var(--border); border-radius: 9px; background: var(--card-bg); color: var(--fg); font-size: .8rem; text-align: left; }.conv-task-icon { color: var(--muted); }.conv-task > span:nth-child(2) { flex: 1; }.conv-sync { margin: 8px 0 0; }
.conv-tabs { display: flex; gap: 22px; margin-top: 14px; border-bottom: 1px solid var(--border); }.conv-tabs button { border: 0; border-radius: 0; background: transparent; padding: 8px 0; font-size: .84rem; color: var(--muted); min-height: 0; }.conv-tabs button[aria-selected="true"] { color: var(--fg); font-weight: 600; box-shadow: inset 0 -2px var(--accent); }
.conv-day { text-align: center; font-size: .72rem; color: var(--muted); margin: 16px 0; position: relative; }.conv-day::before, .conv-day::after { content: ""; position: absolute; top: 50%; width: 28%; height: 1px; background: var(--border); }.conv-day::before { left: 0; }.conv-day::after { right: 0; }
.conv-messages { display: flex; flex-direction: column; gap: 16px; }.conv-msg { display: flex; align-items: flex-start; gap: 9px; }.conv-msg.mine { justify-content: flex-end; }.conv-msg-body { flex: 1; min-width: 0; max-width: 85%; }.conv-msg.mine .conv-msg-body { flex: none; }.conv-msg-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; font-size: .8rem; }.conv-msg-meta.right { justify-content: flex-end; }.conv-tag { font-size: .68rem; color: var(--muted); background: var(--surface-subtle); padding: 1px 6px; border-radius: 4px; }.conv-bubble { display: inline-block; margin: 0; padding: 9px 11px; border: 1px solid var(--border); border-radius: 10px; background: var(--card-bg); font-size: .82rem; line-height: 1.5; overflow-wrap: anywhere; }.conv-bubble.mine { background: var(--accent-soft); border-color: transparent; }.conv-locate { align-self: flex-start; display: inline-flex; align-items: center; gap: 5px; font-size: .76rem; color: var(--accent); }
.conv-new { align-self: center; margin: 6px auto 0; padding: 6px 14px; font-size: .78rem; color: var(--accent); background: var(--accent-soft); border-color: transparent; border-radius: 20px; }.conv-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); font-size: .78rem; }.conv-footer > span { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }.conv-footer button { border: 0; background: transparent; color: var(--accent); font-size: .78rem; min-height: 0; padding: 0; }
@media (max-width: 1100px) { .collab-workspace { grid-template-columns: 1fr; gap: 20px; }.collab-side { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); align-items: start; gap: 16px; }.collab-side .quick-access { grid-column: 1 / -1; } }
@media (max-width: 760px) {
  .collab-workspace { gap: 16px; }.collab-main, .collab-side { gap: 16px; }.collab-side { display: flex; flex-direction: column; }
  .collab-toolbar { padding: 10px 12px; gap: 8px 10px; }.toolbar-views, .toolbar-layers { flex-wrap: wrap; }
  .collab-header-meta { justify-content: flex-start; }
  .graph-canvas { padding: 16px 12px; }.graph-footer { align-items: flex-start; }
  .taskflow-board { grid-template-columns: 1fr; gap: 22px; }.stage-arrow { display: none; }
  .overview-metrics { padding: 18px 0; }.overview-metrics > div { padding: 0 14px; }.overview-metrics dd { font-size: 1.7rem; }.overview-metrics span { display: none; }.overview-metrics dt { font-size: .78rem; }
  .service-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }.project-activity small { display: none; }
  .service-details > summary { padding: 14px; }.service-body { padding: 16px; }
}
</style>
