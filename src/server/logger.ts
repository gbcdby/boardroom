/**
 * 结构化日志：每行一个 JSON 对象，写入可注入的 sink（默认 stdout）。
 *
 * 约束（CONFIG-05 / NFR-05）：
 * - 禁止记录密钥与完整消息正文；敏感字段按键名脱敏。
 * - 写入失败（例如 stdout 管道断开 EPIPE）不得抛错，避免日志本身拖垮进程。
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** 命中即整体替换为 [REDACTED] 的字段名（小写比较）。 */
const REDACTED_KEYS = new Set([
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "apikey",
  "api_key",
  "secret",
  "clientsecret",
  "client_secret",
  "password",
  "passwd",
  "authorization",
  "cookie",
  "set-cookie",
  "credential",
  "credentials",
  "privatekey",
  "private_key",
  "sessionkey",
  "session_key",
  // 消息正文：日志只允许记录长度/ID 等元数据。
  "content",
  "body",
  "text",
  "message_body",
  "messagebody",
  "prompt",
]);

const REDACTED = "[REDACTED]";

export type LogFields = Record<string, unknown>;

export interface LoggerOptions {
  /** 接收已序列化日志行（含结尾换行）的 sink。 */
  readonly write?: (chunk: string) => void;
  /** 最低输出级别，默认 info。 */
  readonly level?: LogLevel;
  /** 固定字段，例如 component。 */
  readonly base?: LogFields;
  /** 时钟，便于测试；默认返回当前时间。 */
  readonly now?: () => Date;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** 派生一个携带固定字段的 logger。 */
  child(base: LogFields): Logger;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const write = options.write ?? ((chunk: string) => void process.stdout.write(chunk));
  const threshold = LEVEL_WEIGHT[options.level ?? "info"];
  const base = options.base ?? {};
  const now = options.now ?? (() => new Date());

  function emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[level] < threshold) return;

    const record: Record<string, unknown> = {
      time: now().toISOString(),
      level,
      msg,
      ...redactFields(base),
      ...redactFields(fields ?? {}),
    };

    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch {
      // 循环引用或 BigInt 等：退化为只保留元信息，绝不抛错。
      line = `${JSON.stringify({
        time: record["time"],
        level,
        msg,
        logError: "fields-not-serializable",
      })}\n`;
    }

    try {
      write(line);
    } catch {
      // EPIPE / 已关闭的 sink：日志写入失败不得影响主流程。
    }
  }

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (extra) => createLogger({ ...options, base: { ...base, ...extra } }),
  };
}

/** 递归脱敏：敏感键名整体替换，其余键保留结构。 */
function redactFields(fields: LogFields): LogFields {
  const result: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED_KEYS.has(key.toLowerCase())) {
      result[key] = REDACTED;
      continue;
    }
    result[key] = redactValue(value, 0);
  }
  return result;
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: (value as NodeJS.ErrnoException).code };
  }
  if (typeof value === "object" && value !== null) {
    const nested: LogFields = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEYS.has(key.toLowerCase())) {
        nested[key] = REDACTED;
        continue;
      }
      nested[key] = redactValue(nestedValue, depth + 1);
    }
    return nested;
  }
  return value;
}
