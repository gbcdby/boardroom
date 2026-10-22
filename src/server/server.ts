import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type Database from "better-sqlite3";
import type { AppConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { readMigrationState, runMigrations, type MigrationState } from "./db/migrate.ts";
import { migrations } from "./db/migrations/index.ts";
import { buildHealthReport } from "./health.ts";
import { createRepositories } from "./db/repositories.ts";
import type { Logger } from "./logger.ts";
import { createStaticHandler, isWebUiBuilt } from "./static.ts";
import { createWebSocketHub, type ServerEvent, type WebSocketHub } from "./ws.ts";
import { MCP_HTTP_PATH, createMcpSessionsHandler, type McpSessionsHandler } from "./mcp/transport.ts";
import { createT1ApiRouter } from "./api.ts";

/** WebSocket 端点路径。 */
export const WS_PATH = "/ws";

/** 服务启动失败（端口占用、数据库不可用等）；message 面向用户。 */
export class ServerStartupError extends Error {
  override readonly name = "ServerStartupError";
}

export interface StartServerOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  /** WebUI 构建产物目录，默认 `<repo>/dist/web`。 */
  readonly webRoot?: string;
}

export interface RunningServer {
  /** 实际监听端口（配置为 0 时为系统分配）。 */
  readonly port: number;
  /** 监听地址，固定 127.0.0.1。 */
  readonly host: string;
  readonly url: string;
  readonly wsUrl: string;
  readonly database: Database.Database;
  readonly migrationState: MigrationState;
  /** MCP Streamable HTTP 端点 URL（挂在同一 HTTP server 上）。 */
  readonly mcpUrl: string;
  /** 当前 MCP HTTP 会话数（测试与观测）。 */
  readonly mcpSessionCount: number;
  /** 当前挂起中的 MCP 等待调用数（测试与观测）。 */
  readonly mcpPendingWaitCount: number;
  /** 服务端主动广播事件给所有 WebUI 连接。 */
  broadcast(event: ServerEvent): void;
  /** 当前 WebSocket 连接数。 */
  readonly clientCount: number;
  close(): Promise<void>;
}

const HOST = "127.0.0.1";

/** 默认 WebUI 产物目录：相对本文件位置推导，避免写死绝对路径。 */
export function defaultWebRoot(): string {
  return path.resolve(import.meta.dirname, "../../dist/web");
}

