<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { api, type GroupDto, type ProjectDto } from "../api/client.ts";
import { projectPath, useCurrentProject } from "../composables/useCurrentProject.ts";
import { useTheme } from "../composables/useTheme.ts";
import AppIcon from "./AppIcon.vue";

const route = useRoute();
const context = useCurrentProject();
const theme = useTheme();
const search = ref("");
const expanded = ref(new Set<string>());
const groups = ref<Record<string, GroupDto[]>>({});
const errors = ref<Record<string, string>>({});
const loading = ref<Record<string, boolean>>({});
const versions = new Map<string, number>();
const prototypeGroupNames = ["界面升级小组", "MCP 能力接入", "质量保障"];
let disposed = false;
let demoExpanded = false;

const isPrototypeDemo = computed(() => ["home", "demo-p04", "demo-p05", "prototype-index"].includes(String(route.name ?? "")));
const roleSelected = computed(() => route.path.startsWith("/collaboration/") || route.path === "/demo/p05");
function displayProjectName(project: ProjectDto): string {
  return isPrototypeDemo.value ? "Boardroom" : project.name;
}
const searchTerm = computed(() => search.value.trim().toLocaleLowerCase());
const projects = computed(() => context.projects.value.filter(project => {
  if (project.archivedAt && project.id !== route.params["projectId"]) return false;
  if (!searchTerm.value) return true;
  const candidates = [project.name, displayProjectName(project), ...(groups.value[project.id] ?? []).map(group => group.name)];
  if (isPrototypeDemo.value) candidates.push(...prototypeGroupNames);
  return candidates.some(name => name.toLocaleLowerCase().includes(searchTerm.value));
}));

async function loadGroups(id: string): Promise<void> {
  const version = (versions.get(id) ?? 0) + 1;
  versions.set(id, version); loading.value[id] = true; delete errors.value[id];
  try {
    const result = await api.listGroups(id, { includeArchived: false });
    if (!disposed && versions.get(id) === version) groups.value[id] = result.groups;
  } catch (error) {
    if (!disposed && versions.get(id) === version) errors.value[id] = error instanceof Error ? error.message : "群组读取失败";
  } finally { if (!disposed && versions.get(id) === version) loading.value[id] = false; }
}
function toggle(id: string): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id); else { next.add(id); void loadGroups(id); }
  expanded.value = next;
}
function expandFirstProject(): void {
  const first = context.projects.value.find(project => !project.archivedAt);
  if (!first || expanded.value.has(first.id)) return;
  expanded.value = new Set([first.id]);
  void loadGroups(first.id);
}
function visualGroups(projectId: string): Array<{ key: string; name: string; to: string; selected: boolean }> {
  const stored = groups.value[projectId] ?? [];
  let items: Array<{ key: string; name: string; to: string; selected: boolean }>;
  if (!isPrototypeDemo.value) items = stored.map(group => ({
    key: group.id, name: group.name, to: projectPath(projectId, "chat", group.id),
    selected: route.params["projectId"] === projectId && route.params["groupId"] === group.id,
  }));
  else items = prototypeGroupNames.map((name, index) => {
    const group = stored[index];
    const to = group ? projectPath(projectId, "chat", group.id) : `${projectPath(projectId, "chat")}?manage=groups`;
    return {
      key: group?.id ?? `demo-${index}`, name, to,
      selected: (route.name === "demo-p04" && index === 0)
        || (route.params["projectId"] === projectId && route.params["groupId"] === group?.id),
    };
  });
  if (searchTerm.value) items = items.filter(group => group.name.toLocaleLowerCase().includes(searchTerm.value));
  return items;
}
function toggleTheme(): void {
  theme.setPreference(theme.snapshot.value.appearance === "dark" ? "light" : "dark");
}
watch(() => route.params["projectId"], id => {
  if (typeof id === "string") { expanded.value = new Set([...expanded.value, id]); void loadGroups(id); }
}, { immediate: true });
// 已确认群变更会重新读取共享目录；归档前后群总数可能相同，计数不能充当缓存版本。
watch(() => context.projects.value, () => {
  const ids = new Set(context.projects.value.map(project => project.id));
  for (const id of Object.keys(groups.value)) if (!ids.has(id)) { delete groups.value[id]; versions.set(id, (versions.get(id) ?? 0) + 1); }
  if (isPrototypeDemo.value && !demoExpanded && ids.size) { demoExpanded = true; expandFirstProject(); }
  for (const id of expanded.value) if (ids.has(id)) void loadGroups(id);
}, { immediate: true });
watch(isPrototypeDemo, value => {
  if (!value) { demoExpanded = false; return; }
  if (!demoExpanded && context.projects.value.length) { demoExpanded = true; expandFirstProject(); }
}, { immediate: true });
onBeforeUnmount(() => { disposed = true; });
</script>

