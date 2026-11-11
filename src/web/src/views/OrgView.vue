<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import {
  ApiError,
  api,
  type OrgNodeDto,
  type OrgSnapshot,
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

import { useCurrentProject, useProjectDraft } from "../composables/useCurrentProject.ts";

type NodeRole = "top_manager" | "sub_manager" | "member";

const context = useCurrentProject();
const { projects, currentProjectId: activeProjectId, readonly: projectReadonly } = context;
let disposed = false;
let request = 0;
const snapshot = ref<OrgSnapshot | null>(null);

const loading = ref(true);
const mutating = ref(false);
const busy = computed(() => loading.value || mutating.value || projectReadonly.value);
const editingNodeId = ref<string | null>(null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

// 表单状态
const rootName = ref("项目统筹");
const newNodeName = ref("");
const newNodeRole = ref<NodeRole>("member");
const newNodeParentId = ref("");
const unplacedMemberId = ref("");
/** 节点 id → 当前编辑值；逐项保存时保留其他尚未提交的字段。 */
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
  const projectId = activeProjectId.value;
  if (projectId === null) {
    snapshot.value = null;
    return;
  }
  const version = ++request;
  const previousNodes = new Map(nodes.value.map((node) => [node.id, node]));
  const result = await api.getOrg(projectId);
  if (disposed || version !== request || activeProjectId.value !== projectId) return;
  snapshot.value = result;
  const names: Record<string, string> = {};
  const roleValues: Record<string, string> = {};
  const parents: Record<string, string> = {};
  const assigns: Record<string, string> = {};
  for (const node of snapshot.value.nodes) {
    const previous = previousNodes.get(node.id);
    names[node.id] = keepDraft(nameEdits.value[node.id], previous?.name, node.name);
    roleValues[node.id] = keepDraft(roleEdits.value[node.id], previous?.role, node.role);
    parents[node.id] = keepDraft(parentEdits.value[node.id], previous ? previous.parentId ?? "" : undefined, node.parentId ?? "");
    assigns[node.id] = keepDraft(assignEdits.value[node.id], previous ? previous.memberId ?? "" : undefined, node.memberId ?? "");
  }
  nameEdits.value = names;
  roleEdits.value = roleValues;
  parentEdits.value = parents;
  assignEdits.value = assigns;
  if (!nodes.value.some((node) => node.id === editingNodeId.value)) editingNodeId.value = null;
  if (!nodes.value.some((n) => n.id === newNodeParentId.value)) {
    newNodeParentId.value = root.value?.id ?? "";
  }
  if (!unplacedMembers.value.some((m) => m.id === unplacedMemberId.value)) {
    unplacedMemberId.value = unplacedMembers.value[0]?.id ?? "";
  }
}

function keepDraft(draft: string | undefined, previous: string | undefined, saved: string): string {
  return draft !== undefined && previous !== undefined && draft !== previous ? draft : saved;
}

async function act<T>(fn: () => Promise<T>, success: string): Promise<boolean> {
  if (busy.value) return false;
  clearMessages();
  mutating.value = true;
  const projectId = activeProjectId.value, generation = context.generation.value;
  try {
    await fn();
    if (disposed || projectId !== activeProjectId.value || generation !== context.generation.value) return false;
    notice.value = success;
    try {
      await refresh();
    } catch (err) {
      error.value = `变更已保存，但刷新失败：${err instanceof Error ? err.message : String(err)}`;
    }
    return true;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : (err as Error).message;
    return false;
  } finally {
    mutating.value = false;
  }
}

useProjectDraft(() => !!newNodeName.value.trim() || rootName.value !== "项目统筹" || nodes.value.some((node) =>
  nameEdits.value[node.id] !== node.name || roleEdits.value[node.id] !== node.role || parentEdits.value[node.id] !== (node.parentId ?? "") || assignEdits.value[node.id] !== (node.memberId ?? "")),
  () => { newNodeName.value = ""; rootName.value = "项目统筹"; nameEdits.value = {}; roleEdits.value = {}; parentEdits.value = {}; assignEdits.value = {}; });
watch(activeProjectId, () => void selectProject(), { immediate: true });
onBeforeUnmount(() => { disposed = true; request++; });

async function selectProject(): Promise<void> {
  request++;
  clearMessages();
  editingNodeId.value = null;
  snapshot.value = null;
  loading.value = true;
  try {
    await refresh();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : (err as Error).message;
  } finally {
    loading.value = false;
  }
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

async function createChild(): Promise<void> {
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
  const created = await act(
    () => api.createOrgNode(requireProject(), { parentId, name, role: newNodeRole.value }),
    `已建立岗位「${name}」`,
  );
  if (created) newNodeName.value = "";
}

function roleLabel(role: string): string {
  return ({ owner: "全局所有者", top_manager: "顶层 manager", sub_manager: "下级 manager", member: "协作成员" } as Record<string, string>)[role] ?? role;
}

function parentName(node: OrgNodeDto): string {
  return nodes.value.find((parent) => parent.id === node.parentId)?.name ?? "顶层岗位";
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
  <section class="page org-page">
    <header class="page-header">
      <div><h1>组织与角色</h1><p class="page-description">明确岗位、汇报关系和成员分工。</p></div>

    </header>

    <p v-if="projectReadonly" class="notice" role="status">项目已归档，组织与岗位仅供查看。</p>
    <p v-if="error" class="error" role="alert" data-testid="error">{{ error }}</p>
    <p v-if="notice" class="notice" role="status" data-testid="notice">{{ notice }}</p>
    <p v-if="loading" class="muted small" role="status">正在加载组织信息…</p>
    <div v-else-if="!activeProjectId && !error" class="panel empty-state"><h2>还没有项目</h2><p>创建项目后，就可以安排岗位与成员。</p><RouterLink to="/projects">前往项目与群组</RouterLink></div>

    <template v-if="activeProjectId !== null && snapshot">
      <section class="panel org-tree-panel" aria-labelledby="org-tree-title" :aria-busy="loading || mutating">
        <div class="section-heading"><div><h2 id="org-tree-title">组织树</h2><p class="muted small">{{ nodes.length }} 个岗位 · {{ unplacedMembers.length }} 位成员待分配</p></div></div>
        <div v-if="root === null" class="root-setup">
          <h3>先建立一个统筹岗位</h3><p class="muted small">顶层 manager 负责整个项目。建立岗位后，可以再指派成员。</p>
          <form class="inline-form" @submit.prevent="createRoot"><label class="field" for="root-name">顶层岗位名称<input id="root-name" v-model="rootName" :disabled="busy" aria-label="顶层岗位名称" placeholder="例如：项目统筹" /></label><button type="submit" class="primary" :disabled="busy">建立顶层 manager 岗位</button></form>
        </div>
        <template v-else>
          <details class="new-node" data-testid="org-create-node">
            <summary>新增下级岗位</summary>
            <form class="new-node-form" @submit.prevent="createChild">
              <label class="field" for="new-node-name">岗位名称<input id="new-node-name" v-model="newNodeName" :disabled="busy" required aria-label="新岗位名称" placeholder="例如：产品设计" /></label>
              <label class="field" for="new-node-role">角色<select id="new-node-role" v-model="newNodeRole" :disabled="busy" aria-label="新岗位角色"><option v-for="r in childRoles" :key="r.role" :value="r.role">{{ roleLabel(r.role) }}</option></select></label>
              <label class="field" for="new-node-parent">上级岗位<select id="new-node-parent" v-model="newNodeParentId" :disabled="busy" aria-label="上级岗位"><option v-for="n in nodes" :key="n.id" :value="n.id">{{ n.name }}</option></select></label>
              <button type="submit" class="primary" :disabled="busy">新增下级岗位</button>
            </form>
          </details>

          <ul class="node-list" data-testid="org-node-list">
            <li v-for="node in nodes" :key="node.id" class="node-item" :style="{ '--node-depth': Math.min(depthOf(node), 4) }">
              <div class="node-summary">
                <span class="node-mark" aria-hidden="true">{{ node.parentId === null ? '统' : '岗' }}</span>
                <div class="node-copy"><div class="node-title"><strong>{{ node.name }}</strong><span class="badge">{{ roleLabel(node.role) }}</span><span v-if="node.parentId === null" class="badge manager">顶层</span></div><p class="muted small"><span>{{ node.memberDisplayName ? `成员：${node.memberDisplayName}` : '空岗 · 待指派成员' }}</span><span v-if="node.parentId !== null"> · 上级：{{ parentName(node) }}</span></p></div>
                <button type="button" class="text-button" :disabled="busy" :aria-expanded="editingNodeId === node.id" :aria-controls="`node-editor-${node.id}`" data-testid="org-edit-node" @click="editingNodeId = editingNodeId === node.id ? null : node.id">{{ editingNodeId === node.id ? '收起编辑' : '编辑岗位' }}</button>
              </div>
              <div v-if="editingNodeId === node.id" :id="`node-editor-${node.id}`" class="node-editor" :aria-label="`编辑岗位：${node.name}`" role="region">
                <p class="muted small editor-hint">每项单独保存，其他未保存的修改会保留在编辑区。</p>
                <div class="editor-grid">
                  <form class="editor-field" @submit.prevent="rename(node)"><label class="field" :for="`node-name-${node.id}`">岗位名称<input :id="`node-name-${node.id}`" v-model="nameEdits[node.id]" :disabled="busy" required aria-label="岗位名称" /></label><button type="submit" class="secondary" :disabled="busy">改名</button></form>
                  <form class="editor-field" @submit.prevent="changeRole(node)"><label class="field" :for="`node-role-${node.id}`">岗位角色<select :id="`node-role-${node.id}`" v-model="roleEdits[node.id]" :disabled="busy || node.parentId === null" aria-label="岗位角色"><option v-for="r in roles.filter((x) => x.nodeRole)" :key="r.role" :value="r.role">{{ roleLabel(r.role) }}</option></select></label><button type="submit" class="secondary" :disabled="busy || node.parentId === null">设角色</button></form>
                  <form class="editor-field" @submit.prevent="changeParent(node)"><label class="field" :for="`node-parent-${node.id}`">上级岗位<select :id="`node-parent-${node.id}`" v-model="parentEdits[node.id]" :disabled="busy" aria-label="上级岗位"><option value="">（选择上级岗位）</option><option v-for="n in nodes.filter((x) => x.id !== node.id)" :key="n.id" :value="n.id">{{ n.name }}</option></select></label><button type="submit" class="secondary" :disabled="busy">调整汇报线</button></form>
                  <form class="editor-field" @submit.prevent="assign(node, assignEdits[node.id] || null)"><label class="field" :for="`node-member-${node.id}`">指派成员<select :id="`node-member-${node.id}`" v-model="assignEdits[node.id]" :disabled="busy" aria-label="指派成员"><option value="">腾出岗位（不指派成员）</option><option v-for="m in members" :key="m.id" :value="m.id">{{ m.displayName }}</option></select></label><button type="submit" class="secondary" :disabled="busy">{{ assignEdits[node.id] ? '指派成员' : '腾出岗位' }}</button></form>
                </div>
                <div class="node-danger"><p class="muted small">删除岗位后，下级岗位会移交给上级，成员身份和历史保留。</p><button type="button" class="text-button danger" :disabled="busy" @click="remove(node)">删除岗位</button></div>
              </div>
            </li>
          </ul>
        </template>
      </section>

      <section class="panel placement-panel" aria-labelledby="placement-title">
        <div><h2 id="placement-title">自动分配新成员</h2><p class="muted small">在顶层 manager 下建立成员岗位，之后可以继续调整。</p></div>
        <div v-if="root === null" class="muted small">请先建立组织树，再自动分配岗位。</div>
        <p v-else-if="unplacedMembers.length === 0" class="muted small">所有成员都已分配岗位。</p>
        <div v-else class="inline-form"><label class="field" for="unplaced-member">待分配成员<select id="unplaced-member" v-model="unplacedMemberId" :disabled="busy" aria-label="未落位成员"><option value="">选择待分配成员</option><option v-for="m in unplacedMembers" :key="m.id" :value="m.id">{{ m.displayName }}</option></select></label><button type="button" class="secondary" :disabled="busy || unplacedMemberId === ''" @click="autoPlace">自动分配岗位</button></div>
      </section>

      <details class="panel role-reference" data-testid="org-role-reference">
        <summary>角色与能力点</summary>
        <p class="muted small">角色决定岗位可以执行的操作。owner（人）为内建全局主体，不需要建立岗位。下级 manager 的 <code>group:view_subtree</code> 可查看参与者均在其子树内的群组，但不代表加入群组或获得发言权限。</p>
        <ul class="role-list" data-testid="role-catalog"><li v-for="r in roles" :key="r.role"><div><strong>{{ roleLabel(r.role) }}</strong><span class="muted small">{{ r.role }}</span><span v-if="!r.nodeRole" class="badge">内建主体 · 不建岗</span></div><p class="muted small">{{ r.capabilities.join('、') || '无额外能力点' }}</p></li></ul>
      </details>
    </template>
  </section>
</template>

<style scoped>
.org-project-field { width: min(100%, 18rem); }
.org-page > .panel { margin-top: 1.25rem; }
.section-heading h2, .placement-panel h2 { font-size: 1.05rem; margin: 0; }
.section-heading p, .placement-panel p { margin: .35rem 0 0; }
.root-setup { padding: 1rem 0 .5rem; }
.root-setup h3 { font-size: 1rem; font-weight: 500; }
.inline-form { display: flex; flex-wrap: wrap; align-items: end; gap: .75rem; margin-top: 1rem; }
.inline-form .field { min-width: min(100%, 14rem); flex: 1; max-width: 24rem; }
.new-node { margin-top: 1rem; padding: .75rem 1rem; border-radius: 10px; background: var(--surface-subtle); }
summary { cursor: pointer; min-height: 2rem; align-content: center; font-size: .9rem; font-weight: 500; }
summary::marker { color: var(--muted); }
.new-node-form { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr) auto; gap: .75rem; align-items: end; margin-top: .85rem; }
.node-list { list-style: none; margin: 1rem 0 0; padding: 0; }
.node-item { min-width: 0; border-top: 1px solid var(--border); }
.node-item:first-child { border-top: 0; }
.node-summary { display: flex; align-items: center; flex-wrap: wrap; gap: .75rem; padding: 1.05rem 0 1.05rem calc(var(--node-depth) * 1rem); }
.node-mark { display: grid; place-items: center; flex: 0 0 2rem; height: 2rem; border: 1px solid var(--border); border-radius: 8px; color: var(--muted); font-size: .85rem; }
.node-copy { flex: 1; min-width: min(100%, 8rem); overflow-wrap: anywhere; }
.node-title { display: flex; align-items: center; flex-wrap: wrap; gap: .4rem; }
.node-title strong { overflow-wrap: anywhere; min-width: 0; }
.node-copy p { margin: .4rem 0 0; }
.manager { color: var(--accent); background: var(--accent-soft); }
.node-editor { border-radius: 10px; padding: 1.15rem; margin: 0 0 1rem; background: var(--surface-subtle); }
.editor-hint { margin: 0 0 1rem; }
.editor-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem 1.5rem; }
.editor-field { display: flex; align-items: end; flex-wrap: wrap; gap: .6rem; min-width: 0; }
.editor-field .field { min-width: min(100%, 10rem); flex: 1; }
.node-danger { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .65rem 1rem; border-top: 1px solid var(--border); margin-top: 1rem; padding-top: 1rem; }
.node-danger p { margin: 0; flex: 1; min-width: min(100%, 12rem); }
.role-reference > p { max-width: 78ch; line-height: 1.7; }
.role-list { padding: 0; margin: 1rem 0 0; list-style: none; }
.role-list li { padding: .85rem 0; border-top: 1px solid var(--border); }
.role-list li > div { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.role-list p { margin: .4rem 0 0; line-height: 1.7; overflow-wrap: anywhere; }
@media (max-width: 1100px) { .new-node-form { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 700px) { .editor-grid, .new-node-form { grid-template-columns: 1fr; } .node-summary { padding-inline-start: calc(var(--node-depth) * .5rem); } .org-project-field, .inline-form .field { width: 100%; max-width: none; } }
</style>
