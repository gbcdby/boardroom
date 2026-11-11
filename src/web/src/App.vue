<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import AppIcon from "./components/AppIcon.vue";
import { projectPath, useCurrentProject } from "./composables/useCurrentProject.ts";
const route = useRoute();
const router = useRouter();
const context = useCurrentProject();
const { projects, currentProjectId, currentProject, loading: projectsLoading, error: projectError, notice: projectNotice } = context;
const menuOpen = ref(false);
const menuButton = ref<HTMLButtonElement | null>(null);
const projectContextVisible = computed(() => route.name !== "settings");
const viewKey = computed(() => `${String(route.name)}:${projectContextVisible.value ? currentProjectId.value ?? '' : ''}:${String(route.params['taskId'] ?? '')}`);
const projectTo = (section: string) => currentProjectId.value ? projectPath(currentProjectId.value, section) : `/${section}`;
const navigation = computed(() => [
  { label: "工作空间", items: [
    { to: "/", label: "概览", icon: "grid" },
    { to: "/projects", label: "项目与群组", icon: "folder" },
    { to: projectTo("tasks"), label: "任务", icon: "grid" },
    { to: projectTo("chat"), label: "群聊", icon: "message" },
    { to: projectTo("memory"), label: "记忆", icon: "layers" },
  ] },
  { label: "管理", items: [
    { to: "/runtimes", label: "托管 Agent", icon: "layers" },
    { to: projectTo("status"), label: "状态看板", icon: "activity" },
    { to: projectTo("members"), label: "成员", icon: "people" },
    { to: projectTo("org"), label: "组织与角色", icon: "people" },
    { to: projectTo("audit"), label: "审计与撤销", icon: "history" },
    { to: "/settings", label: "设置", icon: "settings" },
  ] },
]);
const currentPage = computed(() => typeof route.meta["title"] === "string" ? route.meta["title"] : navigation.value.flatMap((group) => group.items).find((item) => item.to === route.path)?.label ?? (route.path === "/settings" ? "设置" : "页面不存在"));
async function selectProject(event: Event): Promise<void> {
  const control = event.target as HTMLSelectElement;
  await context.selectProject(control.value);
  control.value = currentProjectId.value ?? "";
}
async function retryProjects(): Promise<void> {
  await context.refreshProjects();
  if (!projectError.value) await router.replace({ path: route.path, query: route.query, hash: route.hash, force: true });
}
function closeMenu(): void {
  if (!menuOpen.value) return;
  menuOpen.value = false;
  void nextTick(() => menuButton.value?.focus());
}
watch(currentPage, (title) => { document.title = `${title} · Agent Studio`; }, { immediate: true });
watch(() => route.path, async () => {
  menuOpen.value = false;
  await nextTick();
  const heading = document.querySelector<HTMLElement>("main h1");
  if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  window.scrollTo({ top: 0, behavior: "instant" });
});
</script>

<template>
  <a class="skip-link" href="#main-content">跳到主要内容</a>
  <div class="layout" @keydown.esc="closeMenu">
    <header class="workspace-topbar" :class="{ 'global-page': !projectContextVisible }"><button ref="menuButton" type="button" class="menu-toggle" :aria-expanded="menuOpen" aria-controls="main-navigation" :aria-label="menuOpen ? '收起导航' : '展开导航'" @click="menuOpen = !menuOpen"><AppIcon :name="menuOpen ? 'close' : 'menu'" :size="21" /></button><span class="current-page">{{ currentPage }}</span><label v-if="projectContextVisible" class="workspace-project"><span>当前项目</span><select :value="currentProjectId ?? ''" :disabled="projectsLoading || projects.length === 0" data-testid="current-project" @change="selectProject"><option v-if="currentProjectId === null" value="" disabled>{{ projectsLoading ? '正在加载…' : '选择项目' }}</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}{{ project.archivedAt ? ' · 已归档' : '' }}</option></select></label><span class="local-label"><AppIcon name="server" :size="15" />本地运行</span></header>
    <aside class="sidebar" :class="{ 'is-open': menuOpen }" aria-label="工作空间导航">
      <RouterLink to="/" class="brand" aria-label="Agent Studio 概览"><span class="brand-mark"><AppIcon name="layers" :size="21" /></span><span>Agent Studio<span class="brand-caption">你的协作工作空间</span></span></RouterLink>
      <nav id="main-navigation" class="nav" aria-label="主导航"><div v-for="group in navigation" :key="group.label" class="nav-group"><p class="nav-group-title">{{ group.label }}</p><RouterLink v-for="item in group.items" :key="item.to" :to="item.to" class="nav-link" :class="{ selected: route.path === item.to || (item.to !== '/' && item.to !== '/projects' && route.path.startsWith(`${item.to}/`)) }"><AppIcon :name="item.icon" :size="19" /><span>{{ item.label }}</span></RouterLink></div></nav>
      <div class="sidebar-footer"><AppIcon name="server" :size="18" /><span>本地工作空间<small>仅在这台设备上访问</small></span></div>
    </aside>
    <div class="workspace">
      <main id="main-content" class="content" tabindex="-1"><div v-if="projectContextVisible && projectError" class="error" role="alert">{{ projectError }} <button type="button" class="text-button" :disabled="projectsLoading" @click="retryProjects">重新加载项目</button></div><div v-if="projectContextVisible && projectNotice" class="notice" role="status" data-testid="context-notice">{{ projectNotice }} <button type="button" class="text-button" @click="context.dismissNotice">知道了</button></div><p v-if="projectContextVisible && !projectsLoading && !projectError && !currentProject" class="muted small">暂无当前项目。可在顶栏选择项目，或<RouterLink to="/projects?archived=1">查看归档项目</RouterLink>。</p><RouterView v-slot="{ Component }"><component :is="Component" :key="viewKey" /></RouterView></main>
      <footer class="footer">Agent Studio<span aria-hidden="true"> · </span>让协作井然有序</footer>
    </div>
  </div>
</template>
