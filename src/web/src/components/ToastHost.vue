<script setup lang="ts">
import { useToast } from "../composables/useToast.ts";
import AppIcon from "./AppIcon.vue";

const toast = useToast();
const { items, queuedCount } = toast;
function leaveFocus(id: string, event: FocusEvent): void {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) toast.resume(id, "focus");
}
</script>

<template>
  <aside class="toast-host" aria-label="操作提示" data-testid="toast-host">
    <ol class="toast-list" aria-live="polite" aria-relevant="additions text">
      <li v-for="item in items" :key="item.id" class="toast" :class="`toast-${item.tone}`" data-testid="toast" @pointerenter="toast.pause(item.id, 'pointer')" @pointerleave="toast.resume(item.id, 'pointer')" @focusin="toast.pause(item.id, 'focus')" @focusout="leaveFocus(item.id, $event)">
        <AppIcon :name="item.tone === 'success' ? 'check' : 'message'" :size="20" />
        <span data-testid="toast-message">{{ item.message }}</span>
        <button type="button" class="toast-close" :aria-label="`关闭提示：${item.message}`" @click="toast.dismiss(item.id)"><AppIcon name="close" :size="18" /></button>
      </li>
    </ol>
    <p v-if="queuedCount" class="toast-queued">还有 {{ queuedCount }} 条提示等待显示</p>
  </aside>
</template>

<style scoped>
.toast-host { position: fixed; z-index: 60; right: 24px; bottom: 24px; width: min(400px, calc(100vw - 32px)); pointer-events: none; }
.toast-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
.toast { pointer-events: auto; display: flex; align-items: flex-start; gap: 10px; padding: 14px 12px 14px 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--card-bg); color: var(--fg); box-shadow: 0 6px 24px rgb(0 0 0 / 12%); }
.toast > .app-icon { flex: none; margin-top: 3px; color: var(--muted); }.toast-success > .app-icon { color: var(--ok); }
.toast > span { flex: 1; min-width: 0; overflow-wrap: anywhere; line-height: 1.6; }.toast-close { min-width: 38px; border: 0; background: transparent; padding: 4px; margin: -1px 0 0; color: var(--muted); flex: none; }
.toast-queued { margin: 8px 0 0; font-size: 12px; text-align: right; color: var(--muted); }
@media (max-width: 760px) { .toast-close { min-width: 44px; } }
@media (max-width: 500px) { .toast-host { right: 16px; bottom: 16px; } }
</style>
