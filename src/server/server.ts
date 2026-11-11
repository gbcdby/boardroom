import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { AppConfig } from "./config.ts";
import { resolveBoardroomEnvironment, assertEnvironmentWritable, databaseDriverOptions, databaseForConnectedReader } from "./environment.ts";
import { createDbDriver, type DbDriver } from "./db/driver.ts";
import type { MigrationState } from "./db/migrate.ts";
import { migrations } from "./db/migrations/index.ts";
import { buildHealthReport } from "./health.ts";
import { createRepositories } from "./db/repositories.ts";
import type { Logger } from "./logger.ts";
import { createStaticHandler, isWebUiBuilt } from "./static.ts";
import { createWebSocketHub, type ServerEvent, type WebSocketHub } from "./ws.ts";
import { MCP_HTTP_PATH, createMcpSessionsHandler, type McpSessionsHandler } from "./mcp/transport.ts";
import { createT1ApiRouter, messageView, type ActorResolution } from "./api.ts";
import type { WsActorContext } from "./ws.ts";
import type { Actor } from "./authz/authorize.ts";
import type { SessionBinding } from "./mcp/core.ts";
import { createOrgActorResolver } from "./authz/org-actors.ts";
import type { OrgChangeRecorder } from "./org-change-hook.ts";
import { buildStatusBoard } from "./status.ts";
import { createRuntimeApi } from "./runtime/api.ts";
import { createRuntimeObservability } from "./runtime/observability.ts";
import { createRuntimeSupervisor, type RuntimeSupervisor } from "./runtime/supervisor.ts";
import { createHostLauncher } from "./runtime/hosts/launcher.ts";
import type { HostLauncher } from "./runtime/hosts/types.ts";
import { notifyMessageCommit, onMessageCommit } from "./runtime/dispatch-events.ts";
import { createTaskApi } from "./tasks/api.ts";
import { createMemoryApi } from "./memory/api.ts";
import { registerMemoryRuntime, closeMemoryRuntime } from "./memory/runtime.ts";
import { createSettingsApi } from "./settings/api.ts";
import { buildEffectiveSettings } from "./settings.ts";

/** WebSocket 端点路径。 */
export const WS_PATH = "/ws";

/** 服务启动失败（端口占用、数据库不可用等）；message 面向用户。 */
export class ServerStartupError extends Error {
  override readonly name = "ServerStartupError";
}

/**
 * F2（#47）入口主体注入点；T2（#49）默认装配真实组织数据。
 *
 * 省略 `authorization` 时，`startServer` 用 `createOrgActorResolver` 读真实
 * `org_nodes` / `members.node_id`：有岗位数据就注入 `nodeId` / `subtreeNodeIds`；
 * 升级库默认无组织数据时逐入口回退到阶段 1 兼容映射（人=owner），既有行为不变。
 * 测试/未来认证可显式注入覆盖三个解析点。
 */
export interface ServerAuthorization {
  readonly resolveHttpActor?: (resolution: ActorResolution) => Promise<Actor | null>;
  readonly resolveWsActor?: (context: WsActorContext) => Promise<Actor | null>;
  /** MCP 会话绑定 → 带岗位与子树的 Actor（注入到 core 的 `authz.actorFor`）。 */
  readonly resolveMcpActor?: (binding: SessionBinding) => Promise<Actor>;
}

export interface StartServerOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  /** WebUI 构建产物目录，默认 `<repo>/dist/web`。 */
  readonly webRoot?: string;
  /** F2 权限守卫主体注入（默认阶段 1 人=owner，行为不变）。 */
  readonly authorization?: ServerAuthorization;
  /** 组织变更提交后观察钩子；权威审计始终由领域事务写入。 */
  readonly orgChangeRecorder?: OrgChangeRecorder;
  /** 受信装配/测试 seam；不从 HTTP、聊天或运行时配置接受 launcher。 */
  readonly runtimeLauncher?: HostLauncher;
}

