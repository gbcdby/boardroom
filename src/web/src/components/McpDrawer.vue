<script setup lang="ts">
import { nextTick, onBeforeUnmount, onUpdated, ref, useId, watch } from "vue";
const props = withDefaults(defineProps<{ open: boolean; title: string; busy?: boolean; lockClose?: boolean; testId?: string }>(),
  { busy: false, lockClose: false, testId: "mcp-drawer" });
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement | null>(null), heading = ref<HTMLElement | null>(null), titleId = useId();
let previous: HTMLElement | null = null;
function stops(): HTMLElement[] {
  if (!dialog.value?.open) return [];
  return [...dialog.value.querySelectorAll<HTMLElement>("button,input,select,textarea,summary,a[href],[tabindex]")]
    .filter(el => el.tabIndex >= 0 && !el.matches(":disabled") && !el.closest("[inert]") && el.getClientRects().length > 0
      && !["hidden", "collapse"].includes(getComputedStyle(el).visibility));
}
function focusInside(initial = false): void {
  if (!dialog.value?.open) return;
  const active = document.activeElement as HTMLElement | null;
  if (!initial && active && dialog.value.contains(active) && !active.matches(":disabled") && active.getClientRects().length) return;
  (stops().find(el => el.matches("input,select,textarea")) ?? stops()[0] ?? heading.value)?.focus();
}
function keydown(event: KeyboardEvent): void {
  if (event.key !== "Tab" || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
  const list = stops(), active = document.activeElement;
  if (!list.includes(active as HTMLElement) || active === (event.shiftKey ? list[0] : list.at(-1))) {
    event.preventDefault(); ((event.shiftKey ? list.at(-1) : list[0]) ?? heading.value)?.focus();
  }
}
function close(event?: Event): void { event?.preventDefault(); if (!props.lockClose) emit("close"); }
function restore(): void {
  if (!previous || typeof document === "undefined") return;
  const target = previous.isConnected ? previous : document.querySelector<HTMLElement>("main h1");
  if (target) { if (target.tagName === "H1") target.tabIndex = -1; target.focus({ preventScroll: true }); }
  previous = null;
}
watch(() => props.open, async open => {
  if (open && typeof document !== "undefined") previous = document.activeElement as HTMLElement | null;
  await nextTick();
  if (open && props.open) { if (dialog.value?.showModal && !dialog.value.open) dialog.value.showModal(); focusInside(true); }
  else { dialog.value?.close?.(); restore(); }
}, { immediate: true, flush: "post" });
onUpdated(focusInside);
onBeforeUnmount(() => { dialog.value?.close?.(); void nextTick(restore); });
</script>
<template>
  <dialog v-if="open" ref="dialog" class="mcp-drawer" :data-testid="testId" :aria-labelledby="titleId" :aria-busy="busy" @cancel="close" @keydown="keydown" @keydown.esc.stop>
    <header><h2 :id="titleId" ref="heading" tabindex="-1">{{ title }}</h2><button type="button" class="text-button" :disabled="lockClose" aria-label="关闭侧栏" @click="close">关闭</button></header>
    <div class="mcp-drawer-body"><slot /></div>
    <footer v-if="$slots.footer"><slot name="footer" /></footer>
  </dialog>
</template>
<style scoped>
.mcp-drawer { position: fixed; inset: 0; margin: 0 0 0 auto; width: min(480px, 100vw); max-width: 100vw; height: 100dvh; max-height: 100dvh; padding: 0; border: 0; border-left: 1px solid var(--border); background: var(--surface-raised); color: var(--fg); box-shadow: var(--shadow-popup); }
.mcp-drawer[open] { display: flex; flex-direction: column; }.mcp-drawer::backdrop { background: var(--backdrop); }
header { display: flex; gap: 16px; align-items: flex-start; justify-content: space-between; padding: 24px; border-bottom: 1px solid var(--border); }h2 { margin: 5px 0 0; }header button { flex: none; }
.mcp-drawer-body { padding: 24px; min-height: 0; overflow: auto; overscroll-behavior: contain; overflow-wrap: anywhere; }
footer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; padding: 18px 24px; border-top: 1px solid var(--border); flex: none; }
@media(max-width: 500px) { header,.mcp-drawer-body { padding: 20px; }footer { padding: 16px 20px; } }
</style>
