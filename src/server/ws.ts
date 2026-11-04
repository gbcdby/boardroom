import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { HeartbeatConfig } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { MessageView } from "./api.ts";
import { authorize, type Actor, type DenyCode } from "./authz/authorize.ts";
import { ownerActor } from "./authz/actors.ts";

/** 客户端 → 服务端。 */
export type ClientEvent =
  | { type: "ping"; sentAt?: string }
  /**
   * 客户端声明自己「人在哪个项目里在线」（T4 人的在线/离线）。
   * 仅用于人的在线展示；人不执行 agent 轮次，绝不产生 waiting/working。
   */
  | { type: "presence"; projectId?: string; memberId?: string };

/** 服务端 → 客户端。 */
export type ServerEvent =
  | {
      type: "welcome";
      clientId: string;
      serverTime: string;
      heartbeat: HeartbeatConfig;
    }
  | { type: "pong"; sentAt?: string; serverTime: string }
  | { type: "notice"; level: "info" | "warn"; message: string }
  | { type: "message"; message: MessageView }
  /**
   * 状态看板更新（T4）。`scope` 标明作用域：`project` 表示某项目的成员有效状态快照，
   * 只发给「对该项目可见」的客户端，避免泄漏未参与项目的数据。
   */
  | {
      type: "status_update";
      scope: "project";
      projectId: string;
      serverTime: string;
      statuses: unknown[];
    }
  | {
      type: "error";
      /**
       * 协议/守卫错误码。F2（#47）的权限拒绝统一以 `forbidden` 呈现，
       * 具体拒绝语义（cross_project / out_of_subtree / …）放在 `deny`。
       */
      code: "invalid_message" | "unknown_type" | "forbidden";
      message: string;
      /** 守卫稳定拒绝码（仅 code=forbidden 时有值）。 */
      deny?: DenyCode;
    };

export interface WebSocketHubOptions {
  readonly server: HttpServer;
  readonly path: string;
  readonly heartbeat: HeartbeatConfig;
  readonly logger: Logger;
  /** 服务端时钟，便于测试。 */
  readonly now?: () => Date;
  /**
   * F2（#47）守卫主体解析点：把 WebUI 的 presence 声明纳入统一守卫。
   * 省略 = 阶段 1 单用户无认证，连接主体一律是「人（owner）」→ 全部放行，行为不变。
   */
  readonly resolveActor?: (context: WsActorContext) => Actor | null;
}

/** WS 主体解析上下文：客户端声明的项目与成员。 */
export interface WsActorContext {
  readonly projectId: string;
  readonly memberId: string | null;
}

export interface WebSocketHub {
  /** 当前连接数。 */
  readonly clientCount: number;
  /** 广播事件给所有已连接客户端。 */
  broadcast(event: ServerEvent): void;
  /**
   * 广播某项目的状态看板快照（T4）。只发给「对该项目可见」的客户端：
   * 声明了其它项目的 presence 的客户端不会收到，避免跨项目泄漏。
   */
  broadcastProjectStatus(projectId: string, statuses: unknown[]): void;
  /** 某项目当前声明在线的人的数量（按 clientId 去重）。 */
  humanPresenceCount(projectId: string): number;
  /** 某项目当前在线的人的 memberId 集合（测试用）。 */
  humanPresenceMembers(projectId: string): readonly string[];
  /** 关闭所有连接并释放升级监听。 */
  close(): Promise<void>;
}

/**
 * 在既有 HTTP server 上挂 WebSocket 端点（仅 `path`，其他升级请求直接断开）。
 *
 * 心跳：服务端按 intervalMs 发 ping 帧，超时未回 pong 的连接被终止（timeoutMs）。
 */
