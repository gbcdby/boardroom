import type { Migration } from "../migrate.ts";

/** #134 / S2-T1：仅职责模板、永久 alias 与 user 审计，不建立第二个 Profile 写源。 */
export const identityCatalogMigration: Migration = {
  // 2026-11-11 由总控回读 main/活动票后串行分配；v1–v13 不变。
  version: 14,
  name: "identity_catalog_roles_aliases_user_audit",
  up: `
    CREATE TABLE role_templates (
      id TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE role_template_versions (
      role_template_id TEXT NOT NULL REFERENCES role_templates(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      purpose TEXT NOT NULL,
      instructions TEXT NOT NULL,
      recommended_skill_refs_json TEXT NOT NULL,
      archived_at TEXT,
      copied_from_role_template_id TEXT,
      copied_from_revision INTEGER,
      created_at TEXT NOT NULL,
      PRIMARY KEY (role_template_id, revision),
      CHECK ((copied_from_role_template_id IS NULL AND copied_from_revision IS NULL)
        OR (copied_from_role_template_id IS NOT NULL AND copied_from_revision IS NOT NULL AND copied_from_revision >= 1)),
      FOREIGN KEY (copied_from_role_template_id, copied_from_revision)
        REFERENCES role_template_versions(role_template_id, revision)
    );
    CREATE INDEX ix_role_template_copies ON role_template_versions (copied_from_role_template_id, copied_from_revision);

    -- alias 永久保留。旧未引用 Agent 可物理删除，因此这里保存稳定 ID 墓碑，
    -- 不设 CASCADE / SET NULL 外键；retired_at 区分已知删除与损坏关联。
    CREATE TABLE agent_legacy_aliases (
      display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
      host_type TEXT NOT NULL CHECK (length(trim(host_type)) > 0),
      agent_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      retired_at TEXT,
      PRIMARY KEY (display_name, host_type)
    );
    CREATE INDEX ix_agent_legacy_aliases_agent ON agent_legacy_aliases (agent_id);
    INSERT INTO agent_legacy_aliases (display_name, host_type, agent_id, created_at)
      SELECT display_name, host_type, id, created_at FROM agents;

    -- 原审计字段与索引保留；旧写入默认 project，新全局写入必须明确 user/NULL。
    CREATE TABLE audit_log_v14 (
      id TEXT PRIMARY KEY NOT NULL,
      scope TEXT NOT NULL DEFAULT 'project' CHECK (scope IN ('user', 'project')),
      project_id TEXT,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'system')),
      actor_member_id TEXT,
      actor_name TEXT NOT NULL,
      action TEXT NOT NULL,
      target_kind TEXT NOT NULL CHECK (target_kind IN
        ('member', 'node', 'role', 'capability', 'group', 'project', 'task', 'memory', 'role_template', 'agent')),
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
    INSERT INTO audit_log_v14 (id, scope, project_id, actor_kind, actor_member_id, actor_name, action, target_kind,
      target_id, target_name, changed, before, after, detail, reversed_at, reversed_by_audit_id, created_at)
      SELECT id, 'project', project_id, actor_kind, actor_member_id, actor_name, action, target_kind,
        target_id, target_name, changed, before, after, detail, reversed_at, reversed_by_audit_id, created_at FROM audit_log;
    DROP TABLE audit_log;
    ALTER TABLE audit_log_v14 RENAME TO audit_log;
    CREATE INDEX ix_audit_project_created ON audit_log (project_id, created_at, id);
    CREATE INDEX ix_audit_project_target ON audit_log (project_id, target_kind, target_id, id);
    CREATE INDEX ix_audit_project_action ON audit_log (project_id, action);
    CREATE INDEX ix_audit_user_created ON audit_log (scope, created_at, id) WHERE scope = 'user';
  `,
};
