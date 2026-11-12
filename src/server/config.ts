import path from "node:path";
import type { MemoryConfig } from "../shared/memory.ts";
import type { ResolvedBoardroomEnvironment } from "./environment.ts";
import { ConfigError } from "./config-error.ts";
export { ConfigError } from "./config-error.ts";

/** 默认监听端口；仅绑定 127.0.0.1。 */
export const DEFAULT_PORT = 4317;
/** 默认数据目录（相对仓库根 / 进程 cwd）。 */
export const DEFAULT_DATA_DIR = "data";
/** D4：心跳间隔默认 10s。 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
/** D4：心跳超时默认 30s。 */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
/** T7 / D5：每群组连续自动回复默认上限 6。 */
export const DEFAULT_MAX_CONSECUTIVE_AUTO_REPLIES = 6;
/** T7 / D5：每成员滚动 1 分钟默认最多被唤醒 20 次。 */
export const DEFAULT_MAX_WAKES_PER_MINUTE_PER_MEMBER = 20;

/** 配置文件名；统一 resolver 选择 homeRoot 或兼容旧 cwd。 */
export const DEFAULT_CONFIG_FILE = "config.json";

/** 持久化驱动种类（F1 #46）；与连接工厂的 DbDriver.kind 对应。 */
export type DbDriverKind = "sqlite" | "postgres";

/** F1 #46：默认持久化驱动。阶段 1 行为保持 SQLite，PG 需显式配置。 */
export const DEFAULT_DB_DRIVER: DbDriverKind = "sqlite";

/** 阶段 4 有效缺省；旧的手工 AppConfig 由 resolveMemoryConfig 补齐。 */
export const DEFAULT_MEMORY_CONFIG: Readonly<MemoryConfig> = Object.freeze({
  messageThreshold: 50, maxDocumentBytes: 32768, maxInjectedBytes: 8192,
  summaryInputBytes: 65536, summaryAttemptTimeoutMs: 900000,
});
const MEMORY_LIMITS: Readonly<Record<keyof MemoryConfig, readonly [number, number]>> = {
  messageThreshold: [1, 10000], maxDocumentBytes: [1024, 1048576], maxInjectedBytes: [512, 65536],
  summaryInputBytes: [1024, 262144], summaryAttemptTimeoutMs: [30000, 3600000],
};
export function resolveMemoryConfig(value: Partial<MemoryConfig> = {}): MemoryConfig {
  if (!isObject(value)) throw new ConfigError("memory 必须是配置对象。");
  const result = { ...DEFAULT_MEMORY_CONFIG };
  for (const key of Object.keys(MEMORY_LIMITS) as (keyof MemoryConfig)[]) {
    const number = value[key] === undefined ? result[key] : value[key];
    const [min, max] = MEMORY_LIMITS[key];
    if (typeof number !== "number" || !Number.isInteger(number) || number < min || number > max) {
      throw new ConfigError(`memory.${key} 必须是 ${min}～${max} 的整数。`);
    }
    result[key] = number;
  }
  return result;
}

export interface HeartbeatConfig {
  /** 心跳发送间隔，毫秒。 */
  readonly intervalMs: number;
  /** 超过该时长未收到心跳即判定断线，毫秒。 */
  readonly timeoutMs: number;
}

/** T7 防环/限流配置（D5）。 */
export interface AntiLoopConfig {
  /** 每群组连续自动回复上限（达到后停止自动唤醒其他 agent）。 */
  readonly maxConsecutiveAutoReplies: number;
  /** 每成员滚动 1 分钟最多被唤醒次数（跨群累计）。 */
  readonly maxWakesPerMinutePerMember: number;
}

export interface AppConfig {
  /** HTTP + WebSocket 监听端口。 */
  readonly port: number;
  /** 绝对路径；运行时数据（SQLite 文件、日志）所在目录。 */
  readonly dataDir: string;
  /** 心跳配置。 */
  readonly heartbeat: HeartbeatConfig;
  /** T7 防环/限流配置（D5）；缺省时使用 D5 默认值。 */
  readonly antiLoop?: AntiLoopConfig;
  /** 启动时解析的记忆限额；缺省兼容旧调用方。 */
  readonly memory?: MemoryConfig;
  /**
   * 持久化驱动（F1 #46）。默认 `sqlite`，阶段 1 行为不变；
   * 可切 `postgres`——驱动层已接入，但业务仓储在 M1（#54）迁移前仅支持 SQLite。
   * 可选以兼容既有手工构造的配置对象；缺省即 {@link DEFAULT_DB_DRIVER}。
   */
  readonly dbDriver?: DbDriverKind;
  /** PostgreSQL 连接串；仅当 dbDriver=postgres 时必须配置。 */
  readonly pgConnectionString?: string;
  /** 实际加载的配置文件绝对路径；没有配置文件时为 null。 */
  readonly configFile: string | null;
  /** 受信启动装配的唯一路径结果；手工 AppConfig 仍可省略。勿将整个对象写入日志。 */
  readonly environment?: ResolvedBoardroomEnvironment;
}

