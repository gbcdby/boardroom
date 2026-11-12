import { RepositoryError } from "../db/errors.ts";

/** 字段错误可以保持编辑草稿；不把底层路径或 Git stderr 拼成不可消费的泛化错误。 */
export class WorkspaceError extends RepositoryError {
  override readonly name = "WorkspaceError";
  readonly reason: string;
  readonly field: string | null;
  constructor(reason: string, message: string, field: string | null = "rootPath", conflict = false) {
    super(reason === "workspace_changed" ? "workspace_changed" : conflict ? "conflict" : "invalid_argument", message);
    this.reason = reason; this.field = field;
  }
}
