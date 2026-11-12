<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { api, type GroupDto } from "../api/client.ts";
import { projectPath, useCurrentProject } from "../composables/useCurrentProject.ts";
import AppIcon from "./AppIcon.vue";

const route = useRoute();
const context = useCurrentProject();
const search = ref("");
const expanded = ref(new Set<string>());
const groups = ref<Record<string, GroupDto[]>>({});
const errors = ref<Record<string, string>>({});
const loading = ref<Record<string, boolean>>({});
const versions = new Map<string, number>();
let disposed = false;
const projects = computed(() => context.projects.value.filter(project =>
  (!project.archivedAt || project.id === route.params["projectId"]) && project.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())));
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
watch(() => route.params["projectId"], id => {
  if (typeof id === "string") { expanded.value = new Set([...expanded.value, id]); void loadGroups(id); }
}, { immediate: true });
// 已确认群变更会重新读取共享目录；归档前后群总数可能相同，计数不能充当缓存版本。
watch(() => context.projects.value, () => {
  const ids = new Set(context.projects.value.map(project => project.id));
  for (const id of Object.keys(groups.value)) if (!ids.has(id)) { delete groups.value[id]; versions.set(id, (versions.get(id) ?? 0) + 1); }
  for (const id of expanded.value) if (ids.has(id)) void loadGroups(id);
});
onBeforeUnmount(() => { disposed = true; });
</script>

<template>
  <RouterLink to="/" class="brand" aria-label="Boardroom 协作总览"><span>Boardroom<span class="brand-caption">你的协作工作空间</span></span></RouterLink>
  <label class="sidebar-search"><span class="visually-hidden">筛选项目</span><input v-model="search" type="search" placeholder="筛选项目…" data-testid="sidebar-search" /></label>
  <nav id="main-navigation" class="nav" aria-label="主导航">
    <section class="nav-group"><h2 class="nav-group-title">工作台</h2><RouterLink to="/" class="nav-link" :class="{ selected: route.path === '/' }" :aria-current="route.path === '/' ? 'page' : undefined"><AppIcon name="grid" :size="19" />协作总览</RouterLink><RouterLink to="/projects" class="nav-link" :class="{ selected: route.path === '/projects' }" :aria-current="route.path === '/projects' ? 'page' : undefined"><AppIcon name="folder" :size="19" />所有项目</RouterLink></section>
    <section class="nav-group project-tree-section" aria-labelledby="project-tree-title">
      <div class="sidebar-section-heading"><h2 id="project-tree-title" class="nav-group-title">项目群组</h2><RouterLink to="/projects?create=project" class="sidebar-add" aria-label="新建项目"><AppIcon name="plus" :size="17" /></RouterLink></div>
      <p v-if="context.loading.value && !projects.length" class="sidebar-hint" role="status">正在读取项目…</p>
      <div v-else-if="context.error.value" class="sidebar-hint" role="alert">{{ context.error.value }}<button class="text-button" type="button" @click="context.refreshProjects">重新读取</button></div>
      <p v-else-if="!projects.length" class="sidebar-hint">{{ search ? '没有匹配的项目。' : '还没有项目，从新建开始。' }}</p>
      <ul class="project-tree" data-testid="sidebar-project-tree">
        <li v-for="project in projects" :key="project.id">
          <div class="tree-project-row" :class="{ selected: route.params['projectId'] === project.id }">
            <RouterLink :to="projectPath(project.id)" class="tree-project-link"><AppIcon name="folder" :size="19" /><span>{{ project.name }}</span><span v-if="project.archivedAt" class="visually-hidden">（已归档）</span></RouterLink>
            <button type="button" class="tree-toggle" :aria-expanded="expanded.has(project.id)" :aria-controls="`tree-${project.id}`" :aria-label="`${expanded.has(project.id) ? '收起' : '展开'}${project.name}的群组`" @click="toggle(project.id)"><AppIcon name="chevron" :size="14" /></button>
          </div>
          <div v-if="expanded.has(project.id)" :id="`tree-${project.id}`" class="tree-groups">
            <p v-if="errors[project.id]" class="sidebar-hint" role="alert">{{ errors[project.id] }}<button type="button" class="text-button" @click="loadGroups(project.id)">重试</button></p>
            <p v-else-if="loading[project.id] && !groups[project.id]" class="sidebar-hint" role="status">读取群组…</p>
            <RouterLink v-for="group in groups[project.id] ?? []" :key="group.id" :to="projectPath(project.id, 'chat', group.id)" class="nav-link tree-group-link" :class="{ selected: route.params['groupId'] === group.id && route.params['projectId'] === project.id }"><AppIcon name="message" :size="17" /><span>{{ group.name }}</span></RouterLink>
            <RouterLink :to="{ path: projectPath(project.id, 'chat'), query: { manage: 'groups' } }" class="tree-manage">{{ groups[project.id]?.length === 0 ? '创建第一个群组' : '管理群组' }}</RouterLink>
          </div>
        </li>
      </ul>
    </section>
    <section class="sidebar-bottom" aria-label="全局配置"><RouterLink to="/collaboration/connections" class="nav-link" :class="{ selected: route.path.startsWith('/collaboration/') }"><AppIcon name="layers" :size="19" /><span>角色与能力<small>连接与实例</small></span></RouterLink><RouterLink to="/settings" class="nav-link" :class="{ selected: route.path === '/settings' }"><AppIcon name="settings" :size="19" />设置</RouterLink></section>
  </nav>
