import type { Migration } from "../../src/server/db/migrate.ts";

/**
 * 仅保留来源校验用的 #137 固定 v16 副本；生产列表使用实际 task-intake.ts 定义。
 * 来源 commit: 9cd58b9d2d464d5bc6f2921b04f723f90938620f
 * 来源文件: src/server/db/migrations/task-intake.ts
 * 原文件 SHA-256: fad7638e261065ae986dd151bdc6ce5be4e7601a4aa49674ce3eeb6bc260622c
 * up 字节与来源相同；生产已有 v16 时测试改用生产定义，并核对本 fixture。
 */
export const policyCompatibilityV16: Migration = {
  version: 16,
  name: "task_intake_materials",
  up: `
    ALTER TABLE tasks ADD COLUMN delivery_kind TEXT
      CHECK (delivery_kind IS NULL OR delivery_kind IN ('code', 'artifact', 'finding'));
    ALTER TABLE tasks ADD COLUMN acceptance_text TEXT NOT NULL DEFAULT '';
    ALTER TABLE tasks ADD COLUMN acceptance_source TEXT NOT NULL DEFAULT 'explicit'
      CHECK (acceptance_source IN ('explicit', 'legacy_task_body'));
    UPDATE tasks SET delivery_kind = 'code', acceptance_text = body, acceptance_source = 'legacy_task_body';
  `,
};
