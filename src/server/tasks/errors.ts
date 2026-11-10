import { RepositoryError, type RepositoryErrorCode } from "../db/errors.ts";

/** 领域原因与持久化通用错误码分开，HTTP/MCP 可稳定展示 reason。 */
export class TaskError extends RepositoryError {
  override readonly name = "TaskError";
  readonly reason: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(reason: string, message: string, code: RepositoryErrorCode = "invalid_argument", details: Readonly<Record<string, unknown>> = {}) {
    super(code, message);
    this.reason = reason;
    this.details = details;
  }
}
