<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  ApiError,
  api,
  type OrgNodeDto,
  type OrgSnapshot,
  type ProjectDto,
} from "../api/client.ts";

/**
 * T2（#49）组织树管理页 / 角色配置入口（最小可用）。
 *
 * 信息架构按 #32/#33 收口：一个项目一个组织树，岗位即「角色在节点上的实例」。
 * 人在这里独立建树、配置岗位角色、调整汇报线、指派成员；角色静态枚举与能力点目录
 * 由服务端 `ROLE_CAPABILITIES` 提供，页面只做展示与选择，不自创 RBAC 交互。
 *
 * 覆盖：ORG-01（多层树）、ORG-02/08（建树/自动分配/人可调整）、ORG-04（改汇报线）。
 * 撤销/审计界面属 T5（#52），本页不提供。
 */

type NodeRole = "top_manager" | "sub_manager" | "member";

const projects = ref<ProjectDto[]>([]);
const activeProjectId = ref<string | null>(null);
const snapshot = ref<OrgSnapshot | null>(null);

const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

// 表单状态
const rootName = ref("项目统筹");
const newNodeName = ref("");
const newNodeRole = ref<NodeRole>("member");
const newNodeParentId = ref("");
const unplacedMemberId = ref("");
/** 节点 id → 当前编辑值（每次刷新重置为库里的真实值）。 */
const nameEdits = ref<Record<string, string>>({});
const roleEdits = ref<Record<string, string>>({});
const parentEdits = ref<Record<string, string>>({});
const assignEdits = ref<Record<string, string>>({});

const nodes = computed<OrgNodeDto[]>(() => snapshot.value?.nodes ?? []);
const members = computed(() => snapshot.value?.members ?? []);
const roles = computed(() => snapshot.value?.roles ?? []);
const root = computed(() => nodes.value.find((n) => n.parentId === null) ?? null);
const unplacedMembers = computed(() => members.value.filter((m) => m.nodeId === null));
/** 子岗位可选角色：可建岗且非顶层（顶层 manager 位置由根节点唯一推导）。 */
const childRoles = computed(() =>
  roles.value.filter((r) => r.nodeRole && r.role !== "top_manager" && r.role !== "owner"),
);

function clearMessages(): void {
  error.value = null;
  notice.value = null;
}

async function refresh(): Promise<void> {
  if (activeProjectId.value === null) {
    snapshot.value = null;
    return;
  }
  snapshot.value = await api.getOrg(activeProjectId.value);
  const names: Record<string, string> = {};
  const roleValues: Record<string, string> = {};
  const parents: Record<string, string> = {};
  const assigns: Record<string, string> = {};
  for (const node of snapshot.value.nodes) {
    names[node.id] = node.name;
    roleValues[node.id] = node.role;
    parents[node.id] = node.parentId ?? "";
    assigns[node.id] = node.memberId ?? "";
  }
  nameEdits.value = names;
  roleEdits.value = roleValues;
  parentEdits.value = parents;
  assignEdits.value = assigns;
  if (!nodes.value.some((n) => n.id === newNodeParentId.value)) {
    newNodeParentId.value = root.value?.id ?? "";
  }
  if (!unplacedMembers.value.some((m) => m.id === unplacedMemberId.value)) {
    unplacedMemberId.value = unplacedMembers.value[0]?.id ?? "";
  }
}

async function act<T>(fn: () => Promise<T>, success: string): Promise<void> {
  clearMessages();
  busy.value = true;
  try {
    await fn();
    await refresh();
    notice.value = success;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : (err as Error).message;
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  try {
    const list = await api.listProjects();
    projects.value = list.projects;
    if (list.projects.length > 0) activeProjectId.value = list.projects[0]!.id;
    await refresh();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : (err as Error).message;
  }
});

function selectProject(): void {
  void act(async () => {}, "已切换项目");
}

function requireProject(): string {
  if (activeProjectId.value === null) throw new Error("请先选择一个项目。");
  return activeProjectId.value;
}

