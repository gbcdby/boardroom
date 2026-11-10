import { StringDecoder } from "node:string_decoder";
import type { HostEvent, ManagedBackend, ObservedPermissionMode, VerifiedUsageSchema } from "./types.ts";

export const MAX_HOST_LINE_BYTES = 64 * 1024;
const MODES = new Set<ObservedPermissionMode>(["auto", "bypassPermissions", "manual", "dontAsk", "plan", "acceptEdits"]);

export interface HostParserOptions {
  readonly backend: ManagedBackend;
  readonly version: string;
  readonly expectedPermissionMode: string;
  readonly onEvent: (event: HostEvent) => void;
  /** 必须由可信版本证据表提供，不能来自 CLI 原始事件。 */
  readonly usageSchema?: VerifiedUsageSchema;
}

/** 有界 JSONL。超长行整行丢弃到下一换行，绝不解析其尾部或输出原文。 */
export function createHostOutputParser(options: HostParserOptions) {
  let bytes = 0;
  let fragments: Buffer[] = [];
  let discarding = false;
  let ended = false;
  const emit = (event: HostEvent) => options.onEvent(event);

  function line(data: Buffer): void {
    if (data.length === 0) return;
    let value: unknown;
    try { value = JSON.parse(new StringDecoder("utf8").write(data)); }
    catch { emit({ type: "protocol_invalid", reason: "invalid_json" }); return; }
    if (!isObject(value)) { emit({ type: "protocol_invalid", reason: "invalid_schema" }); return; }
    if (options.backend !== "claude-code") {
      // 其他宿主尚未有托管 schema 证据。只提取已知 session 通知供诊断，不能宣布 ready。
      if (options.backend === "codex-cli" && value.type === "thread.started" && validId(value.thread_id)) {
        emit({ type: "session", sessionId: value.thread_id });
      }
      return;
    }
    if (value.type === "system" && value.subtype === "init") {
      if (validId(value.session_id)) emit({ type: "session", sessionId: value.session_id });
      const mode = typeof value.permissionMode === "string" && MODES.has(value.permissionMode as ObservedPermissionMode)
        ? value.permissionMode as ObservedPermissionMode : "unknown";
      const status = mode === "unknown" ? "unknown" : mode === options.expectedPermissionMode ? "observed" : "fallback";
      emit({ type: "permission", mode, status });
      if (status === "observed") emit({ type: "ready", permissionMode: mode });
      return;
    }
    // Claude 的认证失败是 assistant 顶层枚举，末尾 result 仍可能为 success + is_error。
    // 只接受已确认字段；不从正文、stderr 或任意 nested key 猜错误原因。
    if (value.type === "assistant" && value.error === "authentication_failed") {
      emit({ type: "failure", reason: "login_required" });
      return;
    }
    // 不从 assistant/user 正文或任意 nested key 猜权限、会话或成本。
    if (value.type !== "result") return;
    if (validId(value.session_id)) emit({ type: "session", sessionId: value.session_id });
    if (Array.isArray(value.permission_denials) && value.permission_denials.length > 0) {
      emit({ type: "permission_denied", reason: "permission_required" });
    }
    if (options.usageSchema?.format !== "claude-result-v1" || !isObject(value.usage)
      || !Number.isSafeInteger(value.num_turns) || (value.num_turns as number) < 0) {
      emit({ type: "usage_unavailable" }); return;
    }
    const metrics: Partial<Record<"inputTokens" | "cachedInputTokens" | "outputTokens" | "costUsd", number>> = {};
    for (const [field, source] of [["inputTokens", "input_tokens"], ["cachedInputTokens", "cache_read_input_tokens"], ["outputTokens", "output_tokens"]] as const) {
      const n = value.usage[source];
      if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) metrics[field] = n;
    }
    if (typeof value.total_cost_usd === "number" && Number.isFinite(value.total_cost_usd) && value.total_cost_usd >= 0) metrics.costUsd = value.total_cost_usd;
    let emitted = false;
    for (const metric of ["inputTokens", "cachedInputTokens", "outputTokens", "costUsd"] as const) {
      const semantics = options.usageSchema.metrics[metric];
      const n = metrics[metric];
      if (!semantics || n === undefined) continue;
      emit({ type: "usage", source: options.backend, harnessVersion: options.version, scope: semantics.scope,
        sequence: value.num_turns as number, metric, value: n, cumulative: semantics.cumulative,
        zeroMeaningful: semantics.zeroMeaningful, successful: value.is_error === false && value.subtype === "success",
        coverage: "partial", schemaVerified: true });
      emitted = true;
    }
    if (!emitted) emit({ type: "usage_unavailable" });
  }

  function push(chunk: Buffer | string): void {
    if (ended) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let from = 0;
    for (let i = 0; i <= buffer.length; i++) {
      if (i < buffer.length && buffer[i] !== 10) continue;
      const part = buffer.subarray(from, i);
      if (!discarding) {
        bytes += part.length;
        if (bytes > MAX_HOST_LINE_BYTES) {
          fragments = []; discarding = true;
          emit({ type: "protocol_invalid", reason: "line_too_large" });
        } else if (part.length) fragments.push(Buffer.from(part));
      }
      if (i < buffer.length) {
        if (!discarding) line(Buffer.concat(fragments, bytes));
        fragments = []; bytes = 0; discarding = false;
      }
      from = i + 1;
    }
  }

  return { push, end() { if (ended) return; ended = true; if (!discarding && bytes) line(Buffer.concat(fragments, bytes)); fragments = []; bytes = 0; } };
}

function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/.test(value); }
