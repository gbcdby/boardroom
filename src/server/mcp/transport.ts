import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { DbDriver } from "../db/driver.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../logger.ts";
import type { Actor } from "../authz/authorize.ts";
import { createMcpCore, type Heartbeat, type SessionBinding } from "./core.ts";
import { createMcpServer } from "./server.ts";

/** MCP Streamable HTTP 端点路径（挂在 F1 的同一 HTTP server 上）。 */
export const MCP_HTTP_PATH = "/mcp";

/** 悬挂会话的清理超时：超过该时长没有任何请求即回收（D6：Claude 不发 DELETE）。 */
export const MCP_SESSION_IDLE_TIMEOUT_MS = 5 * 60_000;

export interface McpTransportOptions {
  readonly logger: Logger;
  readonly heartbeat: Heartbeat;
  /** 持久化数据库；MCP 工具直接落 F2 repository（T2）。 */
  readonly db: DbDriver;
  /** T7：防环/限流阈值（跨会话共享限流器）。缺省用 D5 默认值。 */
  readonly antiLoop?: import("./core.ts").AntiLoopRuntimeOptions;
  /**
   * T2（#49）：F2 守卫的「会话绑定 → Actor」装配口。省略时 core 用阶段 1 兼容映射
   * （`members.role` 的 manager/normal → top_manager/member），既有行为不变。
   */
  readonly actorFor?: (binding: SessionBinding) => Promise<Actor>;
}

