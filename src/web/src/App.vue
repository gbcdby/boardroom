<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import AppIcon from "./components/AppIcon.vue";
const route = useRoute();
const menuOpen = ref(false);
const menuButton = ref<HTMLButtonElement | null>(null);
const navigation = [
  { label: "工作空间", items: [
    { to: "/", label: "概览", icon: "grid" },
    { to: "/projects", label: "项目与群组", icon: "folder" },
    { to: "/chat", label: "群聊", icon: "message" },
  ] },
  { label: "管理", items: [
    { to: "/runtimes", label: "托管 Agent", icon: "layers" },
    { to: "/status", label: "状态看板", icon: "activity" },
    { to: "/org", label: "组织与角色", icon: "people" },
    { to: "/audit", label: "审计与撤销", icon: "history" },
  ] },
];
const currentPage = computed(() => navigation.flatMap((group) => group.items).find((item) => item.to === route.path)?.label ?? (route.path === "/settings" ? "设置" : "页面不存在"));
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
    <header class="workspace-topbar"><button ref="menuButton" type="button" class="menu-toggle" :aria-expanded="menuOpen" aria-controls="main-navigation" :aria-label="menuOpen ? '收起导航' : '展开导航'" @click="menuOpen = !menuOpen"><AppIcon :name="menuOpen ? 'close' : 'menu'" :size="21" /></button><span class="workspace-label">工作空间</span><span class="breadcrumb-divider" aria-hidden="true">/</span><span class="current-page">{{ currentPage }}</span><span class="local-label"><AppIcon name="server" :size="15" />本地运行</span></header>
    <aside class="sidebar" :class="{ 'is-open': menuOpen }" aria-label="工作空间导航">
      <RouterLink to="/" class="brand" aria-label="Agent Studio 概览"><span class="brand-mark"><AppIcon name="layers" :size="21" /></span><span>Agent Studio<span class="brand-caption">你的协作工作空间</span></span></RouterLink>
      <nav id="main-navigation" class="nav" aria-label="主导航"><div v-for="group in navigation" :key="group.label" class="nav-group"><p class="nav-group-title">{{ group.label }}</p><RouterLink v-for="item in group.items" :key="item.to" :to="item.to" class="nav-link" :class="{ selected: route.path === item.to }"><AppIcon :name="item.icon" :size="19" /><span>{{ item.label }}</span></RouterLink></div></nav>
      <div class="sidebar-footer"><AppIcon name="server" :size="18" /><span>本地工作空间<small>仅在这台设备上访问</small></span></div>
    </aside>
    <div class="workspace">
      <main id="main-content" class="content" tabindex="-1"><RouterView /></main>
      <footer class="footer">Agent Studio<span aria-hidden="true"> · </span>让协作井然有序</footer>
    </div>
  </div>
</template>