export interface RunningServer {
  /** 实际监听端口（配置为 0 时为系统分配）。 */
  readonly port: number;
  /** 监听地址，固定 127.0.0.1。 */
  readonly host: string;
  readonly url: string;
  readonly wsUrl: string;
  readonly database: DbDriver;
  readonly migrationState: MigrationState;
  /** MCP Streamable HTTP 端点 URL（挂在同一 HTTP server 上）。 */
  readonly mcpUrl: string;
  /** 当前 MCP HTTP 会话数（测试与观测）。 */
  readonly mcpSessionCount: number;
  /** 当前挂起中的 MCP 等待调用数（测试与观测）。 */
  readonly mcpPendingWaitCount: number;
  readonly runtimeSupervisor: RuntimeSupervisor;
  /** 服务端主动广播事件给所有 WebUI 连接。 */
  broadcast(event: ServerEvent): void;
  /** 立即把某项目状态看板快照广播给可见客户端（T4）。 */
  broadcastStatus(projectId: string): void;
  /** 当前 WebSocket 连接数。 */
  readonly clientCount: number;
  /** 某项目当前声明在线的人的数量（F2：配合守卫注入的观测口）。 */
  humanPresenceCount(projectId: string): number;
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
  const environment = await resolveBoardroomEnvironment({ config });
  await assertEnvironmentWritable(environment);

  // F1（#46）：经连接工厂打开持久化驱动；默认 SQLite，阶段 1 行为不变。
  let driver: DbDriver;
  try {
    driver = createDbDriver(databaseDriverOptions(environment));
  } catch (error) {
    log.error("数据库驱动配置无效", { error, dataDir: config.dataDir });
    throw new ServerStartupError((error as Error).message);
  }

  try {
    await driver.connect();
  } catch (error) {
    log.error("数据库初始化失败", { error, dataDir: config.dataDir });
    throw new ServerStartupError((error as Error).message);
  }

  let migrationState: MigrationState;
  try {
    const result = await driver.migrate(migrations);
    migrationState = await driver.migrationState();
    log.info("迁移完成", {
      version: migrationState.version,
      applied: result.applied.length,
      pending: migrations.length - migrationState.applied.length,
    });
  } catch (error) {
    await driver.close();
    log.error("迁移失败", { error });
    throw new ServerStartupError(
      `${(error as Error).message}\n数据目录：${config.dataDir}\n` +
        `如需重置本地数据，可停止服务后删除该目录中的 agent-studio.db* 再启动。`,
    );
  }

  try {
    registerMemoryRuntime(driver, {
      database: databaseForConnectedReader(environment.databaseDescriptor),
      ...(config.memory ? { config: config.memory } : {}),
      onDiagnostic: code => log.warn("memory_reader_unavailable", { code }),
    });
  } catch (error) {
    await driver.close();
    throw new ServerStartupError((error as Error).message);
  }

  const repos = createRepositories(driver);

  // T2 / D6：进程重启后，上一进程遗留的「connected」MCP 会话已失效。
  // 启动时统一标记为断开，并把这些成员的运行状态置为 offline——恢复完全依赖
  // 服务端持久化 + agent 重连后主动 join/心跳，不臆造在线（STATUS-02）。
  try {
    const recovered = repos;
    const staleAt = new Date().toISOString();
    const staleCount = await (recovered.mcpSessions.markAllStale(staleAt));
    if (staleCount > 0) {
      // 清扫覆盖**全部**项目（含 #48 的已归档项目）：归档只是非活跃态，
      // 遗留会话仍必须标记断开，不臆造在线。
      for (const project of await (recovered.projects.list({ includeArchived: true }))) {
        for (const member of await (recovered.members.listByProject(project.id))) {
          const status = await (recovered.statuses.get(project.id, member.id));
          if (status && (status.state === "online" || status.state === "waiting" || status.state === "working")) {
            await (recovered.statuses.set(project.id, member.id, "offline"));
          }
        }
      }
      log.info("启动恢复：清理遗留 MCP 会话", { staleSessions: staleCount });
    }
  } catch (error) {
    // 恢复失败不阻止启动；记录并继续（下次心跳/重连会纠正状态）。
    log.warn("启动恢复清理失败", { error });
  }

