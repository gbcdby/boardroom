/**
 * 结构化日志：每行一个 JSON 对象，写入可注入的 sink（默认 stdout）。
 *
 * 约束（CONFIG-05 / NFR-05）：
 * - 禁止记录密钥与完整消息正文；敏感字段按键名脱敏。
 * - msg 应是固定事件说明；原始 CLI 输出、参数和环境只允许放入会整体遮蔽的字段。
 *   自由文本仅对明确的凭据语法兜底，不能识别任意自然语言中的秘密。
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

/** 凭据字段以规范化名称/后缀匹配，覆盖 provider 前缀及 snake/kebab/camel case。 */
const CREDENTIAL_SUFFIXES = [
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
  "connectionstring",
  "databaseurl",
].map(normalizeKey);

/** 原始内容容器整体遮蔽；保留 runtimeId、exitCode、inputTokens 等诊断元数据。 */
const REDACTED_KEYS = new Set([
  // 消息正文：日志只允许记录长度/ID 等元数据。
  "content",
  "body",
  "text",
  "message_body",
  "messagebody",
  "prompt",
  "systemprompt",
  "env",
  "environment",
  "argv",
  "args",
  "command",
  "stdout",
  "stderr",
  "stdio",
  "output",
  "rawoutput",
].map(normalizeKey));

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
    const safeMsg = redactDiagnosticText(msg);

    const record: Record<string, unknown> = {
      time: now().toISOString(),
      level,
      msg: safeMsg,
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
        msg: safeMsg,
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
    if (isSensitiveKey(key)) {
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
    return {
      name: redactDiagnosticText(value.name),
      message: redactDiagnosticText(value.message),
      code: redactValue((value as NodeJS.ErrnoException).code, depth + 1),
    };
  }
  if (typeof value === "object" && value !== null) {
    const nested: LogFields = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        nested[key] = REDACTED;
        continue;
      }
      nested[key] = redactValue(nestedValue, depth + 1);
    }
    return nested;
  }
  return typeof value === "string" ? redactDiagnosticText(value) : value;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isCredentialKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return CREDENTIAL_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function isSensitiveKey(key: string): boolean {
  return REDACTED_KEYS.has(normalizeKey(key)) || isCredentialKey(key);
}

/**
 * 诊断兜底：PG DSN 整体移除（包括 query 中的凭据），其他 URL 隐去 userinfo；
 * 已命名的 key=value / JSON / CLI 凭据和认证头遮蔽，保留其余错误及恢复信息。
 * 这不是任意 CLI 文本的安全化接口：不应把 stdout/stderr 拼进 msg 或 Error.message。
 */
function redactDiagnosticText(text: string): string {
  const safeText = text
    .replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, REDACTED)
    // 从固定分隔符开始，避免长 scheme 候选在每个字母/标点处重新扫描。
    .replace(/(:\/\/)[^\s/@]+@/g, `$1${REDACTED}@`)
    .replace(/\b(Bearer|Basic)\s+[a-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`);
  // 只从完整 token 的起点尝试；允许前导数字/标点，避免漏掉旧扫描能识别的凭据后缀。
  const assignments = redactNamedValues(safeText, /(["']?)(?<![a-z0-9_.-])([a-z0-9_.-]+)\1\s*[:=]\s*/gi, 2);
  return redactNamedValues(
    assignments,
    /(?<![a-z0-9-])([a-z0-9-]+)\s+/gi,
    1,
    // 完整 token 可能带前缀或额外横线；其中出现 CLI flag 且凭据后缀匹配才遮蔽值。
    (key) => /--[a-z]/i.test(key) && isCredentialKey(key),
  );
}

/**
 * 先扫描键；仅命中敏感键才跳过它的值。不能消费非敏感外层的整个值，
 * 否则 runtime={"password":"..."} 或 --verbose --token ... 会漏掉内层凭据。
 */
function redactNamedValues(
  text: string,
  names: RegExp,
  keyIndex: number,
  isCredentialName: (key: string) => boolean = isCredentialKey,
): string {
  let result = "";
  let copiedUntil = 0;
  for (let match = names.exec(text); match !== null; match = names.exec(text)) {
    if (!isCredentialName(match[keyIndex]!)) continue;
    const valueStart = names.lastIndex;
    const valueEnd = diagnosticValueEnd(text, valueStart);
    if (valueEnd === valueStart) continue;
    result += text.slice(copiedUntil, valueStart) + REDACTED;
    copiedUntil = valueEnd;
    names.lastIndex = valueEnd;
  }
  return result + text.slice(copiedUntil);
}

/** 敏感值可为带空格的引号串或嵌套 JSON 容器；不完整的敏感值保守遮蔽到末尾。 */
function diagnosticValueEnd(text: string, start: number): number {
  const first = text[start];
  if (first === '"' || first === "'") {
    for (let index = start + 1; index < text.length; index++) {
      if (text[index] === "\\") index++;
      else if (text[index] === first) return index + 1;
    }
    return text.length;
  }
  if (first === "{" || first === "[") {
    const closing = [first === "{" ? "}" : "]"];
    let quote: string | null = null;
    for (let index = start + 1; index < text.length; index++) {
      const char = text[index]!;
      if (quote !== null) {
        if (char === "\\") index++;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === "{" || char === "[") {
        closing.push(char === "{" ? "}" : "]");
      } else if (char === "}" || char === "]") {
        if (closing.pop() !== char) return text.length;
        if (closing.length === 0) return index + 1;
      }
    }
    return text.length;
  }
  let end = start;
  while (end < text.length && !/[\s,;}\]]/.test(text[end]!)) end++;
  return end;
}
