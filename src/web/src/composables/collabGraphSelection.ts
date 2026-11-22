/** #177 阶段 1：P02 深链意图与选中态的纯状态收敛，不产生任何示例节点。 */
export interface ConversationSelection {
  selectedId: string | null;
  pendingDeepLink: boolean;
}

export interface SelectionContext {
  loading: boolean;
  failed: boolean;
  projectChanged: boolean;
}

export function initialConversationSelection(view: string | null): ConversationSelection {
  return { selectedId: null, pendingDeepLink: view === "conversation" };
}

/** 首次从「无项目」解析到真实项目不属于用户切换，不应吞掉 P02 深链意图。 */
export function isProjectSwitch(previousId: string | null | undefined, nextId: string | null): boolean {
  return previousId !== undefined && previousId !== null && previousId !== nextId;
}

/**
 * 读模型就绪后兑现 `?view=conversation`；空图/加载态不注入选中项。
 * 项目切换或读取失败时丢弃上一项目的选择与深链意图；成员已不在当前图时也清空。
 */
export function reconcileConversationSelection(
  state: ConversationSelection,
  memberIds: readonly string[],
  context: SelectionContext,
): ConversationSelection {
  if (context.projectChanged || context.failed) return { selectedId: null, pendingDeepLink: false };
  if (context.loading) return state;
  const available = memberIds.filter((id) => typeof id === "string" && id.length > 0);
  if (available.length === 0) return { selectedId: null, pendingDeepLink: state.pendingDeepLink };
  if (state.pendingDeepLink) return { selectedId: available[0]!, pendingDeepLink: false };
  if (state.selectedId !== null && !available.includes(state.selectedId)) return { selectedId: null, pendingDeepLink: false };
  return state;
}