export interface LoadConfigOptions {
  /** 解析相对路径的基准目录，默认 process.cwd()。 */
  readonly cwd?: string;
  /** 环境变量来源，默认 process.env。 */
  readonly env?: Record<string, string | undefined>;
  /** 仅受信装配提供的系统用户目录/已知旧启动目录，不是 HTTP/MCP 参数。 */
  readonly homeDir?: string;
  readonly knownLegacyCwds?: readonly string[];
}

type JsonObject = Record<string, unknown>;

/**
 * 兼容入口；文件、路径、数据库选择全部委托给统一 resolver。
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<AppConfig> {
  const { resolveBoardroomEnvironment, assertEnvironmentWritable } = await import("./environment.ts");
  const environment = await resolveBoardroomEnvironment(options);
  await assertEnvironmentWritable(environment);
  return { ...environment.config, environment };
}

/** 纯配置字段解析；路径规则和文件读取只由 environment.ts 决定。 */
export function parseConfigValues(input: {
  cwd: string; env: Record<string, string | undefined>; fileValues: JsonObject;
  configFile: string | null; filePathBase: string; defaultDataDir: string;
}): AppConfig {
  const { cwd, env, fileValues, configFile } = input;
  const port = parsePort(pick(env["AGENT_STUDIO_PORT"], fileValues["port"], DEFAULT_PORT));
  const fromEnv = env["AGENT_STUDIO_DATA_DIR"];
  const dataDir = resolveDataDir(fromEnv !== undefined ? cwd : input.filePathBase,
    pick(fromEnv, fileValues["dataDir"], input.defaultDataDir));

  const fileHeartbeat = isObject(fileValues["heartbeat"]) ? fileValues["heartbeat"] : {};
  const intervalMs = parsePositiveInt(
    "heartbeat.intervalMs",
    pick(env["AGENT_STUDIO_HEARTBEAT_INTERVAL_MS"], fileHeartbeat["intervalMs"], DEFAULT_HEARTBEAT_INTERVAL_MS),
  );
  const timeoutMs = parsePositiveInt(
    "heartbeat.timeoutMs",
    pick(env["AGENT_STUDIO_HEARTBEAT_TIMEOUT_MS"], fileHeartbeat["timeoutMs"], DEFAULT_HEARTBEAT_TIMEOUT_MS),
  );

  if (timeoutMs <= intervalMs) {
    throw new ConfigError(
      `heartbeat.timeoutMs (${timeoutMs}) 必须大于 heartbeat.intervalMs (${intervalMs})；` +
        `否则每个心跳周期都会判定超时。请调整 AGENT_STUDIO_HEARTBEAT_TIMEOUT_MS 或配置文件中的 heartbeat 字段。`,
    );
  }

  const fileAntiLoop = isObject(fileValues["antiLoop"]) ? fileValues["antiLoop"] : {};
  const maxConsecutiveAutoReplies = parsePositiveInt(
    "antiLoop.maxConsecutiveAutoReplies",
    pick(
      env["AGENT_STUDIO_MAX_CONSECUTIVE_AUTO_REPLIES"],
      fileAntiLoop["maxConsecutiveAutoReplies"],
      DEFAULT_MAX_CONSECUTIVE_AUTO_REPLIES,
    ),
  );
  const maxWakesPerMinutePerMember = parsePositiveInt(
    "antiLoop.maxWakesPerMinutePerMember",
    pick(
      env["AGENT_STUDIO_MAX_WAKES_PER_MINUTE_PER_MEMBER"],
      fileAntiLoop["maxWakesPerMinutePerMember"],
      DEFAULT_MAX_WAKES_PER_MINUTE_PER_MEMBER,
    ),
  );

  const dbDriver = parseDbDriver(pick(env["AGENT_STUDIO_DB_DRIVER"], fileValues["dbDriver"], DEFAULT_DB_DRIVER));
  const pgConnectionString = parsePgConnectionString(
    pick(env["AGENT_STUDIO_PG_CONNECTION_STRING"], fileValues["pgConnectionString"]),
    dbDriver,
  );

  if (fileValues["memory"] !== undefined && !isObject(fileValues["memory"])) throw new ConfigError("memory 必须是配置对象。");
  const memoryValues = isObject(fileValues["memory"]) ? fileValues["memory"] : {};
  const memoryOverrides: Partial<MemoryConfig> = {};
  const memoryEnv: Record<keyof MemoryConfig, string> = {
    messageThreshold: "AGENT_STUDIO_MEMORY_MESSAGE_THRESHOLD", maxDocumentBytes: "AGENT_STUDIO_MEMORY_MAX_DOCUMENT_BYTES",
    maxInjectedBytes: "AGENT_STUDIO_MEMORY_MAX_INJECTED_BYTES", summaryInputBytes: "AGENT_STUDIO_MEMORY_SUMMARY_INPUT_BYTES",
    summaryAttemptTimeoutMs: "AGENT_STUDIO_MEMORY_SUMMARY_ATTEMPT_TIMEOUT_MS",
  };
  for (const key of Object.keys(memoryEnv) as (keyof MemoryConfig)[]) {
    const fromEnv = env[memoryEnv[key]];
    const value = fromEnv !== undefined ? Number(fromEnv) : memoryValues[key];
    if (value !== undefined) {
      if (typeof value !== "number") throw new ConfigError(`memory.${key} 必须是整数。`);
      memoryOverrides[key] = value;
    }
  }
  const memory = resolveMemoryConfig(memoryOverrides);

  return {
    port,
    dataDir,
    heartbeat: { intervalMs, timeoutMs },
    antiLoop: { maxConsecutiveAutoReplies, maxWakesPerMinutePerMember },
    memory,
    dbDriver,
    ...(pgConnectionString === undefined ? {} : { pgConnectionString }),
    configFile,
  };
}