</template>

<style scoped>
.brand { padding: 4px 12px 28px; font-size: 1.65rem; letter-spacing: -.055em; }.brand-caption { font-size: .75rem; letter-spacing: 0; }
.sidebar-search { display: block; margin: 0 8px 26px; }.sidebar-search input { width: 100%; min-width: 0; font-size: .85rem; }
.nav { flex: 1; gap: 24px; }.nav-group-title { font-size: .75rem; font-weight: 500; letter-spacing: .02em; }.nav-link { min-height: 42px; gap: 10px; }
.sidebar-section-heading { display: flex; align-items: center; justify-content: space-between; }.sidebar-section-heading h2 { margin-bottom: 0; }.sidebar-add { width: 32px; min-height: 32px; display: grid; place-items: center; color: var(--muted); }
.project-tree { list-style: none; margin: 8px 0 0; padding: 0; }.project-tree > li + li { margin-top: 8px; }.tree-project-row { display: flex; align-items: center; border-radius: 8px; }.tree-project-row.selected { background: var(--surface-subtle); }.tree-project-link { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; color: var(--fg); padding: 11px 6px 11px 12px; font-size: .9rem; font-weight: 550; }.tree-project-link span { overflow-wrap: anywhere; }.tree-toggle { padding: 6px; border: 0; width: 32px; min-height: 36px; flex: none; background: transparent; }.tree-toggle[aria-expanded=true] .app-icon { transform: rotate(90deg); }
.tree-groups { margin: 3px 0 8px 20px; padding-left: 8px; border-left: 1px solid var(--border); }.tree-group-link { font-size: .85rem; font-weight: 400; margin: 1px 0; padding: 9px; }.tree-group-link span { min-width: 0; overflow-wrap: anywhere; }.tree-manage { display: inline-block; padding: 6px 10px; font-size: .75rem; color: var(--muted); }.sidebar-hint { font-size: .78rem; color: var(--muted); padding: 4px 12px; overflow-wrap: anywhere; }.sidebar-hint .text-button { font-size: .75rem; }
.sidebar-bottom { margin-top: auto; border-top: 1px solid var(--border); padding-top: 16px; }.sidebar-bottom small { display: block; font-size: .72rem; font-weight: 400; color: var(--muted); margin-top: 2px; }
@media (max-width: 760px) { .brand { display: none; }.sidebar-search { margin: 0 8px 16px; }.nav { gap: 18px; }.tree-toggle, .sidebar-add { min-width: 44px; min-height: 44px; }.tree-manage { min-height: 44px; align-content: center; } }
</style>
