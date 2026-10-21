/**
 * MCP 工具级错误码与错误类型。
 *
 * 契约见 docs/mcp-tool-contract.md §2.2。错误码是稳定字符串，供宿主和后续票判断。
 * 业务错误以 {@link McpToolError} 表达，在工具处理边界转换为结构化载荷。
 */

export const MCP_ERROR_CODES = [
  "INVALID_ARGUMENT",
  "NOT_IN_GROUP",
  "FORBIDDEN",
  "TIMEOUT",
  "RATE_LIMITED",
  "CONFLICT",
  "INTERNAL",
] as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

export interface McpErrorPayload {
  readonly code: McpErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

/** 业务错误：在工具处理函数内抛出，由 server 层统一转换为 `{ ok:false, error }`。 */
export class McpToolError extends Error {
  override readonly name = "McpToolError";
  readonly code: McpErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: McpErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }

  toPayload(): McpErrorPayload {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

/** 便捷构造：参数无效。 */
export function invalidArgument(message: string, details?: Record<string, unknown>): McpToolError {
  return new McpToolError("INVALID_ARGUMENT", message, details);
}

/** 便捷构造：未入群。 */
export function notInGroup(message = "尚未入群：请先调用 join"): McpToolError {
  return new McpToolError("NOT_IN_GROUP", message);
}