export interface McpSessionsHandler {
  /** 处理发往 MCP_HTTP_PATH 的请求；返回 false 表示不是 MCP 路径。 */
  handle(request: IncomingMessage, response: ServerResponse, body: unknown): Promise<boolean>;
  /** 当前活跃 HTTP 会话数（测试与观测）。 */
  readonly sessionCount: number;
  /** 当前挂起中的等待调用数（测试与观测）。 */
  readonly pendingWaitCount: number;
  /**
   * T8（#21）修复：人经 HTTP 发送消息后，唤醒 HTTP 会话中在该群组等待、且被该消息
   * 路由 `wake` 的成员。MCP `send_message` 走 core 内部跨 core 唤醒；人的消息走 HTTP API
   * 不经过任何 core，需要显式触发本群组的挂起等待结算，否则等待方只能等超时或下次 wait
   * 才拿到积压（不符合 NFR-03 定向消息及时送达）。`wakeGate` 为该消息的 wake 成员集合。
   */
  wakeGroup(groupId: string, wakeGate?: ReadonlySet<string>): void;
  /** 关闭所有 HTTP 会话与挂起等待。幂等。 */
  close(options?: { strict?: boolean }): Promise<void>;
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
 * 一个有状态的 MCP 客户端会话 = 一个 transport + 一个 server + 一个 core。
 * 每个 core 直接读写同一个 SQLite（F2 repository），因此同一群组内跨会话互相可见；
 * 进程内仍共享一份「挂起等待」注册表用于跨会话唤醒。会话无心跳时按
 * {@link MCP_SESSION_IDLE_TIMEOUT_MS} 回收，避免 Claude 端的悬挂会话泄漏；回收时
 * 将该会话对应的持久化 MCP 会话标记为断开（状态恢复靠服务端持久化，D6）。
 */
export function createMcpSessionsHandler(options: McpTransportOptions): McpSessionsHandler {
  const log = options.logger.child({ component: "mcp-http" });
  const sessions = new Map<string, HttpSession>();
  let closed = false;
  /**
   * #61：跟踪 fire-and-forget 的唤醒结算（wakeGroup → resolveGroup）承诺，
   * 以便 `close()` 在关闭底层驱动前先排空在途的数据库操作，避免异步延迟
   * （PostgreSQL 跨网络往返）导致查询在 `driver.close()` 之后才落地而崩溃。
   */
  const inflightWakes = new Set<Promise<unknown>>();
  const disposals = new Map<string, Promise<void>>();
  let closing: Promise<void> | null = null;
  const closeFailures: unknown[] = [];

  function sweepIdle(): void {
    const now = Date.now();
    for (const [sid, session] of sessions) {
      if (now - session.lastActivity < MCP_SESSION_IDLE_TIMEOUT_MS) continue;
      log.info("mcp_session_idle_timeout", { sessionId: sid });
      void disposeSession(sid).catch(() => log.warn("mcp_session_dispose_incomplete", { sessionId: sid }));
    }
  }
  const sweepTimer = setInterval(sweepIdle, Math.min(MCP_SESSION_IDLE_TIMEOUT_MS, 60_000));
  sweepTimer.unref?.();

  function disposeSession(sid: string): Promise<void> {
    const pending = disposals.get(sid);
    if (pending) return pending;
    const session = sessions.get(sid);
    if (!session) return Promise.resolve();
    const operation = (async () => {
    // 连接会话回收：把持久化的 MCP 会话标记为断开，并把成员运行状态置为 offline。
    // #61：必须 await，否则 disconnect 内的数据库写入会在 driver.close() 之后才落地
    // （PostgreSQL 异步延迟放大该竞态），导致连接已关闭的查询崩溃。
    // Cancel waits before awaiting actual calls. Preserve a failed session so a
    // maintenance callback can retry its exact disconnect under the trusted scope.
    await session.core.close({ drain: true });
    await session.core.disconnect({ strict: true });
    await session.server.close();
    sessions.delete(sid);
    })();
    disposals.set(sid, operation);
    void operation.then(() => disposals.delete(sid), () => disposals.delete(sid));
    return operation;
  }

  async function createSession(request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, session);
        log.info("mcp_session_initialized", { sessionId: sid });
      },
    });
    const core = createMcpCore({
      logger: options.logger,
      heartbeat: options.heartbeat,
      db: options.db,
      memberKey: "http",
      ...(options.antiLoop ? { antiLoop: options.antiLoop } : {}),
      ...(options.actorFor ? { authz: { actorFor: options.actorFor } } : {}),
    });
    const server = createMcpServer({ core, logger: options.logger });
    const session: HttpSession = { transport, server, core, lastActivity: Date.now() };

    transport.onclose = () => {
      if (transport.sessionId) {
        log.info("mcp_session_closed", { sessionId: transport.sessionId });
        void disposeSession(transport.sessionId).catch(() => log.warn("mcp_session_dispose_incomplete"));
      }
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

    wakeGroup(groupId, wakeGate) {
      if (closed) return;
      // 遍历所有 HTTP 会话（每个会话一个 core），只唤醒在该群组等待且被放行的成员。
      // #61：承诺纳入 inflightWakes 跟踪，并就地兜错，避免 fire-and-forget 产生未处理 rejection。
      for (const session of sessions.values()) {
        const wake = session.core
          .resolveGroup(groupId, wakeGate)
          .catch((error: unknown) => {
            log.warn("resolveGroup 失败", { error, groupId });
          });
        inflightWakes.add(wake);
        void wake.finally(() => {
          inflightWakes.delete(wake);
        });
      }
    },

    close(closeOptions) {
      const checked = () => {
        if (closeOptions?.strict && closeFailures.length) throw new AggregateError(closeFailures, "mcp_http_close_incomplete");
      };
      if (closing) return closing.then(checked);
      closed = true;
      clearInterval(sweepTimer);
      closing = (async () => {
      // #61：先排空在途的唤醒结算，确保底层驱动关闭前所有数据库操作已落地。
      await Promise.all([...inflightWakes]);
      await Promise.allSettled([...disposals.values()]);
      const ids = [...sessions.keys()];
      const results = await Promise.allSettled(ids.map((sid) => disposeSession(sid)));
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed.length) {
        closeFailures.push(...failed.map(r => r.reason));
        log.warn("mcp_http_close_incomplete", { sessions: failed.length });
      } else {
        log.info("mcp_http_closed", { sessionsClosed: ids.length });
      }
      })();
      return closing.then(checked);
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
