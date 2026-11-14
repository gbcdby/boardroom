/**
 * #59 / #152：历史 other→dsh 的公开按需入口。
 * 原生连接、lease 与已接纳事务内的算法同属私有模块，避免公开 raw handle 或通用 SQL 回调。
 */
export {
  migrateOtherToDsh,
  HostTypeMigrationCollisionError,
  type MigrationReport,
} from "../storage/native-management-admission.ts";
