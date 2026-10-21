import type { Migration } from "../migrate.ts";

/**
 * 生产迁移列表。
 *
 * F1（#11）只建立迁移版本表 `schema_migrations`，不建领域表：
 * 项目/群组/消息/成员等表结构属于 F2（#12）。新增迁移时在此追加，
 * 版本号递增且一旦应用就不可修改（runner 会校验 checksum）。
 */
export const migrations: readonly Migration[] = [];
