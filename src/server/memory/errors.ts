import { RepositoryError, type RepositoryErrorCode } from "../db/errors.ts";

/** 领域错误跨仓储事务保留稳定 code/reason；不携带记忆正文。 */
export class MemoryError extends RepositoryError {
  override readonly name = "MemoryError";
  readonly reason: string;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(reason: string, message: string, code: RepositoryErrorCode = "invalid_argument", details: Readonly<Record<string, unknown>> = {}) {
    super(code, message); this.reason = reason; this.details = details;
  }
}
