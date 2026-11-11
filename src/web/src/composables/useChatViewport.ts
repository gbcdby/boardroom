import { nextTick, onScopeDispose, onUpdated, ref, watch, type Ref } from "vue";

/** 为消息区保留真实剩余空间；过矮的页面保留可读高度，由页面自然滚动。 */
export function useChatViewport(
  messageList: Ref<HTMLElement | null>, conversation: Ref<HTMLElement | null>, scope: () => unknown,
  atBottom: Ref<boolean>, followLatest: () => void,
): Ref<number | undefined> {
  const height = ref<number>();
  let scheduleCurrent = () => {};
  const stop = watch(() => [messageList.value, conversation.value, scope()] as const, ([list, panel], _previous, onCleanup) => {
    if (!list || !panel || typeof window === "undefined") return;
    const viewport = window;
    let active = true, frame: number | null = null;
    async function measure(): Promise<void> {
      frame = null;
      if (!active) return;
      const listBox = list!.getBoundingClientRect(), panelBox = panel!.getBoundingClientRect();
      const viewportHeight = Math.min(viewport.innerHeight, viewport.visualViewport?.height ?? viewport.innerHeight);
      // 使用文档坐标，普通页面滚动不会反复改变列表高度或夺走历史阅读位置。
      const top = listBox.top + viewport.scrollY;
      const below = Math.max(0, panelBox.bottom - listBox.bottom);
      const available = viewportHeight - top - below;
      // 键盘等可把视觉视口压得很矮；最终仍保留可读下限，由页面自然滚动。
      const next = Math.max(128, Math.floor(Math.min(640, viewportHeight * .56, available)));
      if (next === height.value) return;
      const follow = atBottom.value;
      height.value = next;
      await nextTick();
      if (active && follow && atBottom.value) followLatest();
    }
    const schedule = () => {
      if (active && frame === null) frame = viewport.requestAnimationFrame(() => { void measure(); });
    };
    scheduleCurrent = schedule;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    if (observer) {
      const observed = new Set<Element>();
      const observe = (element: Element) => { if (!observed.has(element)) { observed.add(element); observer.observe(element); } };
      // 页签、错误提示及祖先布局可移动消息区；composer/说明的真实尺寸决定尾部占用。
      for (let element: Element | null = list; element; element = element.parentElement) {
        observe(element);
        for (let previous = element.previousElementSibling; previous; previous = previous.previousElementSibling) observe(previous);
      }
      for (const child of panel.children) observe(child);
    }
    viewport.addEventListener("resize", schedule);
    viewport.visualViewport?.addEventListener("resize", schedule);
    // 旧环境没有 ResizeObserver 时，手动调整输入框后的指针释放也能重新计量。
    if (!observer) viewport.addEventListener("pointerup", schedule);
    onCleanup(() => {
      active = false;
      if (frame !== null) viewport.cancelAnimationFrame(frame);
      observer?.disconnect();
      viewport.removeEventListener("resize", schedule);
      viewport.visualViewport?.removeEventListener("resize", schedule);
      if (!observer) viewport.removeEventListener("pointerup", schedule);
      if (scheduleCurrent === schedule) scheduleCurrent = () => {};
    });
    schedule();
  }, { flush: "post" });
  // 覆盖新增提示节点；无 ResizeObserver 时仍支持初次布局和 Vue 内容更新。
  onUpdated(() => scheduleCurrent());
  onScopeDispose(stop);
  return height;
}
