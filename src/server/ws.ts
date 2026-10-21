import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { HeartbeatConfig } from "./config.ts";
import type { Logger } from "./logger.ts";

/** 客户端 → 服务端。 */
export type ClientEvent = { type: "ping"; sentAt?: string };

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
  | { type: "error"; code: "invalid_message" | "unknown_type"; message: string };

export interface WebSocketHubOptions {
  readonly server: HttpServer;
  readonly path: string;
  readonly heartbeat: HeartbeatConfig;
  readonly logger: Logger;
  /** 服务端时钟，便于测试。 */
  readonly now?: () => Date;
}

export interface WebSocketHub {
  /** 当前连接数。 */
  readonly clientCount: number;
  /** 广播事件给所有已连接客户端。 */
  broadcast(event: ServerEvent): void;
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
  const wss = new WebSocketServer({ noServer: true });
  /** 最近一次收到 pong 的时间戳（毫秒）。 */
  const lastSeen = new Map<WebSocket, number>();

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
      send(client, {
        type: "error",
        code: "unknown_type",
        message: `未知事件类型：${String((event as { type?: unknown })?.type)}`,
      });
    });

    client.on("close", (code) => {
      lastSeen.delete(client);
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
    async close() {
      clearInterval(heartbeatTimer);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}
