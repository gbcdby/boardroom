import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../logger.ts";
import { createMcpCore, createMcpStore, type Heartbeat, type McpStore } from "./core.ts";
import { createMcpServer } from "./server.ts";

/** MCP Streamable HTTP 端点路径（挂在 F1 的同一 HTTP server 上）。 */
export const MCP_HTTP_PATH = "/mcp";

/** 悬挂会话的清理超时：超过该时长没有任何请求即回收（D6：Claude 不发 DELETE）。 */
export const MCP_SESSION_IDLE_TIMEOUT_MS = 5 * 60_000;

export interface McpTransportOptions {
  readonly logger: Logger;
  readonly heartbeat: Heartbeat;
  /** 共享 store；缺省新建（测试可注入）。 */
  readonly store?: McpStore;
}

export interface McpSessionsHandler {
  /** 处理发往 MCP_HTTP_PATH 的请求；返回 false 表示不是 MCP 路径。 */
  handle(request: IncomingMessage, response: ServerResponse, body: unknown): Promise<boolean>;
  /** 当前活跃 HTTP 会话数（测试与观测）。 */
  readonly sessionCount: number;
  /** 当前挂起中的等待调用数（测试与观测）。 */
  readonly pendingWaitCount: number;
  /** 关闭所有 HTTP 会话与挂起等待。幂等。 */
  close(): Promise<void>;
}

interface HttpSession {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
  readonly core: ReturnType<typeof createMcpCore>;
  lastActivity: number;
}

/**
 * 为 F1 的 HTTP server 装配 MCP Streamable HTTP 端点。
 *
 * 一个有状态的 MCP 客户端会话 = 一个 transport + 一个 server + 一个 core，
 * 它们共享同一个 {@link McpStore}，从而在同一群组内互相可见。会话无心跳时按
 * {@link MCP_SESSION_IDLE_TIMEOUT_MS} 回收，避免 Claude 端的悬挂会话泄漏。
 */
export function createMcpSessionsHandler(options: McpTransportOptions): McpSessionsHandler {
  const log = options.logger.child({ component: "mcp-http" });
  const store = options.store ?? createMcpStore();
  const sessions = new Map<string, HttpSession>();
  let closed = false;

  function sweepIdle(): void {
    const now = Date.now();
    for (const [sid, session] of sessions) {
      if (now - session.lastActivity < MCP_SESSION_IDLE_TIMEOUT_MS) continue;
      log.info("mcp_session_idle_timeout", { sessionId: sid });
      void disposeSession(sid);
    }
  }
  const sweepTimer = setInterval(sweepIdle, Math.min(MCP_SESSION_IDLE_TIMEOUT_MS, 60_000));
  sweepTimer.unref?.();

  async function disposeSession(sid: string): Promise<void> {
    const session = sessions.get(sid);
    if (!session) return;
    sessions.delete(sid);
    session.core.close();
    try {
      await session.server.close();
    } catch {
      // 关闭失败不影响清理。
    }
  }

  async function createSession(request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, session);
        log.info("mcp_session_initialized", { sessionId: sid });
      },
    });
    const core = createMcpCore({ logger: options.logger, heartbeat: options.heartbeat, store, memberKey: "http" });
    const server = createMcpServer({ core, logger: options.logger });
    const session: HttpSession = { transport, server, core, lastActivity: Date.now() };

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
        log.info("mcp_session_closed", { sessionId: transport.sessionId });
      }
      core.close();
    };

    // exactOptionalPropertyTypes 下 SDK 的 Transport 可选项类型与 McpServer.connect 不完全一致，
    // 运行时完全兼容（SDK 自身就是该组合），这里显式收窄。
    await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
    await transport.handleRequest(request, response, body);
  }

  return {
    async handle(request, response, body) {
      if (closed) return false;
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname !== MCP_HTTP_PATH) return false;

      const sessionId = request.headers["mcp-session-id"];
      const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;

      if (sid && sessions.has(sid)) {
        const session = sessions.get(sid)!;
        session.lastActivity = Date.now();
        await session.transport.handleRequest(request, response, body);
        return true;
      }

      // 初始化请求（无会话 ID）→ 新建会话。
      if (request.method === "POST" && isInitializeRequest(body)) {
        await createSession(request, response, body);
        return true;
      }

      // 未知会话 ID 的后续请求：SDK 语义为 404。
      if (sid) {
        writeJsonRpcError(response, 404, -32001, "Session not found");
        return true;
      }
      writeJsonRpcError(response, 400, -32000, "Bad Request: Missing session ID");
      return true;
    },

    get sessionCount() {
      return sessions.size;
    },

    get pendingWaitCount() {
      let total = 0;
      for (const session of sessions.values()) total += session.core.pendingWaitCount;
      return total;
    },

    async close() {
      if (closed) return;
      closed = true;
      clearInterval(sweepTimer);
      const ids = [...sessions.keys()];
      await Promise.all(ids.map((sid) => disposeSession(sid)));
      log.info("mcp_http_closed", { sessionsClosed: ids.length });
    },
  };
}

function writeJsonRpcError(response: ServerResponse, status: number, code: number, message: string): void {
  const payload = JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}