/**
 * 启动 HTTP + WebSocket 服务。
 *
 * 顺序：打开数据库 → 执行迁移 → 建 HTTP server → 挂 WebSocket → 监听 127.0.0.1。
 * 任一步失败都会清理已获取的资源并抛出带恢复路径的错误。
 */
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const { config, logger } = options;
  const log = logger.child({ component: "server" });
  const webRoot = options.webRoot ?? defaultWebRoot();
  const startedAt = Date.now();

  let opened: { db: Database.Database; file: string };
  try {
    opened = openDatabase(config.dataDir);
  } catch (error) {
    log.error("数据库初始化失败", { error, dataDir: config.dataDir });
    throw new ServerStartupError((error as Error).message);
  }

  const db = opened.db;
  let migrationState: MigrationState;
  try {
    const result = runMigrations(db, migrations);
    migrationState = readMigrationState(db);
    log.info("迁移完成", {
      version: migrationState.version,
      applied: result.applied.length,
      pending: migrations.length - migrationState.applied.length,
    });
  } catch (error) {
    db.close();
    log.error("迁移失败", { error });
    throw new ServerStartupError(
      `${(error as Error).message}\n数据目录：${config.dataDir}\n` +
        `如需重置本地数据，可停止服务后删除该目录中的 agent-studio.db* 再启动。`,
    );
  }

  // T2 / D6：进程重启后，上一进程遗留的「connected」MCP 会话已失效。
  // 启动时统一标记为断开，并把这些成员的运行状态置为 offline——恢复完全依赖
  // 服务端持久化 + agent 重连后主动 join/心跳，不臆造在线（STATUS-02）。
  try {
    const recovered = createRepositories(db);
    const staleAt = new Date().toISOString();
    const staleCount = recovered.mcpSessions.markAllStale(staleAt);
    if (staleCount > 0) {
      for (const project of recovered.projects.list()) {
        for (const member of recovered.members.listByProject(project.id)) {
          const status = recovered.statuses.get(project.id, member.id);
          if (status && (status.state === "online" || status.state === "waiting" || status.state === "working")) {
            recovered.statuses.set(project.id, member.id, "offline");
          }
        }
      }
      log.info("启动恢复：清理遗留 MCP 会话", { staleSessions: staleCount });
    }
  } catch (error) {
    // 恢复失败不阻止启动；记录并继续（下次心跳/重连会纠正状态）。
    log.warn("启动恢复清理失败", { error });
  }

  const webuiBuilt = await isWebUiBuilt(webRoot);
  if (!webuiBuilt) {
    log.warn("WebUI 构建产物缺失，静态页面将不可用", {
      webRoot,
      hint: "运行 npm run build:web 生成 dist/web",
    });
  }
  const serveStatic = createStaticHandler({ root: webRoot });
  const mcpHandler: McpSessionsHandler = createMcpSessionsHandler({
    logger,
    heartbeat: config.heartbeat,
    db,
  });
  // T3：人的消息广播目标。hub 在 httpServer 之后创建，这里用晚绑定回调占位。
  let broadcastMessage: (message: import("./api.ts").MessageView) => void = () => {};
  const t1Api = createT1ApiRouter({
    db,
    logger,
    onMessage: (message) => broadcastMessage(message),
  });

  const httpServer = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      log.error("请求处理失败", { error, method: request.method, path: request.url });
      if (!response.headersSent) {
        writeJson(response, 500, { error: "internal_error", message: "服务端内部错误" });
      } else {
        response.end();
      }
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;

    if (pathname === "/api/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        writeJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      const report = buildHealthReport({
        db,
        heartbeat: config.heartbeat,
        startedAt,
        migrationCount: migrations.length,
        webuiBuilt,
      });
      writeJson(response, report.status === "ok" ? 200 : 503, report, request.method === "HEAD");
      return;
    }

    if (pathname.startsWith("/api/")) {
      // T1（#14）项目/群组/成员 API；未匹配时落到统一的 404。
      if (await t1Api.handle(request, response, pathname)) return;
      writeJson(response, 404, { error: "not_found", path: pathname });
      return;
    }

    if (pathname === MCP_HTTP_PATH) {
      const body = request.method === "POST" ? await readJsonBody(request) : undefined;
      if (await mcpHandler.handle(request, response, body)) return;
    }

    if (await serveStatic(request, response)) return;

    writeJson(response, 404, { error: "not_found", path: pathname });
  }

  const hub: WebSocketHub = createWebSocketHub({
    server: httpServer,
    path: WS_PATH,
    heartbeat: config.heartbeat,
    logger,
  });

  // T3：把人的消息通过 WebSocket 广播给 WebUI（阶段 1 WebUI = 人，可见全部群组消息）。
  // 注意：广播范围受本票约束「只推送允许范围内的消息」；目前 WebUI 连接即人的视角，
  // 单群组内全部消息都在人的可见范围内。MCP agent 的投递不经过 WS（走 wait_for_messages）。
  broadcastMessage = (message) => {
    hub.broadcast({ type: "message", message });
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        httpServer.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        resolve();
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(config.port, HOST);
    });
  } catch (error) {
    await hub.close();
    db.close();
    const err = error as NodeJS.ErrnoException;
    const message =
      err.code === "EADDRINUSE"
        ? `端口 ${config.port} 已被占用，无法启动。\n` +
          `恢复方式：停止占用该端口的进程（lsof -i :${config.port}），` +
          `或通过 AGENT_STUDIO_PORT / 配置文件 port 换一个端口。`
        : err.code === "EACCES"
          ? `没有权限绑定端口 ${config.port}（${err.message}）。请改用 1024 以上的端口。`
          : `无法监听 ${HOST}:${config.port}：${err.message}`;
    log.error("端口监听失败", { error: error, port: config.port });
    throw new ServerStartupError(message);
  }

  const address = httpServer.address() as AddressInfo;
  const port = address.port;
  const url = `http://${HOST}:${port}`;

  log.info("服务已启动", {
    url,
    wsUrl: `ws://${HOST}:${port}${WS_PATH}`,
    dataDir: config.dataDir,
    database: opened.file,
    heartbeat: config.heartbeat,
    webuiBuilt,
  });

  return {
    port,
    host: HOST,
    url,
    wsUrl: `ws://${HOST}:${port}${WS_PATH}`,
    database: db,
    migrationState,
    broadcast: (event) => hub.broadcast(event),
    get clientCount() {
      return hub.clientCount;
    },
    mcpUrl: `http://${HOST}:${port}${MCP_HTTP_PATH}`,
    get mcpSessionCount() {
      return mcpHandler.sessionCount;
    },
    get mcpPendingWaitCount() {
      return mcpHandler.pendingWaitCount;
    },
    async close() {
      await mcpHandler.close();
      await hub.close();
      // 先在途的连接一并断开：Streamable HTTP 的 SSE 响应会持续保持连接，
      // 仅 close() 不会中断它们；closeAllConnections 让进行中的等待随连接结束。
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
      if (db.open) db.close();
      log.info("服务已停止");
    },
  };
}

/** 读取并解析 JSON 请求体；空体或非法 JSON 返回 undefined（由 MCP 层给出协议错误）。 */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  if (raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown, headOnly = false): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(headOnly ? undefined : payload);
}
