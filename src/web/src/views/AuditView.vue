<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { ApiError, api, type AuditEntryDto, type ProjectDto } from "../api/client.ts";

/**
 * T5（#52）审计查看与人的撤销权（最小可用）。
 *
 * 信息架构按 #32/#33 收口：审计查看与撤销合并在一个轻量页面里。
 * 人在这里浏览某项目的审计事件，并对「可逆」事件发起撤销（org:revoke，仅人；agent 被服务端拒绝）。
 * 永久删除（project.delete / group.delete）与状态可逆（archive/restore）在页面侧置灰并说明原因。
 */

const projects = ref<ProjectDto[]>([]);
const activeProjectId = ref<string | null>(null);
const entries = ref<AuditEntryDto[]>([]);

const loading = ref(true);
const revokingId = ref<string | null>(null);
const busy = computed(() => loading.value || revokingId.value !== null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

// 与 `src/server/audit.ts` 的可逆/永久/状态可逆集合保持一致（仅用于前端置灰与提示）。
const REVERSIBLE = new Set([
  "member.add",
  "member.remove",
  "member.pause",
  "member.resume",
  "member.status_change",
  "member.revoke",
  "org.node_create",
  "org.node_update",
  "org.node_delete",
  "org.assign",
  "org.auto_place",
  "org.revoke",
]);
const PERMANENT = new Set(["project.delete", "group.delete"]);
const STATE_REVERSIBLE = new Set([
  "project.archive",
  "project.restore",
  "group.archive",
  "group.restore",
]);

const ACTION_LABEL: Record<string, string> = {
  "member.add": "添加成员",
  "member.remove": "移除成员",
  "member.pause": "停用成员",
  "member.resume": "启用成员",
  "member.status_change": "变更成员状态",
  "member.revoke": "撤销成员变更",
  "org.node_create": "创建岗位",
  "org.node_update": "修改岗位",
  "org.node_delete": "删除岗位",
  "org.assign": "占岗 / 腾岗",
  "org.auto_place": "自动分配岗位",
  "org.revoke": "撤销组织变更",
  "project.archive": "归档项目",
  "project.restore": "恢复项目",
  "project.delete": "永久删除项目",
  "group.archive": "归档群组",
  "group.restore": "恢复群组",
  "group.delete": "永久删除群组",
};

const TARGET_LABEL: Record<string, string> = {
  member: "成员",
  node: "岗位",
  role: "角色",
  capability: "能力",
  group: "群组",
  project: "项目",
};

const activeProject = computed(
  () => projects.value.find((p) => p.id === activeProjectId.value) ?? null,
);

function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

function canRevoke(entry: AuditEntryDto): boolean {
  return !entry.reversedAt && REVERSIBLE.has(entry.action);
}

function revokeReason(entry: AuditEntryDto): string | null {
  if (entry.reversedAt) return "已撤销";
  if (PERMANENT.has(entry.action)) return "永久删除，不可撤销";
  if (STATE_REVERSIBLE.has(entry.action)) return "归档/恢复属状态可逆，请用正向操作复原";
  if (!REVERSIBLE.has(entry.action)) return "该操作不可撤销";
  return null;
}

function clearMessages(): void {
  error.value = null;
  notice.value = null;
}

async function loadProjects(): Promise<void> {
  loading.value = true;
  clearMessages();
  try {
    const res = await api.listProjects({ includeArchived: true });
    projects.value = res.projects;
    if (activeProjectId.value === null && projects.value.length > 0) {
      activeProjectId.value = projects.value[0]!.id;
    }
    await loadAudit(true);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function loadAudit(preserveFeedback = false): Promise<void> {
  const projectId = activeProjectId.value;
  if (projectId === null) {
    entries.value = [];
    return;
  }
  loading.value = true;
  if (!preserveFeedback) clearMessages();
  try {
    const res = await api.listAudit(projectId);
    if (activeProjectId.value === projectId) entries.value = res.entries;
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function revoke(entry: AuditEntryDto): Promise<void> {
  const projectId = activeProjectId.value;
  if (busy.value || projectId === null || !canRevoke(entry)) return;
  revokingId.value = entry.id;
  clearMessages();
  try {
    await api.revokeAudit(projectId, entry.id);
    notice.value = `已撤销「${actionLabel(entry.action)}」事件。`;
    await loadAudit(true);
  } catch (e) {
    error.value =
      e instanceof ApiError ? `${e.message}${e.code ? `（${e.code}）` : ""}` : String(e);
  } finally {
    revokingId.value = null;
  }
}

function selectProject(): void {
  entries.value = [];
  void loadAudit();
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

onMounted(loadProjects);
</script>

<template>
  <section class="page audit-page">
    <header class="page-header">
      <div>
        <h1>审计与撤销</h1>
        <p class="page-description">查看项目变更记录，撤销允许恢复的操作。</p>
      </div>
      <button type="button" class="secondary" :disabled="busy" data-testid="audit-refresh" @click="activeProjectId === null ? loadProjects() : loadAudit()">刷新记录</button>
    </header>

    <p v-if="error" class="error" role="alert" data-testid="audit-error">{{ error }}</p>
    <p v-if="notice" class="notice" role="status" data-testid="audit-notice">{{ notice }}</p>

    <section class="panel audit-panel" aria-labelledby="audit-records-title" :aria-busy="busy">
      <div class="audit-toolbar">
        <div>
          <h2 id="audit-records-title">变更记录</h2>
          <p class="muted small">{{ entries.length }} 条记录<span v-if="activeProject?.archivedAt"> · 项目已归档</span></p>
        </div>
        <label class="field audit-project-field" for="audit-project">
          项目
          <select id="audit-project" v-model="activeProjectId" :disabled="busy || projects.length === 0" @change="selectProject" data-testid="audit-project-select">
            <option v-if="projects.length === 0" :value="null">{{ loading ? '正在加载项目…' : error ? '未能加载项目' : '暂无项目' }}</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </label>
      </div>

      <p v-if="loading" class="muted small" role="status">正在加载变更记录…</p>
      <div v-else-if="projects.length === 0 && !error" class="empty-state">
        <h3>还没有项目</h3>
        <p>创建项目并开始协作后，变更记录会显示在这里。</p>
        <RouterLink to="/projects">前往项目与群组</RouterLink>
      </div>
      <div v-else-if="entries.length === 0 && !error" class="empty-state">
        <h3>该项目暂无审计事件</h3>
        <p>成员和岗位的变更会自动留下记录。</p>
      </div>

      <div v-if="entries.length > 0" class="table-scroll audit-scroll" role="region" aria-label="项目审计事件" tabindex="0">
        <table class="audit-table" data-testid="audit-list">
          <caption class="visually-hidden">{{ activeProject?.name }}的审计事件与可用撤销操作</caption>
          <thead>
            <tr>
              <th scope="col">时间</th>
              <th scope="col">主体</th>
              <th scope="col">操作</th>
              <th scope="col">对象</th>
              <th scope="col">状态</th>
              <th scope="col" class="col-act">撤销</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in entries" :key="entry.id" data-testid="audit-row">
              <td class="audit-time"><time :datetime="entry.createdAt" :title="entry.createdAt">{{ formatTime(entry.createdAt) }}</time></td>
              <td><span class="badge">{{ entry.actorKind === 'human' ? '人' : entry.actorKind === 'agent' ? 'Agent' : entry.actorKind }}</span><span class="cell-value">{{ entry.actorName }}</span></td>
              <td>{{ actionLabel(entry.action) }}</td>
              <td><span class="muted small">{{ TARGET_LABEL[entry.targetKind] ?? entry.targetKind }}</span><span class="cell-value">{{ entry.targetName || entry.targetId }}</span></td>
              <td>
                <span v-if="entry.reversedAt" class="badge">已撤销</span>
                <span v-else-if="revokeReason(entry)" class="muted small">{{ revokeReason(entry) }}</span>
                <span v-else class="badge ok">可撤销</span>
              </td>
              <td class="col-act">
                <button v-if="canRevoke(entry)" type="button" class="secondary" :disabled="busy" :aria-label="`撤销${actionLabel(entry.action)}：${entry.targetName || entry.targetId}`" data-testid="audit-revoke" @click="revoke(entry)">
                  {{ revokingId === entry.id ? '撤销中…' : '撤销' }}
                </button>
                <span v-else class="muted small">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <details class="audit-help">
        <summary>哪些操作可以撤销？</summary>
        <p class="muted small">可撤销的成员与岗位变更会显示「撤销」按钮，此操作仅限人发起。永久删除不可恢复；归档与恢复请前往项目与群组执行相反操作。</p>
      </details>
    </section>
  </section>
</template>

<style scoped>
.audit-toolbar { display: flex; align-items: end; justify-content: space-between; gap: 1.5rem; margin-bottom: 1.25rem; }
.audit-toolbar h2 { margin: 0; font-size: 1.05rem; }
.audit-toolbar p { margin: .35rem 0 0; }
.audit-project-field { width: min(100%, 18rem); }
.audit-scroll { margin-inline: -.25rem; }
.audit-table { width: 100%; min-width: 760px; border-collapse: collapse; font-size: .9rem; }
.audit-table th, .audit-table td { padding: .9rem .75rem; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; overflow-wrap: anywhere; max-width: 18rem; }
.audit-table th { font-size: .8rem; font-weight: 500; color: var(--muted); background: var(--surface-subtle); }
.audit-table tbody tr:last-child td { border-bottom: 0; }
.audit-table tbody tr:hover { background: var(--surface-subtle); }
.audit-time { font-size: .8rem; font-variant-numeric: tabular-nums; width: 10rem; }
.cell-value { display: block; margin-top: .25rem; }
.col-act { width: 7rem; white-space: nowrap; }
.audit-help { border-top: 1px solid var(--border); margin-top: 1rem; padding-top: 1rem; }
.audit-help summary { color: var(--muted); cursor: pointer; font-size: .85rem; }
.audit-help p { max-width: 64ch; line-height: 1.7; }
@media (max-width: 620px) { .audit-toolbar { align-items: stretch; flex-direction: column; gap: 1rem; } .audit-project-field { width: 100%; } }
</style>
