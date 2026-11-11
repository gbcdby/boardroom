<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
const props = withDefaults(defineProps<{ open: boolean; title: string; pending?: boolean; dirty?: boolean; error?: string | null; confirmLabel?: string; confirmTestId?: string }>(), { pending: false, dirty: false, error: null, confirmLabel: "创建", confirmTestId: "create-submit" });
const emit = defineEmits<{ confirm: []; close: [] }>();
const dialog = ref<HTMLDialogElement | null>(null), titleElement = ref<HTMLElement | null>(null);
const titleId = useId();
const discard = ref(false);
let previousFocus: HTMLElement | null = null;
function close(event?: Event): void { event?.preventDefault(); if (!props.pending) { if (props.dirty) discard.value = true; else emit("close"); } }
function focusable(): HTMLElement[] { return [...(dialog.value?.querySelectorAll?.<HTMLElement>('button, input, select, textarea, [tabindex="0"]') ?? [])].filter(el => !el.matches(":disabled") && el.getClientRects().length > 0); }
function keydown(event: KeyboardEvent): void {
  if (event.key !== "Tab" || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  const stops = focusable(), active = dialog.value?.ownerDocument.activeElement;
  if (!active || !stops.includes(active as HTMLElement) || active === (event.shiftKey ? stops[0] : stops.at(-1))) { event.preventDefault(); ((event.shiftKey ? stops.at(-1) : stops[0]) ?? titleElement.value)?.focus(); }
}
function restoreFocus(): void {
  const target = previousFocus?.isConnected ? previousFocus : typeof document !== "undefined" ? document.querySelector<HTMLElement>("main h1") : null;
  if (target) { if (target.tagName === "H1") target.tabIndex = -1; target.focus({ preventScroll: true }); }
  previousFocus = null;
}
watch(() => props.open, async open => {
  discard.value = false;
  if (open && typeof document !== "undefined") previousFocus = document.activeElement as HTMLElement | null;
  await nextTick();
  if (open && props.open) { if (!dialog.value?.open) dialog.value?.showModal?.(); (focusable().find(el => el.matches("input, select, textarea")) ?? titleElement.value)?.focus?.(); }
  else { dialog.value?.close?.(); restoreFocus(); }
}, { immediate: true, flush: "post" });
watch([discard, () => props.pending], async () => { await nextTick(); if (dialog.value?.open) (props.pending ? titleElement.value : focusable()[0] ?? titleElement.value)?.focus(); });
onBeforeUnmount(() => { void nextTick(restoreFocus); });
</script>
<template>
  <dialog v-if="open" ref="dialog" class="creation-dialog" :aria-labelledby="titleId" :aria-busy="pending" data-testid="creation-dialog" @cancel="close" @keydown="keydown">
    <form @submit.prevent="!pending && !discard && emit('confirm')">
      <header><h2 :id="titleId" ref="titleElement" tabindex="-1">{{ discard ? '放弃未保存的内容？' : title }}</h2></header>
      <div class="creation-body"><p v-if="discard">关闭后会丢弃本次填写的内容。</p><div v-if="!discard"><slot /><p v-if="error" class="error" role="alert">{{ error }}</p></div></div>
      <footer v-if="discard"><button type="button" @click="discard = false">继续编辑</button><button type="button" class="danger" data-testid="discard-create" @click="emit('close')">放弃更改</button></footer>
      <footer v-else><button type="button" :disabled="pending" data-testid="cancel-create" @click="close">取消</button><button type="submit" class="primary" :disabled="pending" :data-testid="confirmTestId">{{ pending ? '正在保存…' : confirmLabel }}</button></footer>
    </form>
  </dialog>
</template>
<style scoped>
.creation-dialog { width: min(560px, calc(100vw - 32px)); max-width: calc(100vw - 32px); max-height: calc(100dvh - 32px); padding: 0; border: 1px solid var(--border); border-radius: 14px; background: var(--card-bg); color: var(--fg); box-shadow: var(--shadow); }.creation-dialog::backdrop { background: color-mix(in srgb, var(--fg) 32%, transparent); }.creation-dialog form { display: flex; flex-direction: column; max-height: calc(100dvh - 34px); }.creation-dialog header { padding: 24px 24px 0; }.creation-dialog h2 { margin: 0; overflow-wrap: anywhere; }.creation-body { padding: 20px 24px 24px; overflow: auto; min-height: 0; overscroll-behavior: contain; }.creation-dialog footer { flex: none; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--border); padding: 16px 24px; }.creation-body :deep(.field) { margin-bottom: 16px; }.creation-body :deep(.field input) { width: 100%; }
@media (max-width:500px) { .creation-dialog header { padding: 20px 20px 0; }.creation-body { padding: 16px 20px 20px; }.creation-dialog footer { padding: 14px 20px; } }
</style>
