<script setup lang="ts">
import { nextTick, onBeforeUnmount, onUpdated, ref, useId, watch } from "vue";
const props = withDefaults(defineProps<{ open: boolean; title: string; pending?: boolean; confirmDisabled?: boolean; dirty?: boolean; error?: string | null; confirmLabel?: string; confirmTestId?: string }>(), { pending: false, confirmDisabled: false, dirty: false, error: null, confirmLabel: "创建", confirmTestId: "create-submit" });
const emit = defineEmits<{ confirm: []; close: [] }>();
const dialog = ref<HTMLDialogElement | null>(null), titleElement = ref<HTMLElement | null>(null);
const titleId = useId();
const discard = ref(false);
let previousFocus: HTMLElement | null = null;
let opened = false;
function close(event?: Event): void { event?.preventDefault(); if (!props.pending) { if (props.dirty) discard.value = true; else emit("close"); } }
function isAvailable(element: HTMLElement): boolean {
  const visibility = element.ownerDocument.defaultView?.getComputedStyle(element).visibility;
  return !element.matches(":disabled") && !element.closest("[inert]") && element.getClientRects().length > 0
    && visibility !== "hidden" && visibility !== "collapse";
}
function focusable(): HTMLElement[] {
  if (!dialog.value?.open) return [];
  return [...dialog.value.querySelectorAll<HTMLElement>("button, a[href], area[href], input, select, textarea, summary, iframe, [tabindex], [contenteditable]")]
    .filter(element => (element.tabIndex >= 0 || (element.isContentEditable && !element.hasAttribute("tabindex"))) && isAvailable(element))
    .sort((left, right) => (left.tabIndex > 0 ? left.tabIndex : Number.MAX_SAFE_INTEGER) - (right.tabIndex > 0 ? right.tabIndex : Number.MAX_SAFE_INTEGER));
}
function ensureFocusInside(): void {
  const root = dialog.value;
  if (!root?.open) return;
  const active = root.ownerDocument.activeElement as HTMLElement | null;
  if (active && active !== root && root.contains(active) && isAvailable(active)) return;
  (props.pending ? titleElement.value : focusable()[0] ?? titleElement.value)?.focus();
}
function keydown(event: KeyboardEvent): void {
  if (event.key !== "Tab" || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  const stops = focusable(), active = dialog.value?.ownerDocument.activeElement;
  if (!active || !stops.includes(active as HTMLElement) || active === (event.shiftKey ? stops[0] : stops.at(-1))) { event.preventDefault(); ((event.shiftKey ? stops.at(-1) : stops[0]) ?? titleElement.value)?.focus(); }
}
function restoreFocus(): void {
  if (!opened) return;
  const target = previousFocus?.isConnected ? previousFocus : typeof document !== "undefined" ? document.querySelector<HTMLElement>("main h1") : null;
  if (target) { if (target.tagName === "H1") target.tabIndex = -1; target.focus({ preventScroll: true }); }
  previousFocus = null; opened = false;
}
watch(() => props.open, async open => {
  discard.value = false;
  if (open && typeof document !== "undefined") { previousFocus = document.activeElement as HTMLElement | null; opened = true; }
  await nextTick();
  if (open && props.open) { if (!dialog.value?.open) dialog.value?.showModal?.(); (focusable().find(el => el.matches("input, select, textarea")) ?? titleElement.value)?.focus?.(); }
  else { dialog.value?.close?.(); restoreFocus(); }
}, { immediate: true, flush: "post" });
watch([discard, () => props.pending], async () => { await nextTick(); if (dialog.value?.open) (props.pending ? titleElement.value : focusable()[0] ?? titleElement.value)?.focus(); });
onUpdated(ensureFocusInside);
onBeforeUnmount(() => { void nextTick(restoreFocus); });
</script>
<template>
  <dialog v-if="open" ref="dialog" class="creation-dialog" :aria-labelledby="titleId" :aria-busy="pending" data-testid="creation-dialog" @cancel="close" @keydown="keydown">
    <form @submit.prevent="!pending && !confirmDisabled && !discard && emit('confirm')">
      <header><h2 :id="titleId" ref="titleElement" tabindex="-1">{{ discard ? '放弃未保存的内容？' : title }}</h2></header>
      <div class="creation-body"><p v-if="discard">关闭后会丢弃本次填写的内容。</p><div v-if="!discard"><slot /><p v-if="error" class="error" role="alert">{{ error }}</p></div></div>
      <footer v-if="discard"><button type="button" @click="discard = false">继续编辑</button><button type="button" class="danger" data-testid="discard-create" @click="emit('close')">放弃更改</button></footer>
      <footer v-else><button type="button" :disabled="pending" data-testid="cancel-create" @click="close">取消</button><button type="submit" class="primary" :disabled="pending || confirmDisabled" :data-testid="confirmTestId">{{ pending ? '正在保存…' : confirmLabel }}</button></footer>
    </form>
  </dialog>
</template>
<style scoped>
.creation-dialog { width: min(560px, calc(100vw - 32px)); max-width: calc(100vw - 32px); max-height: calc(100dvh - 32px); padding: 0; border: 1px solid var(--border); border-radius: 14px; background: var(--card-bg); color: var(--fg); box-shadow: var(--shadow); }.creation-dialog::backdrop { background: color-mix(in srgb, var(--fg) 32%, transparent); }.creation-dialog form { display: flex; flex-direction: column; max-height: calc(100dvh - 34px); }.creation-dialog header { padding: 24px 24px 0; }.creation-dialog h2 { margin: 0; overflow-wrap: anywhere; }.creation-body { padding: 20px 24px 24px; overflow: auto; min-height: 0; overscroll-behavior: contain; }.creation-dialog footer { flex: none; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--border); padding: 16px 24px; }.creation-body :deep(.field) { margin-bottom: 16px; }.creation-body :deep(.field input) { width: 100%; }
@media (max-width:500px) { .creation-dialog header { padding: 20px 20px 0; }.creation-body { padding: 16px 20px 20px; }.creation-dialog footer { padding: 14px 20px; } }
</style>
