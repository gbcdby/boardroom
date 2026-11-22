/** #178 阶段 1：真实 MessageDto → sender→群方向层的可测试纯投影；不写业务状态、不生成两两私信。 */
import type { MessageEdge } from "./collabGraphProjection.ts";

export const MAX_VISIBLE_MESSAGE_MARKERS = 6;
/** 单次流动标记的持续时间，落在 #123 §9.3 要求的 0.6–1.2 秒内。 */
export const MESSAGE_ANIMATION_MS = 900;
/** 超出可见上限后按同方向 + 固定 60 秒时间窗聚合。 */
export const MESSAGE_TIME_WINDOW_MS = 60_000;

export interface MessageDirectionMarker extends MessageEdge {
  /** `${senderMemberId}->${groupId}`：同一 Agent 在不同群不会合并成一个方向。 */
  directionKey: string;
}

export interface MessageDirectionAggregate {
  key: string;
  directionKey: string;
  groupId: string;
  groupName: string;
  senderMemberId: string;
  sender: string;
  latestCreatedAt: string;
  count: number;
  messageIds: string[];
  sampleText: string;
}

export interface MessageDirectionLayer {
  /** 时间倒序、去重后的全部真实消息，供逐条追溯；不是可见视觉标记数。 */
  traceable: MessageDirectionMarker[];
  /** 最多 6 条可见标记。 */
  markers: MessageDirectionMarker[];
  /** 未进入可见标记的聚合项，按同方向/时间窗归组。 */
  aggregates: MessageDirectionAggregate[];
  totalCount: number;
  overflowCount: number;
}

export interface MessagePresentation {
  animate: boolean;
  showStaticArrows: boolean;
  showCounts: boolean;
}

export function directionKeyOf(edge: Pick<MessageEdge, "groupId" | "senderMemberId">): string {
  return `${edge.senderMemberId}->${edge.groupId}`;
}

/** 按稳定 messageId 去重并倒序；重试/补发沿用同一 ID，不产生第二条消息。 */
export function mergeMessageEdges(
  previous: readonly MessageEdge[],
  incoming: readonly MessageEdge[],
): MessageEdge[] {
  const unique = new Map<string, MessageEdge>();
  for (const edge of [...previous, ...incoming]) {
    if (!unique.has(edge.id)) unique.set(edge.id, edge);
  }
  return [...unique.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

function timeBucket(createdAt: string): number {
  const time = Date.parse(createdAt);
  return Number.isNaN(time) ? 0 : Math.floor(time / MESSAGE_TIME_WINDOW_MS);
}

function toMarker(edge: MessageEdge): MessageDirectionMarker {
  return { ...edge, directionKey: directionKeyOf(edge) };
}

export function buildMessageDirectionLayer(
  edges: readonly MessageEdge[],
  { maxMarkers = MAX_VISIBLE_MESSAGE_MARKERS }: { maxMarkers?: number } = {},
): MessageDirectionLayer {
  const unique = mergeMessageEdges([], edges);
  const traceable = unique.map(toMarker);
  const markers = traceable.slice(0, maxMarkers);
  const aggregates = new Map<string, MessageDirectionAggregate>();
  for (const edge of traceable.slice(maxMarkers)) {
    const bucket = timeBucket(edge.createdAt);
    const key = `${edge.directionKey}|${bucket}`;
    const existing = aggregates.get(key);
    if (existing) {
      existing.count += 1;
      existing.messageIds.push(edge.id);
    } else {
      aggregates.set(key, {
        key,
        directionKey: edge.directionKey,
        groupId: edge.groupId,
        groupName: edge.groupName,
        senderMemberId: edge.senderMemberId,
        sender: edge.sender,
        latestCreatedAt: edge.createdAt,
        count: 1,
        messageIds: [edge.id],
        sampleText: edge.text,
      });
    }
  }
  return {
    traceable,
    markers,
    aggregates: [...aggregates.values()].sort((a, b) =>
      b.latestCreatedAt.localeCompare(a.latestCreatedAt) || a.key.localeCompare(b.key)),
    totalCount: unique.length,
    overflowCount: Math.max(0, unique.length - markers.length),
  };
}

/** 暂停与减少动态只改变表现；静态箭头和计数始终保留，事实更新不依赖动画。 */
export function resolveMessagePresentation(reducedMotion: boolean, paused: boolean): MessagePresentation {
  return {
    animate: !reducedMotion && !paused,
    showStaticArrows: true,
    showCounts: true,
  };
}

export function messageTimeLabel(createdAt: string): string {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function summary(text: string): string {
  return text.length <= 48 ? text : `${text.slice(0, 48)}…`;
}

export function messageMarkerLabel(marker: MessageDirectionMarker): string {
  return `真实群消息 ${marker.id}：${marker.sender} 发往 ${marker.groupName}；${messageTimeLabel(marker.createdAt)}；摘要：${summary(marker.text)}`;
}

export function messageAggregateLabel(aggregate: MessageDirectionAggregate): string {
  return `同向聚合：${aggregate.sender} 发往 ${aggregate.groupName}，${aggregate.count} 条；最新 ${messageTimeLabel(aggregate.latestCreatedAt)}；消息 ID ${aggregate.messageIds.join("、")}`;
}
