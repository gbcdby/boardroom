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
const serviceLabel = computed(() => healthError.value ? "暂时无法连接" : !health.value ? "正在连接" : health.value.status === "ok" ? "服务正常" : "服务需要关注");
const wsLabel = computed(() => connection.value === "connected" ? "实时连接正常" : connection.value === "connecting" ? "实时连接中" : "连接中断，正在重连");
const shortcuts = [
  { to: "/chat", icon: "message", title: "进入群聊", detail: "与成员交流，让工作继续" },
  { to: "/runtimes", icon: "layers", title: "管理托管 Agent", detail: "查看配置与实际运行状态" },
  { to: "/status", icon: "activity", title: "查看成员状态", detail: "了解谁在线、谁正在工作" },
];
const unavailableReason = ref<string | null>(null);
function explainUnavailable(label: string): void {
  unavailableReason.value = `「${label}」尚未接通真实数据，等待协作关系读模型接入后再开放。`;
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
  await Promise.allSettled([
    refreshHealth(),
    context.refreshProjects(),
  ]);
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
    <header class="page-header"><div><h1>协作总览</h1><p class="page-description">项目、对话与 Agent，在这里有序协作。</p></div><RouterLink to="/projects?create=project" class="primary"><AppIcon name="plus" :size="17" />创建项目</RouterLink></header>
    <div v-if="projectError" class="error" role="alert">项目暂时无法加载：{{ projectError }} <button type="button" class="text-button" :disabled="refreshing" @click="refresh">重新加载</button></div>

    <section class="collab-toolbar" aria-label="协作总览工具条">
      <div class="toolbar-scope"><span class="toolbar-label">范围</span><button type="button" class="toolbar-control scope-control" aria-disabled="true" title="范围切换尚未接通，等待真实读模型接入" data-testid="p01-scope" @click="explainUnavailable('范围切换')"><AppIcon name="layers" :size="16" />全部项目<AppIcon name="chevron" :size="14" /></button></div>
      <div class="toolbar-views" role="group" aria-label="视图切换，尚未接通">
        <button type="button" class="view-tab" aria-pressed="true" aria-disabled="true" title="成员关系视图尚未接通真实数据" @click="explainUnavailable('成员关系视图')">成员关系</button>
        <button type="button" class="view-tab" aria-pressed="false" aria-disabled="true" title="任务流转视图尚未接通真实数据" @click="explainUnavailable('任务流转视图')">任务流转</button>
      </div>
      <div class="toolbar-layers" role="group" aria-label="关系图层，尚未接通">
        <label class="layer-option"><input type="checkbox" aria-disabled="true" @click.prevent="explainUnavailable('协作关系图层')" />协作关系</label>
        <label class="layer-option"><input type="checkbox" aria-disabled="true" @click.prevent="explainUnavailable('消息方向图层')" />消息方向</label>
      </div>
      <button type="button" class="toolbar-control filter-control" aria-disabled="true" title="成员筛选尚未接通，等待真实读模型接入" @click="explainUnavailable('成员筛选')">全部成员<AppIcon name="chevron" :size="14" /></button>
      <p class="toolbar-hint muted small">图视图、图层与筛选尚未接通真实读模型。</p>
    </section>
    <p v-if="unavailableReason" class="collab-status muted small" role="status" data-testid="p01-unconnected-status">{{ unavailableReason }}</p>

    <div class="collab-workspace">
      <div class="collab-main">
        <section class="panel graph-panel" aria-labelledby="graph-title">
          <div class="section-heading"><div><h2 id="graph-title">协作关系图</h2><p class="muted small">下方「你的项目」是关系图的等价可读列表；节点、关系边与消息方向尚未接通。</p></div></div>
          <div class="graph-canvas" role="img" aria-label="协作关系图画布：尚未接通真实关系数据，当前不显示任何节点、关系边或消息方向。" data-testid="p01-graph-canvas">
            <div class="graph-placeholder" data-testid="p01-graph-placeholder">
              <AppIcon name="layers" :size="34" />
              <strong>尚未接通真实关系数据</strong>
              <p>等待协作关系读模型接入后再显示项目、群与成员节点，以及带来源的关系边。此处不展示示例节点或示例连线。</p>
            </div>
          </div>
          <div class="graph-footer">
            <ul class="graph-legend" aria-label="关系图图例，尚未接通真实数据"><li><span class="legend-line" aria-hidden="true"></span>协作关系</li><li><span class="legend-line legend-arrow" aria-hidden="true"></span>消息方向</li><li>连接状态</li><li class="legend-note">图例仅示意结构，未接通真实数据</li></ul>
            <div class="graph-controls" role="group" aria-label="画布操作，尚未接通">
              <button type="button" aria-label="缩小画布，尚未接通" aria-disabled="true" title="缩放尚未接通，等待真实读模型接入" @click="explainUnavailable('缩小画布')">−</button>
              <span class="zoom-value">缩放未接通</span>
              <button type="button" aria-label="放大画布，尚未接通" aria-disabled="true" title="缩放尚未接通，等待真实读模型接入" @click="explainUnavailable('放大画布')">+</button>
              <button type="button" aria-label="适应画布，尚未接通" aria-disabled="true" title="适应画布尚未接通，等待真实读模型接入" @click="explainUnavailable('适应画布')">适应画布</button>
              <button type="button" aria-label="重置视图，尚未接通" aria-disabled="true" title="重置视图尚未接通，等待真实读模型接入" @click="explainUnavailable('重置视图')">重置视图</button>
            </div>
          </div>
        </section>
        <dl class="overview-metrics" :aria-busy="loading">
          <div><dt>进行中的项目</dt><dd>{{ loading || projectError ? '—' : projects.length }}</dd><span>未归档的协作空间</span></div>
          <div><dt>当前活跃</dt><dd>{{ loading || projectError ? '—' : activeCount }}</dd><span>有成员在线的项目</span></div>
          <div><dt>群组</dt><dd>{{ loading || projectError ? '—' : groupCount }}</dd><span>按项目组织交流</span></div>
        </dl>
        <section class="panel project-overview" aria-labelledby="projects-title">
          <div class="section-heading"><h2 id="projects-title">你的项目</h2><button type="button" class="text-button" :disabled="refreshing" @click="refresh">{{ refreshing ? '刷新中…' : '刷新' }}</button></div>
          <p v-if="loading" class="muted loading-state" role="status">正在读取项目…</p>
          <div v-else-if="!projectError && projects.length === 0" class="empty-state"><span class="empty-icon"><AppIcon name="folder" :size="30" /></span><h3>从一个项目开始</h3><p>添加成员，创建群组，开始你的第一段协作。</p><RouterLink to="/projects?create=project" class="secondary">创建第一个项目<AppIcon name="arrow" :size="16" /></RouterLink></div>
          <ul v-else class="home-projects"><li v-for="project in projects" :key="project.id"><RouterLink :to="projectPath(project.id)" class="home-project-link"><span class="project-monogram">{{ project.name.slice(0, 1) }}</span><span class="project-copy"><strong>{{ project.name }}</strong><span>{{ project.memberCount ?? 0 }} 位成员<span aria-hidden="true"> · </span>{{ project.groupCount ?? 0 }} 个群组</span></span><span class="project-activity"><span class="badge" :class="{ ok: project.status === 'active' }">{{ project.status === 'active' ? '活跃' : '空闲' }}</span><small>{{ recentActivity(project.lastActivityAt) }}</small></span><AppIcon name="chevron" :size="16" /></RouterLink></li></ul>
          <RouterLink v-if="projects.length" to="/projects" class="manage-projects">管理项目与群组<AppIcon name="arrow" :size="15" /></RouterLink>
        </section>
      </div>
      <aside class="collab-side" aria-label="动态与待我处理">
        <section class="panel side-panel" aria-labelledby="activity-title">
          <div class="side-heading"><h2 id="activity-title">实时动态</h2><button type="button" class="auto-track" role="switch" aria-checked="false" aria-disabled="true" title="自动跟踪尚未接通，等待事件流接入" @click="explainUnavailable('自动跟踪')"><span class="switch-track" aria-hidden="true"></span>自动跟踪</button></div>
          <div class="side-slot" data-testid="p01-activity-slot"><p class="muted small">尚未接通真实动态数据，等待事件流接入。</p></div>
        </section>
        <section class="panel side-panel" aria-labelledby="pending-title">
          <h2 id="pending-title">待我处理</h2>
          <div class="side-slot" data-testid="p01-pending-slot"><p class="muted small">尚未接通待我处理数据，等待真实待办事项接入。</p></div>
        </section>
        <section class="quick-access" aria-labelledby="quick-access-title"><h2 id="quick-access-title">继续工作</h2><RouterLink v-for="item in shortcuts" :key="item.to" :to="item.to" class="shortcut"><span class="shortcut-icon"><AppIcon :name="item.icon" :size="21" /></span><span><strong>{{ item.title }}</strong><small>{{ item.detail }}</small></span><AppIcon name="chevron" :size="16" /></RouterLink><p class="quick-note">每个项目都有自己的成员、群组和协作记录。</p></section>
      </aside>
    </div>
    <details class="service-details"><summary><span class="service-title"><AppIcon name="server" :size="18" />本地服务</span><span class="service-state" :class="healthError || health?.status === 'degraded' ? 'bad' : health ? 'ok' : 'muted'">{{ serviceLabel }}</span></summary><div class="service-body"><p class="muted small">{{ wsLabel }}。此处显示服务连接情况，成员的工作状态请查看状态看板。</p><p v-if="healthError" class="error" role="alert">健康检查失败：{{ healthError }}</p><dl class="service-grid"><div><dt>数据库</dt><dd>{{ healthError ? '连接未知' : !health ? '正在检查…' : health.database.writable ? '可读写' : '需要检查' }}</dd></div><div><dt>运行时长</dt><dd>{{ health ? uptime(health.uptimeSeconds) : '—' }}</dd></div><div><dt>数据库版本</dt><dd>{{ health?.migrations.version ?? '—' }}</dd></div><div><dt>心跳间隔 / 超时</dt><dd>{{ health ? `${health.heartbeat.intervalMs / 1000}s / ${health.heartbeat.timeoutMs / 1000}s` : '—' }}</dd></div></dl><details v-if="lastEvent" class="event-details"><summary>最近连接事件</summary><pre>{{ lastEvent }}</pre></details></div></details>
  </section>
</template>

<style scoped>
.collab-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 12px 16px; margin-bottom: 16px; box-shadow: var(--shadow); }
.toolbar-scope, .toolbar-views, .toolbar-layers { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.toolbar-label { color: var(--muted); font-size: .83rem; flex: none; }
.toolbar-control { min-height: 34px; padding: .3rem .65rem; font-size: .86rem; }
.toolbar-control[aria-disabled="true"], .view-tab[aria-disabled="true"], .auto-track[aria-disabled="true"], .graph-controls button[aria-disabled="true"] { cursor: not-allowed; color: var(--muted); }
.toolbar-views, .toolbar-layers { border: 1px solid var(--border); border-radius: 9px; padding: 3px; background: var(--surface-subtle); }
.view-tab { min-height: 30px; padding: .2rem .7rem; font-size: .85rem; border-color: transparent; background: transparent; }
.view-tab[aria-pressed="true"] { color: var(--fg); background: var(--card-bg); border-color: var(--border); }
.layer-option { display: inline-flex; align-items: center; gap: 6px; font-size: .85rem; color: var(--fg); white-space: nowrap; cursor: pointer; }
.toolbar-hint { flex: 1 1 100%; margin: 0; }
.collab-status { margin: 0 0 16px; overflow-wrap: anywhere; }
.collab-workspace { display: grid; grid-template-columns: minmax(0,1fr) minmax(260px,320px); gap: 24px; align-items: start; }
.collab-main, .collab-side { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
.collab-side .panel + .panel { margin-top: 0; }
.graph-panel .section-heading { margin-bottom: 16px; }
.graph-panel .section-heading p { margin: 6px 0 0; }
.graph-canvas { display: grid; place-items: center; min-height: 360px; border: 1px dashed var(--border); border-radius: 10px; background: var(--surface-subtle); padding: 24px; }
.graph-placeholder { max-width: 30rem; text-align: center; color: var(--muted); }
.graph-placeholder .app-icon { color: var(--muted); }
.graph-placeholder strong { display: block; margin-top: 12px; color: var(--fg); font-size: 1.02rem; }
.graph-placeholder p { font-size: .86rem; margin: 8px 0 0; overflow-wrap: anywhere; }
.graph-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; margin-top: 14px; }
.graph-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; list-style: none; margin: 0; padding: 0; font-size: .8rem; color: var(--muted); }
.graph-legend li { display: inline-flex; align-items: center; gap: 6px; }
.legend-line { width: 22px; height: 0; border-top: 2px solid var(--relation); }
.legend-arrow { position: relative; }
.legend-arrow::after { content: "›"; position: absolute; right: -4px; top: -11px; font-size: 1rem; color: var(--relation); }
.graph-legend .legend-note { color: var(--muted); }
.graph-controls { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.graph-controls button { min-height: 34px; padding: .25rem .65rem; font-size: .84rem; }
.zoom-value { color: var(--muted); font-size: .82rem; font-variant-numeric: tabular-nums; }
.side-panel h2 { font-size: 1.02rem; margin: 0; }
.side-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.auto-track { display: inline-flex; align-items: center; gap: 7px; min-height: 30px; padding: .15rem .4rem; border-color: transparent; background: transparent; font-size: .8rem; font-weight: 400; }
.switch-track { width: 26px; height: 15px; border: 1px solid var(--control-border); border-radius: 9px; background: var(--surface-subtle); }
.side-slot { min-height: 96px; margin-top: 14px; padding: 14px; border: 1px dashed var(--border); border-radius: 9px; background: var(--surface-subtle); }
.side-slot p { margin: 0; overflow-wrap: anywhere; }
.overview-metrics { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); background: var(--card-bg); border: 1px solid var(--border); border-radius: 13px; margin: 0; padding: 24px 0; box-shadow: var(--shadow); }
.overview-metrics > div { padding: 0 28px; }.overview-metrics > div + div { border-left: 1px solid var(--border); }
.overview-metrics dt { font-size: .87rem; color: var(--muted); }.overview-metrics dd { margin: 5px 0 3px; font-size: 2.15rem; font-weight: 600; line-height: 1.3; font-variant-numeric: tabular-nums; letter-spacing: -.05em; }.overview-metrics span { font-size: .78rem; color: var(--muted); }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 9px; }.section-heading h2 { margin: 0; }.section-heading button { margin-right: -10px; }
.home-projects { list-style: none; margin: 0 -10px; padding: 0; }.home-projects li + li { border-top: 1px solid var(--border); }
.home-project-link { display: flex; gap: 12px; align-items: center; padding: 20px 10px; border-radius: 8px; color: var(--fg); min-width: 0; }.home-project-link:hover { background: var(--surface-subtle); text-decoration: none; }
.project-monogram { width: 40px; height: 40px; display: grid; place-items: center; border-radius: 10px; color: var(--accent); background: var(--accent-soft); font-weight: 600; flex: 0 0 auto; }
.project-copy { flex: 1; min-width: 0; }.project-copy strong { display: block; font-size: .96rem; font-weight: 600; overflow-wrap: anywhere; }.project-copy > span { display: block; color: var(--muted); font-size: .8rem; margin-top: 4px; }
.project-activity { text-align: right; flex: 0 0 auto; }.project-activity small { display: block; margin-top: 5px; color: var(--muted); font-size: .74rem; }.home-project-link > .app-icon { color: var(--muted); }
.manage-projects { display: flex; align-items: center; justify-content: center; gap: 8px; border-top: 1px solid var(--border); padding-top: 18px; margin-top: 4px; font-size: .86rem; }
.quick-access { padding: 6px 0; }.quick-access h2 { margin-bottom: 16px; }.shortcut { display: flex; align-items: center; gap: 13px; padding: 17px 0; color: var(--fg); border-bottom: 1px solid var(--border); }.shortcut:hover { color: var(--accent); text-decoration: none; }.shortcut-icon { color: var(--muted); }.shortcut > span:nth-child(2) { flex: 1; min-width: 0; }.shortcut strong { display: block; font-weight: 500; font-size: .94rem; }.shortcut small { display: block; color: var(--muted); font-size: .8rem; margin-top: 4px; }.shortcut > .app-icon { color: var(--muted); }.quick-note { color: var(--muted); font-size: .8rem; margin-top: 20px; }
.empty-icon { display: inline-grid; place-items: center; width: 64px; height: 64px; color: var(--accent); background: var(--accent-soft); border-radius: 18px; margin-bottom: 20px; }.empty-state { padding: 38px 8px; }.empty-state p { font-size: .88rem; }.loading-state { padding: 36px 0; }
.service-details { margin-top: 30px; border: 1px solid var(--border); border-radius: 11px; background: var(--card-bg); }.service-details > summary { padding: 16px 20px; font-size: .85rem; }.service-title { display: inline-flex; align-items: center; gap: 10px; margin-left: 6px; }.service-state { float: right; font-size: .8rem; font-weight: 400; }.service-body { border-top: 1px solid var(--border); padding: 18px 24px; }.service-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 16px; margin: 20px 0 0; }.service-grid dt { font-size: .8rem; color: var(--muted); }.service-grid dd { margin: 6px 0 0; font-size: .9rem; }.event-details { margin-top: 20px; font-size: .8rem; }.event-details pre { max-height: 150px; overflow: auto; }
@media (max-width: 1100px) { .collab-workspace { grid-template-columns: 1fr; gap: 20px; }.collab-side { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); align-items: start; gap: 16px; }.collab-side .quick-access { grid-column: 1 / -1; }.quick-access { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 12px; }.quick-access h2, .quick-note { grid-column: 1 / -1; margin: 0; }.shortcut { border: 1px solid var(--border); border-radius: 10px; padding: 16px; background: var(--card-bg); }.shortcut > .app-icon, .shortcut-icon { display: none; } }
@media (max-width: 760px) {
  .collab-workspace { gap: 16px; }.collab-main, .collab-side { gap: 16px; }.collab-side { display: flex; flex-direction: column; }
  .collab-toolbar { padding: 10px 12px; gap: 8px 10px; }.toolbar-views, .toolbar-layers { flex-wrap: wrap; }
  .graph-canvas { min-height: 280px; padding: 18px; }.graph-footer { align-items: flex-start; }
  .overview-metrics { padding: 20px 0; }.overview-metrics > div { padding: 0 14px; }.overview-metrics dd { font-size: 1.8rem; }.overview-metrics span { display: none; }.overview-metrics dt { font-size: .79rem; }
  .quick-access { grid-template-columns: 1fr; gap: 8px; }.shortcut { padding: 15px; }.shortcut-icon, .shortcut > .app-icon { display: block; }.quick-access h2 { margin-bottom: 8px; }.quick-note { margin-top: 8px; }
  .service-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }.project-activity small { display: none; }.home-project-link { flex-wrap: wrap; }.project-copy { flex-basis: calc(100% - 78px); }.project-activity { margin-left: 52px; }.home-project-link > .app-icon { margin-left: auto; }
  .service-details > summary { padding: 14px; }.service-body { padding: 16px; }
}
</style>
