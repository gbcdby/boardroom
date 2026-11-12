<script setup lang="ts">
import { useRoute, RouterLink } from "vue-router";
import ChatView from "./ChatView.vue";
import ProjectsView from "./ProjectsView.vue";
const route = useRoute();
</script>
<template>
  <nav class="subview-tabs" aria-label="讨论视图"><RouterLink :to="{ path: route.path, query: { ...route.query, manage: undefined, create: undefined } }" :class="{ selected: route.query['manage'] !== 'groups' }">群组聊天</RouterLink><RouterLink :to="{ path: route.path, query: { ...route.query, manage: 'groups' } }" :class="{ selected: route.query['manage'] === 'groups' }">群组管理</RouterLink></nav>
  <ProjectsView v-if="route.query['manage'] === 'groups'" mode="groups" /><ChatView v-else />
</template>