/** F1 #46：dbDriver 只接受 sqlite / postgres；其余值报错并给出恢复路径。 */
function parseDbDriver(value: unknown): DbDriverKind {
  if (value === "sqlite" || value === "postgres") return value;
  throw new ConfigError(
    `dbDriver 必须是 "sqlite" 或 "postgres"。` +
      `请修改 AGENT_STUDIO_DB_DRIVER 或配置文件中的 dbDriver 字段。`,
  );
}

/**
 * F1 #46：PG 连接串校验。
 *
 * - dbDriver=postgres 时必须配置非空连接串，否则报错（启动失败快于运行期失败）。
 * - dbDriver=sqlite 时允许保留连接串（便于切换），原样返回。
 */
function parsePgConnectionString(value: unknown, dbDriver: DbDriverKind): string | undefined {
  if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
    throw new ConfigError(
      `pgConnectionString 必须是非空字符串。` +
        `请修改 AGENT_STUDIO_PG_CONNECTION_STRING 或配置文件中的 pgConnectionString 字段。`,
    );
  }
  const connectionString = typeof value === "string" ? value.trim() : undefined;
  if (dbDriver === "postgres" && connectionString === undefined) {
    throw new ConfigError(
      `dbDriver=postgres 但缺少 PG 连接串。` +
        `请设置 AGENT_STUDIO_PG_CONNECTION_STRING=postgres://user:password@host:port/database` +
        `（或配置文件中的 pgConnectionString 字段）；如需继续使用本地 SQLite，请保持 dbDriver=sqlite。`,
    );
  }
  return connectionString;
}

function pick(...candidates: readonly unknown[]): unknown {
  for (const candidate of candidates) {
    // 显式空值也是配置值，由字段校验拒绝；不能变成另一个数据源的隐式 fallback。
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function resolveDataDir(cwd: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError("dataDir 必须是非空字符串。请修改 AGENT_STUDIO_DATA_DIR 或配置文件中的 dataDir 字段。");
  }
  return path.resolve(cwd, value);
}

function parsePort(value: unknown): number {
  const port = parsePositiveInt("port", value);
  if (port > 65_535) {
    throw new ConfigError(
      `port 必须介于 1 和 65535 之间，收到：${port}。` +
        `请修改 AGENT_STUDIO_PORT 或配置文件中的 port 字段。`,
    );
  }
  return port;
}

function parsePositiveInt(field: string, value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${field} 必须是正整数。请修改相应环境变量或配置字段。`);
  }
  return parsed;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
