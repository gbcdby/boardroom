<script setup lang="ts">
import { RouterLink, RouterView } from "vue-router";

const navigation = [
  { to: "/", label: "概览" },
  { to: "/projects", label: "项目与群组" },
  { to: "/chat", label: "群聊" },
  { to: "/settings", label: "设置" },
];
</script>

<template>
  <div class="layout">
    <header class="topbar">
      <span class="brand">Agent Studio</span>
      <nav class="nav">
        <RouterLink v-for="item in navigation" :key="item.to" :to="item.to" class="nav-link">
          {{ item.label }}
        </RouterLink>
      </nav>
    </header>

    <main class="content">
      <RouterView />
    </main>

    <footer class="footer">
      <span>本地运行 · 仅 127.0.0.1 · 无认证</span>
    </footer>
  </div>
</template>
