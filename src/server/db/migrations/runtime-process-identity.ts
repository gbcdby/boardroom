import type { Migration } from "../migrate.ts";

/** 只保存受信 launcher 的内核身份，不从 PID 推断所有权，不读取 argv/env。 */
export const runtimeProcessIdentityMigration: Migration = {
  version: 10,
  name: "managed_runtime_process_identity",
  up: `ALTER TABLE agent_runner_states ADD COLUMN process_identity_json TEXT;`,
};
