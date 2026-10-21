import { readFile } from "node:fs/promises";
import path from "node:path";

/** 默认监听端口；仅绑定 127.0.0.1。 */
export const DEFAULT_PORT = 4317;
/** 默认数据目录（相对仓库根 / 进程 cwd）。 */
export const DEFAULT_DATA_DIR = "data";
/** D4：心跳间隔默认 10s。 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
/** D4：心跳超时默认 30s。 */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;

/** 默认只读的配置文件路径（相对 cwd）。 */
export const DEFAULT_CONFIG_FILE = "config.json";

export interface HeartbeatConfig {
  /** 心跳发送间隔，毫秒。 */
  readonly intervalMs: number;
  /** 超过该时长未收到心跳即判定断线，毫秒。 */
  readonly timeoutMs: number;
}

export interface AppConfig {
  /** HTTP + WebSocket 监听端口。 */
  readonly port: number;
  /** 绝对路径；运行时数据（SQLite 文件、日志）所在目录。 */
  readonly dataDir: string;
  /** 心跳配置。 */
  readonly heartbeat: HeartbeatConfig;
  /** 实际加载的配置文件绝对路径；没有配置文件时为 null。 */
  readonly configFile: string | null;
}

/** 配置加载失败；message 面向用户，包含可恢复路径所需的上下文。 */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export interface LoadConfigOptions {
  /** 解析相对路径的基准目录，默认 process.cwd()。 */
  readonly cwd?: string;
  /** 环境变量来源，默认 process.env。 */
  readonly env?: Record<string, string | undefined>;
}

type JsonObject = Record<string, unknown>;

/**
 * 按「默认值 → 配置文件 → 环境变量」的优先级加载配置。
 *
 * 配置文件位置：`$AGENT_STUDIO_CONFIG`，否则 `<cwd>/config.json`（不存在则跳过）。
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<AppConfig> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  const explicitConfig = env["AGENT_STUDIO_CONFIG"];
  const configFile = explicitConfig ? path.resolve(cwd, explicitConfig) : path.join(cwd, DEFAULT_CONFIG_FILE);
  const loadedFile = await readConfigFile(configFile, explicitConfig !== undefined);
  const fileValues = loadedFile ?? {};

  const port = parsePort(pick(env["AGENT_STUDIO_PORT"], fileValues["port"], DEFAULT_PORT));
  const dataDir = resolveDataDir(cwd, pick(env["AGENT_STUDIO_DATA_DIR"], fileValues["dataDir"], DEFAULT_DATA_DIR));

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

  return {
    port,
    dataDir,
    heartbeat: { intervalMs, timeoutMs },
    configFile: loadedFile === null ? null : configFile,
  };
}

async function readConfigFile(configFile: string, required: boolean): Promise<JsonObject | null> {
  let raw: string;
  try {
    raw = await readFile(configFile, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && !required) return null;
    throw new ConfigError(
      `无法读取配置文件 ${configFile}（${code ?? "unknown"}）。` +
        `请检查 AGENT_STUDIO_CONFIG 指向的路径是否存在且可读，或删除该环境变量以使用默认值。`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(
      `配置文件 ${configFile} 不是合法 JSON：${(error as Error).message}。` +
        `请修正 JSON 语法，或参考 config.example.json。`,
    );
  }

  if (!isObject(parsed)) {
    throw new ConfigError(`配置文件 ${configFile} 的顶层必须是 JSON 对象。`);
  }
  return parsed;
}

function pick(...candidates: readonly unknown[]): unknown {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && candidate !== "") return candidate;
  }
  return undefined;
}

function resolveDataDir(cwd: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`dataDir 必须是非空字符串，收到：${JSON.stringify(value)}。`);
  }
  return path.resolve(cwd, value);
}

function parsePort(value: unknown): number {
  const port = parsePositiveInt("port", value);
  if (port > 65_535) {
    throw new ConfigError(
      `port 必须介于 1 和 65535 之间，收到：${String(value)}。` +
        `请修改 AGENT_STUDIO_PORT 或配置文件中的 port 字段。`,
    );
  }
  return port;
}

function parsePositiveInt(field: string, value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${field} 必须是正整数，收到：${JSON.stringify(value)}。`);
  }
  return parsed;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
