import { computed, onScopeDispose, ref } from "vue";
import { ApiError } from "../api/client.ts";

export interface ConfirmedAction {
  /** 动作种类 + 稳定目标 ID，同一页面内用于恢复尚未核对的结果。 */
  key: string;
  title: string; description: string; confirmLabel: string; successMessage: string;
  isCurrent(): boolean;
  execute(isActive: () => boolean): Promise<void>;
  /** 只读/预览；不可在这里执行已确认的业务变更。 */
  prepare?(isActive: () => boolean): Promise<void>;
  /** 在同一有效作用域读取完整权威状态；读取拒绝/失败必须抛出，不能当成不存在。 */
  reconcile(isActive: () => boolean): Promise<boolean>;
  afterSuccess(): Promise<void>;
}
type Phase = "ready" | "preparing" | "submitting" | "failed" | "refresh-required" | "unknown" | "checking";

export function useConfirmedAction(options: {
  success(message: string): void;
  refreshError(message: string): void;
}) {
  const action = ref<ConfirmedAction | null>(null);
  const phase = ref<Phase>("ready");
  const error = ref<string | null>(null);
  const unresolved = new Map<string, { action: ConfirmedAction; error: string | null }>();
  const pending = computed(() => phase.value === "submitting" || phase.value === "checking");
  const canConfirm = computed(() => !!action.value && ["ready", "failed"].includes(phase.value));
  let disposed = false;
  const current = (target: ConfirmedAction) => !disposed && action.value === target && target.isCurrent();
  const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
  function clearActive(): void { action.value = null; phase.value = "ready"; error.value = null; }
  function reset(): void { clearActive(); unresolved.clear(); }
  function cancel(): void {
    if (pending.value) return;
    if (phase.value === "unknown" && action.value) unresolved.set(action.value.key, { action: action.value, error: error.value });
    clearActive();
  }

  async function complete(target: ConfirmedAction): Promise<void> {
    if (!current(target)) return;
    try { await target.afterSuccess(); }
    catch (cause) { if (!disposed && target.isCurrent()) options.refreshError(`操作已完成，但刷新失败：${message(cause)}`); }
    finally {
      if (action.value === target) clearActive();
      // 已确认的完成可在刷新导致自身页面卸载后反馈；消息须指明原操作对象。
      options.success(target.successMessage);
    }
  }
  async function prepare(target: ConfirmedAction): Promise<void> {
    phase.value = "preparing"; error.value = null;
    try {
      await target.prepare?.(() => current(target));
      if (current(target)) phase.value = "ready";
    } catch (cause) {
      if (current(target)) { phase.value = "refresh-required"; error.value = message(cause); }
    }
  }
  async function open(value: ConfirmedAction): Promise<void> {
    if (action.value || disposed || !value.isCurrent()) return;
    const previous = unresolved.get(value.key);
    unresolved.delete(value.key);
    if (previous?.action.isCurrent()) {
      action.value = previous.action; phase.value = "unknown"; error.value = previous.error;
      return;
    }
    action.value = value; error.value = null; phase.value = "ready";
    if (value.prepare) await prepare(action.value);
  }
  async function confirm(): Promise<void> {
    const target = action.value;
    if (!target || !current(target) || !canConfirm.value) return;
    phase.value = "submitting"; error.value = null;
    try { await target.execute(() => current(target)); }
    catch (cause) {
      if (!current(target)) return;
      // 明确的请求拒绝无业务提交；网络、超时、不可信终态不允许盲重试。
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && ![408, 499].includes(cause.status)) {
        phase.value = target.prepare ? "refresh-required" : "failed";
        error.value = message(cause);
      } else {
        phase.value = "unknown";
        error.value = `操作结果未知，请先核对最新状态。关闭窗口不会撤销已经提交的操作。${message(cause)}`;
      }
      return;
    }
    await complete(target);
  }
  async function retryPreview(): Promise<void> {
    const target = action.value;
    if (!target || !current(target) || phase.value !== "refresh-required") return;
    await prepare(target);
  }
  async function reconcile(): Promise<void> {
    const target = action.value;
    if (!target || !current(target) || phase.value !== "unknown") return;
    phase.value = "checking";
    try {
      const applied = await target.reconcile(() => current(target));
      if (!current(target)) return;
      if (applied) { await complete(target); return; }
      if (target.prepare) await prepare(target);
      else phase.value = "ready";
      if (current(target) && phase.value === "ready") error.value = "已读取最新状态，当前对象仍存在。请核对后再次确认。";
    } catch (cause) {
      if (current(target)) { phase.value = "unknown"; error.value = `仍无法确认操作结果，请稍后核对。${message(cause)}`; }
    }
  }
  onScopeDispose(() => { disposed = true; reset(); });
  return { action, phase, error, pending, canConfirm, open, confirm, cancel, reset, retryPreview, reconcile };
}