  // T2（#49）：把 F2 的纯权限结构接到真实 DB 数据。未显式注入 authorization 时，
  // 三个入口统一用 org_nodes / members.node_id 装配 Actor；无组织数据的升级库
  // 逐入口回退到阶段 1 兼容映射（人=owner），AC-CORE-* 行为不变。
  const orgResolver = createOrgActorResolver(repos);
  const authorization: ServerAuthorization = options.authorization ?? {
    resolveHttpActor: (resolution) => orgResolver.resolveHttpActor(resolution),
    resolveWsActor: (context) => orgResolver.resolveWsActor(context),
    resolveMcpActor: (binding) => orgResolver.actorForMcpBinding(binding),
  };

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
    db: driver,
    antiLoop: { ...(config.antiLoop ? { config: config.antiLoop } : {}) },
    ...(authorization.resolveMcpActor ? { actorFor: authorization.resolveMcpActor } : {}),
  });
  // hub 在 httpServer 之后创建；HTTP 提交后的通知使用晚绑定回调。
  let notifyHttpMessage: (message: import("./api.ts").MessageView) => void | Promise<void> = () => {};
  // 权威组织审计由 API 领域服务原子提交；可选 hook 只作提交后观察。
  const t1Api = createT1ApiRouter({
    db: driver, repos, environment,
    logger,
    heartbeat: config.heartbeat,
    onMessage: (message) => notifyHttpMessage(message),
    ...(authorization.resolveHttpActor ? { resolveActor: authorization.resolveHttpActor } : {}),
    ...(options.orgChangeRecorder ? { orgChangeRecorder: options.orgChangeRecorder } : {}),
  });
  const runtimeObservations = createRuntimeObservability({ db: driver, logger });
  const runtimeStateRoot = environment.runtimeRoot;
  const runtimeSupervisor = createRuntimeSupervisor({ db: driver, repos, logger, observations: runtimeObservations,
    stateRoot: runtimeStateRoot,
    ...(authorization.resolveMcpActor ? { actorFor: authorization.resolveMcpActor } : {}),
    launcher: options.runtimeLauncher ?? createHostLauncher({ stateRoot: runtimeStateRoot,
      protectedPaths: environment.protectedPaths }),
  });
  const runtimeApi = createRuntimeApi({ db: driver, repos, logger, heartbeat: config.heartbeat,
    supervisor: runtimeSupervisor, observations: runtimeObservations,
    ...(authorization.resolveHttpActor ? { resolveActor: authorization.resolveHttpActor } : {}),
  });
  const taskApi = createTaskApi({ db: driver, logger,
    ...(authorization.resolveHttpActor ? { resolveActor: authorization.resolveHttpActor } : {}) });
  const memoryApi = createMemoryApi({ db: driver, logger,
    ...(authorization.resolveHttpActor ? { resolveActor: authorization.resolveHttpActor } : {}) });
  const settingsApi = createSettingsApi({ logger,
    getSettings: () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") throw new Error("server_not_listening");
      return buildEffectiveSettings({ config, address: { host: HOST, port: address.port }, startedAt: new Date(startedAt).toISOString() });
    },
    ...(authorization.resolveHttpActor ? { resolveActor: authorization.resolveHttpActor } : {}),
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
      const report = await buildHealthReport({
        db: driver,
        heartbeat: config.heartbeat,
        startedAt,
        migrationCount: migrations.length,
        webuiBuilt,
      });
      writeJson(response, report.status === "ok" ? 200 : 503, report, request.method === "HEAD");
      return;
    }

    if (pathname.startsWith("/api/")) {
      if (await settingsApi.handle(request, response, pathname)) return;
      if (await memoryApi.handle(request, response, pathname)) return;
      if (await taskApi.handle(request, response, pathname)) return;
      if (await runtimeApi.handle(request, response, pathname)) return;
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
    ...(authorization.resolveWsActor ? { resolveActor: authorization.resolveWsActor } : {}),
  });

  // WebUI 是人的视角，实时读取所有来源的已提交消息。MCP core 与 HTTP 都发送
  // 同一提交通知，因此 Agent 的消息也可见，HTTP 消息不会重复广播。
  const unsubscribeMessages = onMessageCommit(driver, async (messageId) => {
    if (!messageId) return;
    try {
      const message = await repos.messages.get(messageId);
      if (message) hub.broadcast({ type: "message", message: await messageView(repos, message) });
    } catch (error) {
      log.warn("广播已提交消息失败", { error, messageId });
    }
  });
  notifyHttpMessage = async (message) => {
    await notifyMessageCommit(driver, message.id);
    // T8（#21）修复：人的消息经 HTTP 写入后，唤醒 HTTP 会话中在该群组等待、且被该消息
    // 路由 wake 的 agent。否则 agent 只能等 wait 超时或下次 wait 才拿到积压（定向消息不及时）。
    // MCP 的 send_message 已走 core 内部跨 core 唤醒，无需在此重复。
    try {
      const wakeGate = new Set(message.wakeMemberIds ?? []);
      mcpHandler.wakeGroup(message.groupId, wakeGate);
    } catch (error) {
      log.warn("唤醒群组等待失败", { error, groupId: message.groupId });
    }
  };

  // T4 状态看板：定期把每个项目的有效状态快照广播给可见 WebUI 客户端。
  // 客户端本地还会用心跳时间戳做平滑判定；服务端按心跳 interval 刷新即可。
  const statusRepos = createRepositories(driver);
  const statusPublisher = async (): Promise<void> => {
    const nowDate = new Date();
    const projects = await (statusRepos.projects.list()); // 活跃项目（默认出周期快照）
    const known = new Set(projects.map((p) => p.id));
    // T4（#51）：归档项目默认不进周期快照（T1 unresolved / 归档=非活跃）。
    // 仅当某 WebUI 客户端通过 presence 显式声明该归档项目时，才按需推送其快照，
    // 触发条件由前端「显示已归档」开关切换 presence 产生。
    const declared = new Set(hub.declaredProjectIds());
    for (const pid of declared) {
      if (known.has(pid)) continue;
      const archived = await (statusRepos.projects.get(pid));
      if (archived && archived.archivedAt !== null) projects.push(archived);
    }
    for (const project of projects) {
      try {
        const statuses = await (buildStatusBoard(statusRepos, project.id, {
          heartbeat: config.heartbeat,
          now: nowDate,
          humanOnlineMemberIds: hub.humanPresenceMembers(project.id),
        }));
        hub.broadcastProjectStatus(project.id, statuses);
      } catch (error) {
        log.warn("状态看板广播失败", { error, projectId: project.id });
      }
    }
  };
  const statusTimer = setInterval(statusPublisher, config.heartbeat.intervalMs);
  statusTimer.unref();

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
    await runtimeSupervisor.close();
    await mcpHandler.close();
    clearInterval(statusTimer);
    unsubscribeMessages();
    await hub.close();
    await closeMemoryRuntime(driver);
    await driver.close();
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
    database: driver.kind,
    heartbeat: config.heartbeat,
    webuiBuilt,
  });

  return {
    port,
    host: HOST,
    url,
    wsUrl: `ws://${HOST}:${port}${WS_PATH}`,
    database: driver,
    migrationState,
    runtimeSupervisor,
    broadcast: (event) => hub.broadcast(event),
    broadcastStatus: async (projectId) => {
      const statuses = await (buildStatusBoard(statusRepos, projectId, {
        heartbeat: config.heartbeat,
        now: new Date(),
        humanOnlineMemberIds: hub.humanPresenceMembers(projectId),
      }));
      hub.broadcastProjectStatus(projectId, statuses);
    },
    get clientCount() {
      return hub.clientCount;
    },
    humanPresenceCount: (projectId) => hub.humanPresenceCount(projectId),
    mcpUrl: `http://${HOST}:${port}${MCP_HTTP_PATH}`,
    get mcpSessionCount() {
      return mcpHandler.sessionCount;
    },
    get mcpPendingWaitCount() {
      return mcpHandler.pendingWaitCount;
    },
    async close() {
      clearInterval(statusTimer);
      await runtimeSupervisor.close();
      await mcpHandler.close();
      unsubscribeMessages();
      await hub.close();
      // 先在途的连接一并断开：Streamable HTTP 的 SSE 响应会持续保持连接，
      // 仅 close() 不会中断它们；closeAllConnections 让进行中的等待随连接结束。
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
      await closeMemoryRuntime(driver);
      await driver.close();
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