/** 层级缩进（父 → 子），仅用于展示；深度由 parentId 链现算。 */
function depthOf(node: OrgNodeDto): number {
  let depth = 0;
  let current = node;
  const seen = new Set<string>();
  while (current.parentId !== null && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = nodes.value.find((n) => n.id === current.parentId);
    if (!parent) break;
    current = parent;
    depth += 1;
  }
  return depth;
}

function createRoot(): void {
  void act(
    () => api.createOrgNode(requireProject(), { name: rootName.value.trim() || "项目统筹", role: "top_manager" }),
    "已建立顶层 manager 岗位",
  );
}

function createChild(): void {
  const name = newNodeName.value.trim();
  if (name === "") {
    error.value = "请填写岗位名称。";
    return;
  }
  const parentId = newNodeParentId.value;
  if (parentId === "") {
    error.value = "请选择上级岗位。";
    return;
  }
  void act(
    () => api.createOrgNode(requireProject(), { parentId, name, role: newNodeRole.value }),
    `已建立岗位「${name}」`,
  );
  newNodeName.value = "";
}

function rename(node: OrgNodeDto): void {
  const name = (nameEdits.value[node.id] ?? node.name).trim();
  if (name === "") return;
  void act(() => api.updateOrgNode(node.id, { name }), "岗位已改名");
}

function changeRole(node: OrgNodeDto): void {
  const role = roleEdits.value[node.id] as NodeRole;
  if (!role || role === node.role) return;
  void act(() => api.updateOrgNode(node.id, { role }), "岗位角色已更新");
}

function changeParent(node: OrgNodeDto): void {
  const parentId = parentEdits.value[node.id] ?? "";
  if (parentId === "" || parentId === (node.parentId ?? "")) return;
  void act(() => api.updateOrgNode(node.id, { parentId }), "汇报线已调整");
}

function assign(node: OrgNodeDto, memberId: string | null): void {
  void act(() => api.assignOrgNode(node.id, memberId), memberId === null ? "已腾出岗位" : "成员已占岗");
}

function remove(node: OrgNodeDto): void {
  void act(() => api.deleteOrgNode(node.id), "岗位已删除（子树提升到父、成员保留）");
}

function autoPlace(): void {
  if (unplacedMemberId.value === "") return;
  void act(
    () => api.autoPlaceMember(requireProject(), unplacedMemberId.value),
    "已自动分配新成员岗位",
  );
}
</script>

