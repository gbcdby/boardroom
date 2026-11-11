<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from "vue";

const props = withDefaults(defineProps<{
  open: boolean; title: string; description?: string; confirmLabel?: string; cancelLabel?: string;
  pending?: boolean; disabled?: boolean; error?: string | null;
  confirmTestId?: string; cancelTestId?: string;
}>(), { description: "", confirmLabel: "确认", cancelLabel: "取消", pending: false, disabled: false, error: null,
  confirmTestId: "confirm-submit", cancelTestId: "confirm-cancel" });
const emit = defineEmits<{ confirm: []; cancel: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const cancelButton = ref<HTMLButtonElement | null>(null);
const titleId = useId(), descriptionId = useId();
let previousFocus: HTMLElement | null = null;

function restoreFocus(): void {
  if (typeof document === "undefined" || !previousFocus) return;
  const target = previousFocus?.isConnected ? previousFocus : document.querySelector<HTMLElement>("main h1, h1");
  if (target) { if (target.tagName === "H1") target.tabIndex = -1; target.focus({ preventScroll: true }); }
  previousFocus = null;
}
watch(() => props.open, async (open) => {
  if (open && typeof document !== "undefined") previousFocus = document.activeElement as HTMLElement | null;
  await nextTick();
  if (open && props.open) {
    // 非 DOM renderer 用来检查动作契约；原生模态/焦点仍由真实浏览器验收。
    if (dialog.value && typeof dialog.value.showModal === "function" && !dialog.value.open) dialog.value.showModal();
    cancelButton.value?.focus?.();
  } else if (!open) {
    dialog.value?.close?.();
    restoreFocus();
  }
}, { immediate: true, flush: "post" });
function cancel(event?: Event): void {
  event?.preventDefault();
  if (!props.pending) emit("cancel");
}
onBeforeUnmount(() => { void nextTick(restoreFocus); });
</script>

<template>
  <dialog v-if="open" ref="dialog" class="confirm-dialog" :aria-labelledby="titleId" :aria-describedby="description ? descriptionId : undefined" :aria-busy="pending" data-testid="confirmation-dialog" @cancel="cancel">
    <header class="confirm-dialog-heading"><h2 :id="titleId">{{ title }}</h2></header>
    <div class="confirm-dialog-body">
      <p v-if="description" :id="descriptionId" class="confirm-dialog-description">{{ description }}</p>
      <slot />
      <p v-if="error" class="error" role="alert" data-testid="confirmation-error">{{ error }}</p>
      <slot name="recovery" />
    </div>
    <footer class="confirm-dialog-actions">
      <button ref="cancelButton" type="button" :disabled="pending" :data-testid="cancelTestId" autofocus @click="cancel">{{ cancelLabel }}</button>
      <button type="button" class="danger" :disabled="pending || disabled" :data-testid="confirmTestId" @click="!pending && !disabled && emit('confirm')">{{ pending ? '处理中…' : confirmLabel }}</button>
    </footer>
  </dialog>
</template>

<style scoped>
.confirm-dialog { width: min(560px, calc(100vw - 32px)); max-width: calc(100vw - 32px); max-height: calc(100dvh - 32px); padding: 0; border: 1px solid var(--border); border-radius: 14px; color: var(--fg); background: var(--card-bg); box-shadow: 0 16px 60px rgb(0 0 0 / 18%); }
.confirm-dialog[open] { display: flex; flex-direction: column; }
.confirm-dialog::backdrop { background: rgb(15 23 42 / 36%); }
.confirm-dialog-heading { flex: none; padding: 24px 24px 0; overflow-wrap: anywhere; }.confirm-dialog-heading h2 { margin: 0; line-height: 1.5; }
.confirm-dialog-body { padding: 12px 24px 24px; overflow: auto; overscroll-behavior: contain; min-height: 0; overflow-wrap: anywhere; }.confirm-dialog-description { margin-top: 0; }
.confirm-dialog-actions { flex: none; display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; padding: 16px 24px; border-top: 1px solid var(--border); background: var(--card-bg); }.confirm-dialog-actions .danger { border-color: color-mix(in srgb, var(--bad) 45%, var(--border)); }
@media (max-width: 500px) { .confirm-dialog-heading { padding: 20px 20px 0; }.confirm-dialog-body { padding: 12px 20px 20px; }.confirm-dialog-actions { padding: 14px 20px; } }
</style>
