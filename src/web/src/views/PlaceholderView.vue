<script setup lang="ts">
defineProps<{ title: string }>();
</script>

<template>
  <section class="card">
    <h1>{{ title }}</h1>
    <p class="muted">此页面在后续阶段实现，当前仅为 WebUI 骨架占位。</p>
  </section>
</template>