<template>
  <section class="card">
    <h1>组织与角色</h1>
    <p class="muted">
      组织树由岗位组成：根节点是唯一的顶层 manager，下级 manager 管理各自子树。
      角色是静态枚举、岗位是角色在节点上的实例；能力点由统一权限矩阵给出。
    </p>

    <p v-if="error" class="error" data-testid="error">{{ error }}</p>
    <p v-if="notice" class="notice ok" data-testid="notice">{{ notice }}</p>

    <div class="row">
      <label class="small">
        项目
        <select v-model="activeProjectId" :disabled="busy" @change="selectProject">
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </label>
      <span v-if="projects.length === 0" class="muted small">暂无项目，请先在「项目与群组」创建。</span>
    </div>

    <div v-if="activeProjectId !== null">
      <!-- 建立组织树（ORG-08：人可独立创建） -->
      <div class="panel">
        <h2>组织树</h2>
        <form v-if="root === null" class="row" @submit.prevent="createRoot">
          <input v-model="rootName" aria-label="顶层岗位名称" placeholder="顶层岗位名称" />
          <button type="submit" :disabled="busy">建立顶层 manager 岗位</button>
        </form>

        <template v-else>
          <form class="row" @submit.prevent="createChild">
            <input v-model="newNodeName" aria-label="新岗位名称" placeholder="新岗位名称" />
            <select v-model="newNodeRole" aria-label="新岗位角色">
              <option v-for="r in childRoles" :key="r.role" :value="r.role">{{ r.role }}</option>
            </select>
            <select v-model="newNodeParentId" aria-label="上级岗位">
              <option v-for="n in nodes" :key="n.id" :value="n.id">{{ n.name }}</option>
            </select>
            <button type="submit" :disabled="busy">新增下级岗位</button>
          </form>

          <ul class="list" data-testid="org-node-list">
            <li v-for="node in nodes" :key="node.id" class="list-item column">
              <div class="row">
                <span :style="{ paddingLeft: `${depthOf(node) * 1.25}rem` }">
                  <strong>{{ node.name }}</strong>
                  <span class="badge">{{ node.role }}</span>
                  <span v-if="node.parentId === null" class="badge manager">顶层</span>
                  <span v-if="node.memberDisplayName" class="badge state">占岗：{{ node.memberDisplayName }}</span>
                  <span v-else class="badge state">空岗</span>
                </span>
              </div>
              <div class="row">
                <input v-model="nameEdits[node.id]" aria-label="岗位名称" />
                <button type="button" :disabled="busy" @click="rename(node)">改名</button>
                <select v-model="roleEdits[node.id]" aria-label="岗位角色">
                  <option v-for="r in roles.filter((x) => x.nodeRole)" :key="r.role" :value="r.role">
                    {{ r.role }}
                  </option>
                </select>
                <button type="button" :disabled="busy || node.parentId === null" @click="changeRole(node)">
                  设角色
                </button>
              </div>
              <div class="row">
                <select v-model="parentEdits[node.id]" aria-label="上级岗位">
                  <option value="">（调整为上级）</option>
                  <option v-for="n in nodes.filter((x) => x.id !== node.id)" :key="n.id" :value="n.id">
                    {{ n.name }}
                  </option>
                </select>
                <button type="button" :disabled="busy" @click="changeParent(node)">调整汇报线</button>
                <select v-model="assignEdits[node.id]" aria-label="指派成员">
                  <option value="">（选择成员）</option>
                  <option v-for="m in members" :key="m.id" :value="m.id">{{ m.displayName }}</option>
                </select>
                <button type="button" :disabled="busy" @click="assign(node, assignEdits[node.id] || null)">
                  指派 / 腾出
                </button>
                <button type="button" :disabled="busy" class="danger" @click="remove(node)">删除岗位</button>
              </div>
            </li>
          </ul>
        </template>
      </div>

      <!-- manager 自动分配新成员岗位（ORG-02/08） -->
      <div class="panel">
        <h2>自动分配新成员</h2>
        <p class="muted small">
          项目已建组织树时，manager 可把未落位成员自动安排到根下新建的 member 岗位；人可再调整。
          项目未建树时不自动造树（兼容阶段 1 升级路径）。
        </p>
        <div class="row">
          <select v-model="unplacedMemberId" aria-label="未落位成员">
            <option value="">（选择未落位成员）</option>
            <option v-for="m in unplacedMembers" :key="m.id" :value="m.id">{{ m.displayName }}</option>
          </select>
          <button type="button" :disabled="busy || unplacedMemberId === ''" @click="autoPlace">
            自动分配岗位
          </button>
        </div>
      </div>

      <!-- 角色配置入口：静态角色与能力点目录（#25/#26/#32） -->
      <div class="panel">
        <h2>角色与能力点</h2>
        <p class="muted small">
          角色为静态枚举，能力点矩阵由服务端统一守卫维护；owner（人）是内建全局主体，不建岗位。
          下级 manager 默认持有 <code>group:view_subtree</code>：对子树内全员属该子树的群组只读可见。
        </p>
        <ul class="list" data-testid="role-catalog">
          <li v-for="r in roles" :key="r.role" class="list-item column">
            <strong>
              {{ r.role }}
              <span v-if="!r.nodeRole" class="badge">内建主体 · 不建岗</span>
            </strong>
            <span class="small muted">{{ r.capabilities.join("、") }}</span>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.row {
  display: flex;
  gap: 0.5rem;
  margin: 0.5rem 0;
  flex-wrap: wrap;
  align-items: center;
}

input,
select {
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--card-bg);
  color: var(--fg);
  min-width: 140px;
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

.panel {
  border-top: 1px solid var(--border);
  padding-top: 0.75rem;
  margin-top: 1rem;
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
</style>
