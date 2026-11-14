import type { Migration } from "../migrate.ts";

/** #151：总控 2026-11-11 分配 v17；v16 属 #137，不修改既有迁移。 */
export const policyConfigurationMigration: Migration = {
  version: 17,
  name: "policy_configuration_versions",
  up: `
    CREATE TABLE policy_documents (
      scope_key TEXT PRIMARY KEY NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('user', 'project')),
      project_id TEXT UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((scope = 'user' AND project_id IS NULL AND scope_key = 'user')
        OR (scope = 'project' AND project_id IS NOT NULL AND scope_key = 'project:' || project_id))
    );
    CREATE TABLE policy_document_versions (
      document_id TEXT NOT NULL REFERENCES policy_documents(scope_key) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      document_json TEXT NOT NULL,
      content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
      based_on_global_revision INTEGER CHECK (based_on_global_revision >= 1),
      default_revision INTEGER NOT NULL CHECK (default_revision >= 1),
      created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('human', 'system')),
      created_by_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (document_id, revision)
    );
    -- 只扩审计目标枚举；原 user/project、撤销链和完整字段逐列保留。
    CREATE TABLE audit_log_v17 (
      id TEXT PRIMARY KEY NOT NULL,
      scope TEXT NOT NULL DEFAULT 'project' CHECK (scope IN ('user', 'project')),
      project_id TEXT,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'system')),
      actor_member_id TEXT,
      actor_name TEXT NOT NULL,
      action TEXT NOT NULL,
      target_kind TEXT NOT NULL CHECK (target_kind IN
        ('member', 'node', 'role', 'capability', 'group', 'project', 'task', 'memory', 'role_template', 'agent', 'policy_document')),
      target_id TEXT NOT NULL,
      target_name TEXT NOT NULL,
      changed TEXT,
      before TEXT,
      after TEXT,
      detail TEXT,
      reversed_at TEXT,
      reversed_by_audit_id TEXT,
      created_at TEXT NOT NULL,
      CHECK ((scope = 'user' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
    );
    INSERT INTO audit_log_v17 (id, scope, project_id, actor_kind, actor_member_id, actor_name, action, target_kind,
      target_id, target_name, changed, before, after, detail, reversed_at, reversed_by_audit_id, created_at)
      SELECT id, scope, project_id, actor_kind, actor_member_id, actor_name, action, target_kind,
        target_id, target_name, changed, before, after, detail, reversed_at, reversed_by_audit_id, created_at FROM audit_log;
    DROP TABLE audit_log;
    ALTER TABLE audit_log_v17 RENAME TO audit_log;
    CREATE INDEX ix_audit_project_created ON audit_log (project_id, created_at, id);
    CREATE INDEX ix_audit_project_target ON audit_log (project_id, target_kind, target_id, id);
    CREATE INDEX ix_audit_project_action ON audit_log (project_id, action);
    CREATE INDEX ix_audit_user_created ON audit_log (scope, created_at, id) WHERE scope = 'user';
  `,
};