<template>
  <RouterLink to="/" class="brand" aria-label="Boardroom 协作总览">Boardroom</RouterLink>
  <label class="sidebar-search">
    <AppIcon name="search" :size="20" />
    <span class="visually-hidden">筛选项目</span>
    <input v-model="search" class="sidebar-search-input" type="search" :placeholder="isPrototypeDemo ? '搜索项目、群组或任务' : '筛选项目…'" data-testid="sidebar-search" />
  </label>
  <nav id="main-navigation" class="nav" aria-label="主导航">
    <section class="nav-group workbench-group" aria-labelledby="workbench-title">
      <h2 id="workbench-title" class="nav-group-title">工作台</h2>
      <RouterLink to="/" class="nav-link" :class="{ selected: route.path === '/' }" :aria-current="route.path === '/' ? 'page' : undefined"><AppIcon name="grid" :size="21" /><span>协作总览</span></RouterLink>
      <RouterLink to="/tasks" class="nav-link" :class="{ selected: route.path.startsWith('/tasks') }"><AppIcon name="inbox" :size="21" /><span>待我处理</span><span class="nav-count" aria-label="1 项示例待办">1</span><AppIcon name="chevron" :size="16" class="nav-chevron" /></RouterLink>
      <RouterLink to="/chat" class="nav-link" :class="{ selected: route.path.startsWith('/chat') }"><AppIcon name="message" :size="21" /><span>总管</span><span class="nav-status" aria-hidden="true"></span></RouterLink>
    </section>
    <section class="nav-group project-tree-section" aria-labelledby="project-tree-title">
      <div class="sidebar-section-heading"><RouterLink id="project-tree-title" to="/projects" class="nav-group-title nav-tree-title" aria-label="查看所有项目">项目群组</RouterLink><RouterLink v-if="!isPrototypeDemo" to="/projects?create=project" class="sidebar-add" aria-label="新建项目"><AppIcon name="plus" :size="16" /></RouterLink></div>
      <p v-if="context.loading.value && !projects.length" class="sidebar-hint" role="status">正在读取项目…</p>
      <div v-else-if="context.error.value" class="sidebar-hint" role="alert">{{ context.error.value }}<button class="text-button" type="button" @click="context.refreshProjects">重新读取</button></div>
      <p v-else-if="!projects.length" class="sidebar-hint">{{ search ? '没有匹配的项目。' : '还没有项目，从新建开始。' }}</p>
      <ul class="project-tree" data-testid="sidebar-project-tree">
        <li v-for="project in projects" :key="project.id">
          <div class="tree-project-row" :class="{ selected: route.params['projectId'] === project.id }">
            <RouterLink :to="projectPath(project.id)" class="tree-project-link"><AppIcon name="folder" :size="21" /><span>{{ displayProjectName(project) }}</span><span v-if="project.archivedAt" class="visually-hidden">（已归档）</span></RouterLink>
            <button type="button" class="tree-toggle" :aria-expanded="expanded.has(project.id)" :aria-controls="`tree-${project.id}`" :aria-label="`${expanded.has(project.id) ? '收起' : '展开'}${displayProjectName(project)}的群组`" @click="toggle(project.id)"><AppIcon name="chevron" :size="16" /></button>
          </div>
          <div v-if="expanded.has(project.id)" :id="`tree-${project.id}`" class="tree-groups">
            <p v-if="errors[project.id]" class="sidebar-hint" role="alert">{{ errors[project.id] }}<button type="button" class="text-button" @click="loadGroups(project.id)">重试</button></p>
            <p v-else-if="loading[project.id] && !groups[project.id] && !isPrototypeDemo" class="sidebar-hint" role="status">读取群组…</p>
            <p v-else-if="searchTerm && visualGroups(project.id).length === 0" class="sidebar-hint">没有匹配的群组。</p>
            <RouterLink v-for="group in visualGroups(project.id)" :key="group.key" :to="group.to" class="nav-link tree-group-link" :class="{ selected: group.selected }"><AppIcon name="message" :size="19" /><span>{{ group.name }}</span></RouterLink>
          </div>
        </li>
      </ul>
    </section>
    <section class="sidebar-bottom" aria-label="全局配置">
      <details class="nav-disclosure" :class="{ selected: roleSelected }">
        <summary class="nav-link role-link"><AppIcon name="gear" :size="21" /><span>角色与能力</span><AppIcon name="chevron" :size="16" class="nav-chevron" /></summary>
        <div class="disclosure-links">
          <RouterLink to="/collaboration/connections" :class="{ selected: route.path === '/collaboration/connections' }">连接与实例</RouterLink>
          <RouterLink to="/collaboration/mcp" :class="{ selected: route.path === '/collaboration/mcp' }">MCP 目录</RouterLink>
          <RouterLink to="/demo/p05" :class="{ selected: route.path === '/demo/p05' }">能力演示</RouterLink>
        </div>
      </details>
      <div class="bottom-row">
        <RouterLink to="/settings" class="nav-link settings-link" :class="{ selected: route.path === '/settings' }" :aria-current="route.path === '/settings' ? 'page' : undefined"><AppIcon name="gear" :size="21" /><span>设置</span></RouterLink>
        <button type="button" class="theme-toggle" :aria-label="theme.snapshot.value.appearance === 'dark' ? '切换到浅色主题' : '切换到深色主题'" :aria-pressed="theme.snapshot.value.appearance === 'dark'" @click="toggleTheme"><AppIcon :name="theme.snapshot.value.appearance === 'dark' ? 'sun' : 'moon'" :size="20" /></button>
      </div>
    </section>
  </nav>
