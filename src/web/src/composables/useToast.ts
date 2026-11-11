import { computed, ref } from "vue";

export interface ToastItem { id: string; message: string; tone: "success" | "info" }
type Timer = ReturnType<typeof setTimeout>;
interface Clock { remaining: number; deadline: number; timer: Timer | null; pauses: Set<string> }

/** 全局短反馈。队列里的提示开始展示时才计时；错误留在触发操作的现场。 */
export function createToastStore() {
  const queue = ref<ToastItem[]>([]);
  const items = computed(() => queue.value.slice(0, 3));
  const queuedCount = computed(() => Math.max(0, queue.value.length - 3));
  const clocks = new Map<string, Clock>();
  const receipts = new Map<string, string>();
  let sequence = 0;

  function startVisible(): void {
    for (const item of items.value) {
      const clock = clocks.get(item.id);
      if (!clock || clock.timer !== null || clock.pauses.size > 0) continue;
      clock.deadline = Date.now() + clock.remaining;
      clock.timer = setTimeout(() => dismiss(item.id), clock.remaining);
      // Node 的行为测试无需为了未到期的 UI 提示延迟进程退出。
      if (typeof clock.timer === "object" && "unref" in clock.timer) clock.timer.unref();
    }
  }
  function dismiss(id: string): void {
    const clock = clocks.get(id);
    if (clock?.timer !== null && clock?.timer !== undefined) clearTimeout(clock.timer);
    clocks.delete(id);
    queue.value = queue.value.filter(item => item.id !== id);
    startVisible();
  }
  function push(tone: ToastItem["tone"], message: string, receipt?: string): string {
    const previous = receipt === undefined ? undefined : receipts.get(receipt);
    if (previous !== undefined) return previous;
    const id = `toast-${++sequence}`;
    if (receipt !== undefined) {
      receipts.set(receipt, id);
      if (receipts.size > 200) receipts.delete(receipts.keys().next().value!);
    }
    clocks.set(id, { remaining: 4000, deadline: 0, timer: null, pauses: new Set() });
    queue.value.push({ id, message, tone });
    startVisible();
    return id;
  }
  function pause(id: string, reason: string): void {
    const clock = clocks.get(id);
    if (!clock) return;
    if (clock.timer !== null) {
      clearTimeout(clock.timer); clock.timer = null;
      clock.remaining = Math.max(0, clock.deadline - Date.now());
    }
    clock.pauses.add(reason);
  }
  function resume(id: string, reason: string): void {
    clocks.get(id)?.pauses.delete(reason);
    startVisible();
  }
  function clear(): void {
    for (const clock of clocks.values()) if (clock.timer !== null) clearTimeout(clock.timer);
    clocks.clear(); receipts.clear(); queue.value = [];
  }
  return { items, queuedCount, success: (message: string, receipt?: string) => push("success", message, receipt),
    info: (message: string, receipt?: string) => push("info", message, receipt), dismiss, pause, resume, clear };
}

const toast = createToastStore();
export const useToast = () => toast;
