/** 可对外呈现的配置/存储预检错误；message 不携带配置原文或数据库凭据。 */
export type ConfigErrorCode = "config_invalid" | "legacy_migration_required" | "storage_source_ambiguous"
  | "storage_root_mismatch" | "storage_maintenance" | "migration_incomplete" | "storage_source_changed";

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  readonly code: ConfigErrorCode;
  readonly recoveryAction: string;

  constructor(message: string, code: ConfigErrorCode = "config_invalid",
    recoveryAction = "检查配置与路径权限后重试；使用 inspect-storage 查看已知数据源。") {
    super(message);
    this.code = code;
    this.recoveryAction = recoveryAction;
  }
}
