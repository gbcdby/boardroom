import type { Migration } from "../migrate.ts";

/** #152 / r3：v18 由总控登记。phase 只由耐久 journal 拥有。
 * guards 在同一迁移事务中按实际 catalog 安装；后续追加 schema 也沿用此协议。
 */
const tables = `
CREATE TABLE storage_maintenance (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  database_instance_id TEXT NOT NULL UNIQUE,
  control_root_json TEXT,
  mutex_identity_json TEXT,
  fence_epoch BIGINT NOT NULL DEFAULT 0 CHECK (fence_epoch >= 0),
  admission TEXT NOT NULL DEFAULT 'open' CHECK (admission IN ('open','draining','sealed')),
  active_migration_id TEXT,
  plan_digest TEXT,
  owner_generation BIGINT NOT NULL DEFAULT 0 CHECK (owner_generation >= 0),
  journal_record_ref TEXT,
  journal_digest TEXT,
  journal_sequence BIGINT NOT NULL DEFAULT 0 CHECK (journal_sequence >= 0),
  protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
  guard_manifest_digest TEXT NOT NULL CHECK (length(guard_manifest_digest) = 64),
  CHECK ((admission = 'open' AND active_migration_id IS NULL AND plan_digest IS NULL)
    OR (admission IN ('draining','sealed') AND active_migration_id IS NOT NULL AND plan_digest IS NOT NULL
      AND control_root_json IS NOT NULL AND mutex_identity_json IS NOT NULL
      AND journal_record_ref IS NOT NULL AND journal_digest IS NOT NULL AND journal_sequence > 0)),
  CHECK ((journal_sequence = 0 AND journal_record_ref IS NULL AND journal_digest IS NULL)
    OR (journal_sequence > 0 AND journal_record_ref IS NOT NULL AND journal_digest IS NOT NULL AND length(journal_digest)=64)),
  CHECK (plan_digest IS NULL OR length(plan_digest)=64)
);
CREATE TABLE storage_source_clients (
  client_id TEXT PRIMARY KEY,
  database_instance_id TEXT NOT NULL REFERENCES storage_maintenance(database_instance_id),
  entrypoint TEXT NOT NULL CHECK (entrypoint IN ('http','stdio','local-management','owned-background','maintenance-controller')),
  build_id TEXT NOT NULL,
  protocol_version INTEGER NOT NULL CHECK (protocol_version=1),
  host_identity_json TEXT NOT NULL,
  process_identity_json TEXT NOT NULL,
  db_sessions_json TEXT NOT NULL,
  registered_epoch BIGINT NOT NULL CHECK (registered_epoch>=0),
  observed_epoch BIGINT NOT NULL CHECK (observed_epoch>=0),
  drain_epoch BIGINT CHECK (drain_epoch IS NULL OR drain_epoch>=0),
  drain_state TEXT NOT NULL DEFAULT 'none' CHECK (drain_state IN ('none','requested','draining','drained','cancel_pending','cancelled')),
  drain_receipt_digest TEXT,
  registered_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  ended_at TEXT,
  CHECK (drain_receipt_digest IS NULL OR length(drain_receipt_digest)=64),
  CHECK (drain_state<>'drained' OR (drain_epoch IS NOT NULL AND drain_receipt_digest IS NOT NULL))
);
CREATE INDEX storage_source_clients_epoch ON storage_source_clients(registered_epoch, ended_at);
`;

export const storageMaintenanceMigration: Migration = {
  version: 18,
  name: "storage_maintenance_fence_and_clients_v1",
  // 占位摘要仅在同一 DDL 事务中存在；迁移 runner 安装完整 guards 后替换，才允许提交。
  up: tables + `INSERT INTO storage_maintenance(singleton,database_instance_id,protocol_version,guard_manifest_digest)
    VALUES(1,lower(hex(randomblob(16))),1,'${"0".repeat(64)}');`,
  upPostgres: tables + `INSERT INTO storage_maintenance(singleton,database_instance_id,protocol_version,guard_manifest_digest)
    VALUES(1,replace(gen_random_uuid()::text,'-',''),1,'${"0".repeat(64)}');`,
};