export function createWebSocketHub(options: WebSocketHubOptions): WebSocketHub {
  const { server, path: wsPath, heartbeat, logger } = options;
  const now = options.now ?? (() => new Date());
  const log = logger.child({ component: "ws" });
  /** 阶段 1 默认主体：人（owner），不做范围收窄。 */
  const resolveActor = options.resolveActor ?? (({ projectId }) => ownerActor(projectId));
  const wss = new WebSocketServer({ noServer: true });
  /** 最近一次收到 pong 的时间戳（毫秒）。 */
  const lastSeen = new Map<WebSocket, number>();
  /** 客户端声明的在线项目（T4 人的在线）；客户端断开时清除。 */
  const presence = new Map<WebSocket, { projectId: string; memberId: string | null }>();

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== wsPath) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit("connection", client, request);
    });
  });

  wss.on("connection", (client) => {
    const clientId = randomUUID();
    lastSeen.set(client, Date.now());
    log.info("客户端连接", { clientId, clientCount: wss.clients.size });

    client.on("pong", () => lastSeen.set(client, Date.now()));

    client.on("message", (data, isBinary) => {
      if (isBinary) {
        send(client, { type: "error", code: "invalid_message", message: "仅支持文本 JSON 帧" });
        return;
      }
      let event: ClientEvent;
      try {
        event = JSON.parse(data.toString()) as ClientEvent;
      } catch {
        send(client, { type: "error", code: "invalid_message", message: "不是合法 JSON" });
        return;
      }
      if (event?.type === "ping") {
        const pong: ServerEvent = { type: "pong", serverTime: now().toISOString() };
        send(client, event.sentAt === undefined ? pong : { ...pong, sentAt: event.sentAt });
        return;
      }
      if (event?.type === "presence") {
        // 人的在线声明（T4）：仅记录该项目/成员，不产生 waiting/working。
        const projectId = typeof event.projectId === "string" ? event.projectId : "";
        const memberId = typeof event.memberId === "string" && event.memberId !== "" ? event.memberId : null;
        if (projectId === "") {
          presence.delete(client);
          log.debug("presence_cleared", { clientId });
          send(client, { type: "notice", level: "info", message: "presence 已更新" });
          return;
        }
        // F2（#47）：presence 是「在该项目里在线」的写入，交给统一守卫判定主体范围。
        // 阶段 1 默认主体是人（owner）→ 放行，行为不变；越出范围按拒绝码回错帧且不记录在线。
        const actor = resolveActor({ projectId, memberId });
        if (actor === null || actor === undefined) {
          log.info("presence 主体无法解析，守卫按 fail-closed 拒绝", { clientId, projectId });
          send(client, { type: "error", code: "forbidden", message: "无法确定连接主体，守卫拒绝。" });
          return;
        }
        const decision = authorize(actor, "status:view", {
          projectId,
          ...(memberId === null ? {} : { memberId }),
        });
        if (!decision.allowed) {
          log.info("presence 被权限守卫拒绝", { clientId, code: decision.code, projectId });
          send(client, { type: "error", code: "forbidden", deny: decision.code, message: decision.reason });
          return;
        }
        presence.set(client, { projectId, memberId });
        log.debug("presence_updated", { clientId, projectId });
        send(client, { type: "notice", level: "info", message: "presence 已更新" });
        return;
      }
      send(client, {
        type: "error",
        code: "unknown_type",
        message: `未知事件类型：${String((event as { type?: unknown })?.type)}`,
      });
    });

    client.on("close", (code) => {
      lastSeen.delete(client);
      presence.delete(client);
      log.info("客户端断开", { clientId, code, clientCount: wss.clients.size });
    });

    client.on("error", (error) => {
      log.warn("连接错误", { clientId, error });
    });

    send(client, {
      type: "welcome",
      clientId,
      serverTime: now().toISOString(),
      heartbeat,
    });
  });

  const heartbeatTimer = setInterval(() => {
    const deadline = Date.now() - heartbeat.timeoutMs;
    for (const client of wss.clients) {
      const seen = lastSeen.get(client) ?? 0;
      if (seen < deadline) {
        log.warn("心跳超时，断开连接", { clientCount: wss.clients.size });
        client.terminate();
        continue;
      }
      client.ping();
    }
  }, heartbeat.intervalMs);
  heartbeatTimer.unref();

  function send(client: WebSocket, event: ServerEvent): void {
    if (client.readyState !== WebSocket.OPEN) return;
    try {
      client.send(JSON.stringify(event));
    } catch (error) {
      log.warn("发送事件失败", { error });
    }
  }

  return {
    get clientCount() {
      return wss.clients.size;
    },
    broadcast(event) {
      for (const client of wss.clients) send(client, event);
    },
    broadcastProjectStatus(projectId, statuses) {
      const event: ServerEvent = {
        type: "status_update",
        scope: "project",
        projectId,
        serverTime: now().toISOString(),
        statuses,
      };
      for (const client of wss.clients) {
        // 只发给未声明其它项目、或声明了该项目的客户端；避免跨项目泄漏。
        const declared = presence.get(client);
        if (declared && declared.projectId !== projectId) continue;
        send(client, event);
      }
    },
    humanPresenceCount(projectId) {
      let count = 0;
      for (const decl of presence.values()) if (decl.projectId === projectId) count += 1;
      return count;
    },
    humanPresenceMembers(projectId) {
      const ids: string[] = [];
      for (const decl of presence.values()) {
        if (decl.projectId === projectId && decl.memberId !== null) ids.push(decl.memberId);
      }
      return ids;
    },
    async close() {
      clearInterval(heartbeatTimer);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}
