/**
 * T4（#17）状态看板的前端类型，与 `src/server/status.ts` 的 EffectiveStatus 对应。
 * 同时定义 WebSocket `/ws` 上的 `status_update` 事件形状（只读消费）。
 */

export type EffectiveState = "online" | "offline" | "waiting" | "working";

export interface StatusBoardEntry {
  projectId: string;
  memberId: string;
  kind: "agent" | "human";
  displayName: string;
  state: EffectiveState;
  connection: "connected" | "disconnected" | "none";
  heartbeatTimedOut: boolean;
  heartbeatStale: boolean;
  stale: boolean;
  disconnected: boolean;
  lastHeartbeatAt: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  hostType: string | null;
  updatedAt: string | null;
}

export interface StatusUpdateEvent {
  type: "status_update";
  scope: "project";
  projectId: string;
  serverTime: string;
  statuses: StatusBoardEntry[];
}
