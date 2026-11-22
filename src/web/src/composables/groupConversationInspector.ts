/** #179 阶段 1：按真实群绑定读取已保存 Boardroom 消息的只读检查器状态。 */
import { ref } from "vue";
import type { MessageDto } from "../api/client.ts";

export interface InspectorScope {
  groupId: string;
  groupName: string;
  memberId: string | null;
  memberName: string | null;
}

export interface InspectorMessage {
  /** 来源消息逻辑 ID，可逐条追溯。 */
  id: string;
  groupId: string;
  senderMemberId: string;
  sender: string;
  text: string;
  createdAt: string;
}

export type InspectorLoader = (scope: InspectorScope) => Promise<readonly InspectorMessage[]>;

/** 只映射真实持久化的消息字段，不生成状态、活动或宿主内容。 */
export function toInspectorMessage(dto: MessageDto): InspectorMessage {
  return {
    id: dto.id,
    groupId: dto.groupId,
    senderMemberId: dto.senderMemberId,
    sender: dto.senderDisplayName ?? "已移除成员",
    text: dto.text,
    createdAt: dto.createdAt,
  };
}

/** 严格按 scope.groupId 过滤；目标群缺数据或不可读时不落到同名另一群或别的当前会话。 */
export function filterMessagesForScope(
  messages: readonly InspectorMessage[],
  scope: InspectorScope | null,
): InspectorMessage[] {
  if (!scope) return [];
  const unique = new Map<string, InspectorMessage>();
  for (const item of messages) {
    if (item.groupId !== scope.groupId) continue;
    if (!unique.has(item.id)) unique.set(item.id, item);
  }
  return [...unique.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/**
 * 每次选择都取得独立的递增令牌：旧 scope 的迟到响应（包括关闭后的响应）被忽略，
 * 当前选择是唯一有效 scope。读取失败只影响检查区，不写业务状态、不在群间回退。
 */
export function useGroupConversationInspector(loader: InspectorLoader) {
  const scope = ref<InspectorScope | null>(null);
  const messages = ref<InspectorMessage[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  let token = 0;

  async function select(next: InspectorScope | null): Promise<void> {
    const current = ++token;
    if (!next) {
      scope.value = null;
      messages.value = [];
      loading.value = false;
      error.value = null;
      return;
    }
    scope.value = next;
    messages.value = [];
    error.value = null;
    loading.value = true;
    try {
      const result = await loader(next);
      if (current !== token) return;
      messages.value = filterMessagesForScope(result, next);
      loading.value = false;
    } catch (err) {
      if (current !== token) return;
      messages.value = [];
      error.value = err instanceof Error ? err.message : "消息读取失败";
      loading.value = false;
    }
  }

  function clear(): void { void select(null); }

  return { scope, messages, loading, error, select, clear };
}
