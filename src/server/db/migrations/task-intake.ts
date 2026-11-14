import type { Migration } from "../migrate.ts";

/** #137：录入资料与代码兼容来源；不改变旧任务状态、修订或评审历史。 */
export const taskIntakeMigration: Migration = {
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
