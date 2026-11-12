<script setup lang="ts">
import { nextTick, onBeforeUnmount, onUpdated, ref, useId, watch } from "vue";

const props = withDefaults(defineProps<{
  open: boolean; title: string; description?: string; confirmLabel?: string; cancelLabel?: string;
  pending?: boolean; disabled?: boolean; error?: string | null;
  confirmTestId?: string; cancelTestId?: string;
}>(), { description: "", confirmLabel: "确认", cancelLabel: "取消", pending: false, disabled: false, error: null,
  confirmTestId: "confirm-submit", cancelTestId: "confirm-cancel" });
const emit = defineEmits<{ confirm: []; cancel: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const cancelButton = ref<HTMLButtonElement | null>(null);
const focusFallback = ref<HTMLElement | null>(null);
const titleId = useId(), descriptionId = useId();
let previousFocus: HTMLElement | null = null;

function isAvailable(element: HTMLElement): boolean {
  const visibility = element.ownerDocument.defaultView?.getComputedStyle(element).visibility;
  return !element.matches(":disabled") && !element.closest("[inert]") && element.getClientRects().length > 0
    && visibility !== "hidden" && visibility !== "collapse";
}
function tabStops(): HTMLElement[] {
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
  // pending 会禁用当前按钮，恢复 slot 也会增删控件；更新后不能把焦点留在 body。
  const cancel = cancelButton.value;
  (cancel && isAvailable(cancel) ? cancel : tabStops()[0] ?? focusFallback.value)?.focus();
}
function keepTabFocus(event: KeyboardEvent): void {
  if (event.key !== "Tab" || event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || !dialog.value?.open) return;
  // 每次读取当前 slot/disabled 状态；仅接管边界，保留控件内部的原生键盘行为。
  const stops = tabStops(), active = dialog.value.ownerDocument.activeElement as HTMLElement | null;
  const boundary = event.shiftKey ? stops[0] : stops.at(-1);
  if (!active || !stops.includes(active) || active === boundary) {
    event.preventDefault();
    ((event.shiftKey ? stops.at(-1) : stops[0]) ?? focusFallback.value)?.focus();
  }
}

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
    ensureFocusInside();
  } else if (!open) {
    dialog.value?.close?.();
    restoreFocus();
  }
}, { immediate: true, flush: "post" });
function cancel(event?: Event): void {
  event?.preventDefault();
  if (!props.pending) emit("cancel");
}
onUpdated(ensureFocusInside);
onBeforeUnmount(() => { void nextTick(restoreFocus); });
</script>

<template>
  <dialog v-if="open" ref="dialog" class="confirm-dialog" :aria-labelledby="titleId" :aria-describedby="description ? descriptionId : undefined" :aria-busy="pending" data-testid="confirmation-dialog" @cancel="cancel" @keydown="keepTabFocus">
    <header class="confirm-dialog-heading"><h2 :id="titleId" ref="focusFallback" tabindex="-1">{{ title }}</h2></header>
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
.confirm-dialog { width: min(560px, calc(100vw - 32px)); max-width: calc(100vw - 32px); max-height: calc(100dvh - 32px); padding: 0; border: 1px solid var(--control-border); border-radius: 14px; color: var(--fg); background: var(--surface-raised); box-shadow: var(--shadow-popup); }
.confirm-dialog[open] { display: flex; flex-direction: column; }
.confirm-dialog::backdrop { background: var(--backdrop); }
.confirm-dialog-heading { flex: none; padding: 24px 24px 0; overflow-wrap: anywhere; }.confirm-dialog-heading h2 { margin: 0; line-height: 1.5; }
.confirm-dialog-body { padding: 12px 24px 24px; overflow: auto; overscroll-behavior: contain; min-height: 0; overflow-wrap: anywhere; }.confirm-dialog-description { margin-top: 0; }
.confirm-dialog-actions { flex: none; display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; padding: 16px 24px; border-top: 1px solid var(--border); background: var(--surface-raised); }.confirm-dialog-actions .danger { border-color: var(--bad); }
@media (max-width: 500px) { .confirm-dialog-heading { padding: 20px 20px 0; }.confirm-dialog-body { padding: 12px 20px 20px; }.confirm-dialog-actions { padding: 14px 20px; } }
</style>