</template>

<style scoped>
.brand { display: block; padding: 0 20px 26px; font-size: 2.5rem; font-weight: 700; line-height: 1.15; letter-spacing: -.055em; }
.sidebar-search { position: relative; display: block; margin: 0 4px 22px; }
.sidebar-search :deep(.app-icon) { position: absolute; left: 14px; top: 13px; color: var(--muted); pointer-events: none; }
.sidebar-search .sidebar-search-input:not([type="checkbox"]):not([type="radio"]) { width: 100%; min-width: 0; min-height: 46px; height: 46px; padding: .5rem .7rem .5rem 42px; border-radius: 14px; border: 1px solid color-mix(in srgb, var(--border) 55%, transparent); background: var(--card-bg); box-shadow: var(--shadow); font-size: 1rem; }
.nav { flex: 1; gap: 18px; }
.nav-group-title { color: var(--muted); font-size: .95rem; font-weight: 500; letter-spacing: .01em; margin: 0 18px 10px; }
.workbench-group { padding-bottom: 12px; margin: 0 6px 2px; border-bottom: 1px solid var(--border); }
.nav-link { display: flex; align-items: center; gap: 12px; min-height: 46px; margin: 2px 6px; padding: 9px 12px; border: 1px solid transparent; border-radius: 11px; color: var(--fg); font-size: 1.05rem; font-weight: 600; }
.nav-link:hover { color: var(--fg); background: color-mix(in srgb, var(--fg) 5%, var(--sidebar-bg)); text-decoration: none; }
.nav-link.selected { color: var(--fg); background: color-mix(in srgb, var(--fg) 7%, var(--sidebar-bg)); box-shadow: none; }
.nav-link.selected :deep(.app-icon) { color: var(--accent); }
.nav-link > span:nth-of-type(1) { min-width: 0; overflow-wrap: anywhere; }
.nav-count { flex: none; min-width: 22px; height: 22px; display: grid; place-items: center; border-radius: 6px; background: #d99b0b; color: #fff; font-size: .8rem; font-weight: 700; line-height: 1; }
.nav-status { flex: none; width: 9px; height: 9px; margin-left: auto; border-radius: 50%; background: var(--accent-fill); }
.nav-chevron { margin-left: auto; color: var(--muted); }
.sidebar-section-heading { display: flex; align-items: center; justify-content: space-between; margin-inline: 6px; }
.sidebar-section-heading .nav-group-title { margin-bottom: 10px; }
.nav-tree-title:hover { color: var(--fg); text-decoration: none; }
.sidebar-add { width: 28px; min-height: 28px; display: grid; place-items: center; color: var(--muted); opacity: .7; }
.sidebar-add:hover { opacity: 1; }
.project-tree { list-style: none; margin: 0 6px; padding: 0; }
.project-tree > li + li { margin-top: 6px; }
.tree-project-row { display: flex; align-items: center; border-radius: 10px; }
.tree-project-row.selected { background: color-mix(in srgb, var(--fg) 7%, var(--sidebar-bg)); }
.tree-project-link { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; color: var(--fg); padding: 10px 6px 10px 18px; font-size: 1.05rem; font-weight: 650; }
.tree-project-link span { overflow-wrap: anywhere; }
.tree-toggle { padding: 6px; border: 0; width: 34px; min-height: 38px; flex: none; background: transparent; }
.tree-toggle[aria-expanded=true] :deep(.app-icon) { transform: rotate(90deg); }
.tree-groups { margin: 2px 0 10px 28px; padding: 0; }
.tree-group-link { min-height: 44px; margin: 3px 0; padding: 8px 12px; font-size: 1.05rem; font-weight: 600; }
.tree-group-link.selected { color: var(--fg); background: var(--accent-soft); border-color: var(--accent); box-shadow: none; }
.tree-group-link.selected :deep(.app-icon) { color: var(--accent); }
.sidebar-hint { font-size: .78rem; color: var(--muted); padding: 4px 18px; overflow-wrap: anywhere; }
.sidebar-hint .text-button { font-size: .75rem; }
.sidebar-bottom { margin-top: auto; padding: 0 0 0; border-top: 0; gap: 2px; }
.nav-disclosure > summary { display: flex; list-style: none; }
.nav-disclosure > summary::-webkit-details-marker { display: none; }
.nav-disclosure > summary::marker { content: ""; }
.nav-disclosure.selected > summary { background: var(--accent-soft); border-color: var(--accent); }
.nav-disclosure.selected > summary :deep(.app-icon) { color: var(--accent); }
.nav-disclosure[open] .nav-chevron { transform: rotate(90deg); }
.disclosure-links { display: flex; flex-direction: column; gap: 1px; padding: 2px 0 6px 50px; }
.disclosure-links a { min-height: 32px; display: flex; align-items: center; padding: 3px 10px; border-radius: 7px; color: var(--muted); font-size: .78rem; }
.disclosure-links a:hover, .disclosure-links a.selected { color: var(--accent); background: var(--surface-subtle); text-decoration: none; }
.bottom-row { display: flex; align-items: center; gap: 2px; }
.settings-link { flex: 1; min-width: 0; }
.theme-toggle { flex: none; width: 32px; min-height: 38px; padding: 0; border: 0; border-radius: 10px; background: transparent; color: var(--muted); }
.theme-toggle:hover { background: var(--surface-subtle); color: var(--fg); }
@media (max-width: 760px) {
  .brand { font-size: 1.8rem; padding-bottom: 16px; }
  .sidebar-search { margin-bottom: 14px; }
  .nav { gap: 14px; }
  .tree-toggle, .sidebar-add, .theme-toggle { min-width: 44px; min-height: 44px; }
  .sidebar-add { opacity: 1; }
}
</style>
