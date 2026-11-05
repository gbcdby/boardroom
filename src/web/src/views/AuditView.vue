<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
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

const busy = ref(false);
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
  "org.node.create",
  "org.node.update",
  "org.node.delete",
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
  "org.node.create": "创建岗位",
  "org.node.update": "修改岗位",
  "org.node.delete": "删除岗位",
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
  busy.value = true;
  clearMessages();
  try {
    const res = await api.listProjects({ includeArchived: true });
    projects.value = res.projects;
    if (activeProjectId.value === null && projects.value.length > 0) {
      activeProjectId.value = projects.value[0]!.id;
    }
    await loadAudit();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function loadAudit(): Promise<void> {
  if (activeProjectId.value === null) {
    entries.value = [];
    return;
  }
  busy.value = true;
  clearMessages();
  try {
    const res = await api.listAudit(activeProjectId.value);
    entries.value = res.entries;
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function revoke(entry: AuditEntryDto): Promise<void> {
  if (activeProjectId.value === null) return;
  busy.value = true;
  clearMessages();
  try {
    await api.revokeAudit(activeProjectId.value, entry.id);
    notice.value = `已撤销「${actionLabel(entry.action)}」事件。`;
    await loadAudit();
  } catch (e) {
    error.value =
      e instanceof ApiError ? `${e.message}${e.code ? `（${e.code}）` : ""}` : String(e);
  } finally {
    busy.value = false;
  }
}

onMounted(loadProjects);
</script>

<template>
  <section class="card">
    <h1>审计与撤销</h1>
    <p class="muted">
      浏览项目内的可逆操作审计；「可逆」事件可由人发起撤销（撤销权仅人持有）。永久删除与归档/恢复不在此撤销。
    </p>

    <p v-if="error" class="error" data-testid="audit-error">{{ error }}</p>
    <p v-if="notice" class="notice" data-testid="audit-notice">{{ notice }}</p>

    <div class="row">
      <label for="audit-project">项目</label>
      <select id="audit-project" v-model="activeProjectId" @change="loadAudit" data-testid="audit-project-select">
        <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <span v-if="activeProject?.archivedAt" class="badge">已归档</span>
      <span v-if="busy" class="muted small">加载中…</span>
    </div>

    <p v-if="entries.length === 0 && !busy" class="muted">该项目暂无审计事件。</p>

    <table v-else-if="entries.length > 0" class="audit-table" data-testid="audit-list">
      <thead>
        <tr>
          <th>时间</th>
          <th>主体</th>
          <th>操作</th>
          <th>对象</th>
          <th>状态</th>
          <th class="col-act">撤销</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="entry in entries" :key="entry.id" data-testid="audit-row">
          <td class="mono small">{{ entry.createdAt }}</td>
          <td>
            <span class="badge" :class="entry.actorKind">{{ entry.actorKind }}</span>
            {{ entry.actorName }}
          </td>
          <td>{{ actionLabel(entry.action) }}</td>
          <td>
            <span class="muted small">{{ TARGET_LABEL[entry.targetKind] ?? entry.targetKind }}</span>
            {{ entry.targetName || entry.targetId }}
          </td>
          <td>
            <span v-if="entry.reversedAt" class="badge reversed">已撤销</span>
            <span v-else-if="revokeReason(entry)" class="muted small">{{ revokeReason(entry) }}</span>
            <span v-else class="badge ok">可撤销</span>
          </td>
          <td class="col-act">
            <button
              v-if="canRevoke(entry)"
              class="btn danger"
              type="button"
              data-testid="audit-revoke"
              @click="revoke(entry)"
            >
              撤销
            </button>
            <span v-else class="muted small">—</span>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin: 0.75rem 0;
}

.audit-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 0.75rem;
}

.audit-table th,
.audit-table td {
  text-align: left;
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}

.audit-table th {
  font-size: 0.8rem;
  color: var(--muted);
}

.col-act {
  width: 6rem;
  text-align: center;
}

.mono {
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.badge {
  display: inline-block;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  font-size: 0.72rem;
  border: 1px solid var(--border);
  margin-right: 0.25rem;
}

.badge.ok {
  color: var(--ok);
  border-color: var(--ok);
}

.badge.reversed {
  color: var(--bad);
  border-color: var(--bad);
}

.badge.human {
  color: var(--accent);
}

.btn {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.3rem 0.8rem;
  cursor: pointer;
  background: var(--card-bg);
  color: var(--fg);
}

.btn.danger {
  color: var(--bad);
  border-color: var(--bad);
}

.btn.danger:hover {
  background: rgba(180, 35, 24, 0.1);
}
</style>
