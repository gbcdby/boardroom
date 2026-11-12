/**
 * 持久化层错误类型。
 *
 * 设计目标（NFR-09）：写入失败必须向调用方返回明确、可区分的错误，
 * 而不是静默丢弃数据。repository 层把 SQLite 的底层错误归一到这些类型。
 */

/** 持久化层所有业务错误的基类；code 供上层分支处理。 */
export class RepositoryError extends Error {
  override readonly name: string = "RepositoryError";
  readonly code: RepositoryErrorCode;

  constructor(code: RepositoryErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
  }
}

export type RepositoryErrorCode =
  | "not_found"
  | "conflict"
  | "invalid_reference"
  | "invalid_argument"
  | "write_failed"
  | "mutation_scope_changed"
  | "confirmation_changed"
  | "member_removed"
  | "compensation_conflict"
  | "legacy_incomplete_snapshot"
  | "migration_identity_ambiguous"
  | "chain_broken"
  | "audit_snapshot_too_large"
  | "audit_capture_budget_exceeded"
  /** 目标项目/群组处于归档态：写路径拒绝，恢复后放行（#48 PROJECT-03 / GROUP-04）。 */
  | "archived";

/** 目标实体不存在。 */
export class NotFoundError extends RepositoryError {
  override readonly name = "NotFoundError";
  constructor(message: string, cause?: unknown) {
    super("not_found", message, cause);
  }
}

/** 唯一约束冲突（重复 ID、每项目重复 manager、投递重复等）。 */
export class ConflictError extends RepositoryError {
  override readonly name = "ConflictError";
  constructor(message: string, cause?: unknown) {
    super("conflict", message, cause);
  }
}

/** 引用了不存在的实体或跨项目/跨群组引用。 */
export class InvalidReferenceError extends RepositoryError {
  override readonly name = "InvalidReferenceError";
  constructor(message: string, cause?: unknown) {
    super("invalid_reference", message, cause);
  }
}

/** 入参不合法（语义校验失败）。 */
export class InvalidArgumentError extends RepositoryError {
  override readonly name = "InvalidArgumentError";
  constructor(message: string, cause?: unknown) {
    super("invalid_argument", message, cause);
  }
}

/** 底层写入失败（磁盘满、只读、I/O 错误等），且已回滚。 */
export class WriteFailedError extends RepositoryError {
  override readonly name = "WriteFailedError";
  constructor(message: string, cause?: unknown) {
    super("write_failed", message, cause);
  }
}

/**
 * 目标处于归档态，写入被拒（#48 T1）。
 *
 * 归档是**可恢复**的非活跃态：这里只拒绝新写入并给出恢复指引，不删任何数据；
 * 永久删除走 `purge`（人二次确认），与本错误无关。
 */
export class ArchivedError extends RepositoryError {
  override readonly name = "ArchivedError";
  constructor(message: string, cause?: unknown) {
    super("archived", message, cause);
  }
}
