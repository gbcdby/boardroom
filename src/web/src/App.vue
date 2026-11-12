<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import AppIcon from "./components/AppIcon.vue";
import ToastHost from "./components/ToastHost.vue";
import SidebarNavigation from "./components/SidebarNavigation.vue";
import { projectPath, useCurrentProject } from "./composables/useCurrentProject.ts";
const route = useRoute();
const router = useRouter();
const context = useCurrentProject();
const { projects, currentProjectId, currentProject, loading: projectsLoading, error: projectError, notice: projectNotice } = context;
const menuOpen = ref(false);
const menuButton = ref<HTMLButtonElement | null>(null);
const projectContextVisible = computed(() => typeof route.params["projectId"] === "string" && typeof route.meta["projectSection"] === "string");
const sections = [
  { key: "overview", label: "概览", icon: "grid" }, { key: "tasks", label: "任务与评审", icon: "grid" },
  { key: "chat", label: "讨论", icon: "message" }, { key: "members", label: "成员", icon: "people" },
  { key: "knowledge", label: "知识", icon: "layers" }, { key: "settings", label: "设置", icon: "settings" },
];
const currentPage = computed(() => typeof route.meta["title"] === "string" ? route.meta["title"] : "协作总览");
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
});
</script>

<template>
  <a class="skip-link" href="#main-content">跳到主要内容</a>
  <div class="layout collab-layout" @keydown.esc="closeMenu">
    <header class="workspace-topbar" :class="{ 'global-page': !projectContextVisible }"><button ref="menuButton" type="button" class="menu-toggle" :aria-expanded="menuOpen" aria-controls="main-navigation" :aria-label="menuOpen ? '收起导航' : '展开导航'" @click="menuOpen = !menuOpen"><AppIcon :name="menuOpen ? 'close' : 'menu'" :size="21" /></button><span class="current-page">{{ currentPage }}</span><label v-if="projectContextVisible" class="workspace-project"><span>当前项目</span><select :value="currentProjectId ?? ''" :disabled="projectsLoading || projects.length === 0" data-testid="current-project" @change="selectProject"><option v-if="currentProjectId === null" value="" disabled>{{ projectsLoading ? '正在加载…' : '选择项目' }}</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}{{ project.archivedAt ? ' · 已归档' : '' }}</option></select></label><span class="local-label"><AppIcon name="server" :size="15" />本地运行</span></header>
    <aside class="sidebar" :class="{ 'is-open': menuOpen }" aria-label="工作空间导航"><SidebarNavigation /></aside>
    <div class="workspace">
      <main id="main-content" class="content" tabindex="-1"><div v-if="projectContextVisible && projectError" class="error" role="alert">{{ projectError }} <button type="button" class="text-button" :disabled="projectsLoading" @click="retryProjects">重新加载项目</button></div><div v-if="projectContextVisible && projectNotice" class="notice" role="status" data-testid="context-notice">{{ projectNotice }} <button type="button" class="text-button" @click="context.dismissNotice">知道了</button></div><p v-if="projectContextVisible && !projectsLoading && !projectError && !currentProject" class="muted small">暂无当前项目。可在顶栏选择项目，或<RouterLink to="/projects?archived=1">查看归档项目</RouterLink>。</p><nav v-if="projectContextVisible && currentProjectId" class="project-section-nav" aria-label="项目功能"><RouterLink v-for="section in sections" :key="section.key" :to="projectPath(currentProjectId, section.key)" :class="{ selected: route.meta['projectSection'] === section.key }" :aria-current="route.meta['projectSection'] === section.key ? 'page' : undefined">{{ section.label }}</RouterLink><RouterLink class="activity-link" :to="projectPath(currentProjectId, 'activity')" :class="{ selected: route.meta['projectSection'] === 'activity' }">活动与审计</RouterLink></nav><RouterView /></main>
      <footer class="footer">Agent Studio<span aria-hidden="true"> · </span>让协作井然有序</footer>
    </div>
  </div>
  <ToastHost />
</template>

<style>
.collab-layout { grid-template-columns: 248px minmax(0, 1fr); }
.collab-layout .sidebar { padding: 24px 14px 18px; }.collab-layout .content { max-width: 1440px; padding-top: 28px; }.collab-layout .workspace-topbar { min-height: 64px; }
.project-section-nav { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: -4px 0 28px; padding-bottom: 14px; border-bottom: 1px solid var(--border); }.project-section-nav a { display: inline-flex; align-items: center; min-height: 38px; padding: 7px 13px; border-radius: 8px; color: var(--muted); font-size: .86rem; }.project-section-nav a.selected { color: var(--accent); background: var(--accent-soft); font-weight: 600; box-shadow: inset 0 -2px var(--accent); }.project-section-nav .activity-link { margin-left: auto; font-size: .8rem; }
@media (max-width: 1050px) { .collab-layout { grid-template-columns: 224px minmax(0, 1fr); }.collab-layout .content { padding-inline: 24px; } }
@media (max-width: 760px) { .collab-layout { display: flex; }.collab-layout .sidebar { display: none; padding: 20px 12px; }.collab-layout .sidebar.is-open { display: flex; border-bottom: 1px solid var(--border); }.collab-layout .sidebar.is-open .nav { display: flex; padding: 0; border: 0; }.collab-layout .content { padding: 20px 16px 32px; }.project-section-nav { gap: 3px; margin-bottom: 22px; }.project-section-nav a { min-height: 44px; padding-inline: 10px; }.project-section-nav .activity-link { margin-left: 0; }.collab-layout .sidebar-search { display: block; } }
</style>
