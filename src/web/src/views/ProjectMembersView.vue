<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import ProjectsView from "./ProjectsView.vue";
import OrgView from "./OrgView.vue";
import StatusBoardView from "./StatusBoardView.vue";
const route = useRoute();
const tab = computed(() => route.query["tab"] === "organization" || route.query["tab"] === "status" ? route.query["tab"] : "members");
const tabs = [{ key: "members", label: "项目成员" }, { key: "organization", label: "组织与岗位" }, { key: "status", label: "成员状态" }];
</script>
<template>
  <nav class="subview-tabs" aria-label="成员视图"><RouterLink v-for="item in tabs" :key="item.key" :to="{ path: route.path, query: { ...route.query, tab: item.key }, hash: route.hash }" :class="{ selected: tab === item.key }" :aria-current="tab === item.key ? 'page' : undefined">{{ item.label }}</RouterLink></nav>
  <OrgView v-if="tab === 'organization'" /><StatusBoardView v-else-if="tab === 'status'" /><ProjectsView v-else mode="members" />
</template>
<style>
.subview-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 24px; }.subview-tabs a { display: inline-flex; align-items: center; min-height: 38px; padding: 6px 14px; border-radius: 7px; color: var(--muted); font-size: .85rem; }.subview-tabs a.selected { background: var(--card-bg); color: var(--fg); border: 1px solid var(--border); font-weight: 600; box-shadow: inset 0 -2px var(--accent); }
@media (max-width:760px) { .subview-tabs a { min-height:44px; } }
</style>
