import { onUnmounted, ref, type Ref } from "vue";
import type { StatusBoardEntry, StatusUpdateEvent } from "../api/status.ts";

/**
 * T4（#17）状态看板 WebSocket 连接。
 *
 * 职责：
 * - 连接 `/ws`，收到后端周期性下发的 `status_update`（项目作用域快照）后更新本地状态表；
 * - 当用户切换项目时，向服务端**声明 presence**（`{type:"presence", projectId, memberId}`），
 *   这是「人在 WebUI 在线」的唯一来源；人**不**上报 waiting/working。
 *
 * 边界（诚实说明）：本 composable 只做连接和 presence 声明，不渲染；Vue 组件消费
 * `statuses` / `connection`。断线自动重连（2s），重连后重新声明 presence。
 */

export type WsConnectionState = "connecting" | "connected" | "disconnected";

export interface StatusBoardSocket {
  readonly connection: Ref<WsConnectionState>;
  readonly statuses: Ref<StatusBoardEntry[]>;
  readonly serverTime: Ref<string | null>;
  /** 切换当前关注的项目；会（重新）向服务端声明 presence。 */
  setProject(projectId: string | null, memberId?: string): void;
  dispose(): void;
}

export function createStatusBoardSocket(endpoint?: string): StatusBoardSocket {
  const connection = ref<WsConnectionState>("connecting");
  const statuses = ref<StatusBoardEntry[]>([]);
  const serverTime = ref<string | null>(null);

  let socket: WebSocket | null = null;
  let currentProjectId: string | null = null;
  let currentMemberId: string | undefined;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function wsUrl(): string {
    if (endpoint) return endpoint;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}/ws`;
  }

  function sendPresence(): void {
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    if (currentProjectId === null) return;
    socket.send(
      JSON.stringify({
        type: "presence",
        projectId: currentProjectId,
        ...(currentMemberId === undefined ? {} : { memberId: currentMemberId }),
      }),
    );
  }

  function connect(): void {
    connection.value = "connecting";
    socket = new WebSocket(wsUrl());
    socket.addEventListener("open", () => {
      connection.value = "connected";
      sendPresence();
    });
    socket.addEventListener("message", (event) => {
      let data: unknown;
      try {
        data = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const evt = data as { type?: string };
      if (evt.type === "status_update") {
        const update = data as StatusUpdateEvent;
        if (update.scope === "project" && update.projectId === currentProjectId) {
          statuses.value = update.statuses;
          serverTime.value = update.serverTime;
        }
      }
    });
    socket.addEventListener("close", () => {
      connection.value = "disconnected";
      if (!disposed) reconnectTimer = setTimeout(connect, 2000);
    });
    socket.addEventListener("error", () => {
      connection.value = "disconnected";
    });
  }

  function setProject(projectId: string | null, memberId?: string): void {
    const changed = projectId !== currentProjectId || memberId !== currentMemberId;
    currentProjectId = projectId;
    currentMemberId = memberId;
    if (projectId === null) {
      statuses.value = [];
      return;
    }
    if (changed) sendPresence();
  }

  function dispose(): void {
    disposed = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    socket?.close();
    socket = null;
  }

  connect();

  return { connection, statuses, serverTime, setProject, dispose };
}

/** 组件内使用：自动在卸载时释放连接。 */
export function useStatusBoardSocket(endpoint?: string): StatusBoardSocket {
  const board = createStatusBoardSocket(endpoint);
  onUnmounted(() => board.dispose());
  return board;
}
