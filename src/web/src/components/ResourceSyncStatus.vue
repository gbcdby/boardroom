<script setup lang="ts">
defineProps<{ connection: "connecting" | "connected" | "disconnected"; lastReadAt: number | null; failed: boolean }>();
</script>

<template>
  <p class="resource-sync-status muted small" data-testid="resource-sync-status">
    <span aria-live="polite">{{ connection === 'disconnected' ? '离线 / 可能不是最新' : failed ? '读取未确认 / 可能不是最新' : connection === 'connecting' ? '正在连接更新提示' : '更新提示已连接' }}</span>
    <span v-if="lastReadAt !== null">上次读取：<time :datetime="new Date(lastReadAt).toISOString()">{{ new Date(lastReadAt).toLocaleTimeString('zh-CN') }}</time></span>
    <span v-else>尚未成功读取</span>
  </p>
</template>

<style scoped>
.resource-sync-status { display: flex; flex-wrap: wrap; gap: .25rem 1rem; min-height: 1.5em; }
</style>
