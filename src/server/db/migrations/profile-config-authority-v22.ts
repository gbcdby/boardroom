import type { Migration } from "../migrate.ts";

/**
 * #153 B1a：Profile/Binding 当前头、不可变版本、compat 计数映射与 mutation 回执/审计。
 *
 * 本迁移只新建表；既有 v1–v21 的定义和 checksum 不变，不写旧 runtime 配置表，
 * 也不建立 config_authority 行（权威切换属于后续切片）。
 *
 * 两方言均先建被引用的版本/映射/回执/审计表，再建头表。
 * 版本表 → 头表的两条循环外键：SQLite 在建表时内联（SQLite 允许前向引用），
 * PostgreSQL 在两张头表建成后用 ALTER TABLE ADD CONSTRAINT 补齐，
 * 因为 PG 驱动按单条多语句顺序执行且不会重排 DDL。
 */

const profileVersionsBody = `
    agent_id                TEXT NOT NULL,
    revision                BIGINT NOT NULL CHECK (revision >= 1 AND revision <= 9007199254740991),
    content_json            TEXT NOT NULL CHECK (length(content_json) > 0),
    content_digest          TEXT NOT NULL CHECK (length(content_digest) = 64),
    default_role_id         TEXT,
    default_role_revision   INTEGER,
    compat_runtime_revision BIGINT CHECK (compat_runtime_revision >= 1 AND compat_runtime_revision <= 9007199254740991),
    created_at              TEXT NOT NULL,
    PRIMARY KEY (agent_id, revision),
    UNIQUE (agent_id, revision, content_digest),
    UNIQUE (agent_id, compat_runtime_revision),
    CHECK (length(agent_id) > 0),
    CHECK ((default_role_id IS NULL AND default_role_revision IS NULL)
      OR (default_role_id IS NOT NULL AND default_role_revision IS NOT NULL)),
    FOREIGN KEY (default_role_id, default_role_revision)
      REFERENCES role_template_versions(role_template_id, revision) ON DELETE RESTRICT ON UPDATE RESTRICT`;

const bindingVersionsBody = `
    binding_id                 TEXT NOT NULL,
    revision                   BIGINT NOT NULL CHECK (revision >= 1 AND revision <= 9007199254740991),
    content_json               TEXT NOT NULL CHECK (length(content_json) > 0),
    content_digest             TEXT NOT NULL CHECK (length(content_digest) = 64),
    role_id                    TEXT,
    role_revision              INTEGER,
    compat_execution_binding_id TEXT,
    compat_binding_revision    BIGINT CHECK (compat_binding_revision >= 1 AND compat_binding_revision <= 9007199254740991),
    created_at                 TEXT NOT NULL,
    PRIMARY KEY (binding_id, revision),
    UNIQUE (binding_id, revision, content_digest),
    CHECK (length(binding_id) > 0),
    CHECK ((role_id IS NULL AND role_revision IS NULL) OR (role_id IS NOT NULL AND role_revision IS NOT NULL))`;

const profileHeadTable = `
  CREATE TABLE agent_profiles (
    agent_id                 TEXT NOT NULL PRIMARY KEY,
    current_revision         BIGINT NOT NULL CHECK (current_revision >= 1 AND current_revision <= 9007199254740991),
    legacy_runtime_id        TEXT UNIQUE,
    compat_runtime_revision  BIGINT CHECK (compat_runtime_revision >= 1 AND compat_runtime_revision <= 9007199254740991),
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL,
    CHECK (length(agent_id) > 0),
    CHECK ((legacy_runtime_id IS NULL AND compat_runtime_revision IS NULL)
      OR (legacy_runtime_id IS NOT NULL AND compat_runtime_revision IS NOT NULL)),
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (legacy_runtime_id) REFERENCES agent_runtimes(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (agent_id, current_revision)
      REFERENCES agent_profile_versions(agent_id, revision) DEFERRABLE INITIALLY DEFERRED
  );`;

const bindingHeadTable = `
  CREATE TABLE group_bindings (
    id                            TEXT NOT NULL PRIMARY KEY,
    project_id                    TEXT NOT NULL,
    group_id                      TEXT NOT NULL,
    member_id                     TEXT NOT NULL,
    agent_id                      TEXT NOT NULL,
    current_revision              BIGINT NOT NULL CHECK (current_revision >= 1 AND current_revision <= 9007199254740991),
    original_legacy_binding_id    TEXT UNIQUE,
    current_attachment_id         TEXT UNIQUE,
    current_attachment_state      TEXT,
    current_compat_binding_revision BIGINT CHECK (current_compat_binding_revision >= 1 AND current_compat_binding_revision <= 9007199254740991),
    retired_at                    TEXT,
    created_at                    TEXT NOT NULL,
    updated_at                    TEXT NOT NULL,
    UNIQUE (member_id, group_id),
    UNIQUE (id, project_id, group_id, member_id),
    CHECK (length(id) > 0),
    CHECK ((current_attachment_id IS NULL AND current_attachment_state IS NULL AND current_compat_binding_revision IS NULL)
      OR (current_attachment_id IS NOT NULL AND current_attachment_state IS NOT NULL AND current_compat_binding_revision IS NOT NULL)),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (agent_id) REFERENCES agent_profiles(agent_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (id, current_revision)
      REFERENCES group_binding_config_versions(binding_id, revision) DEFERRABLE INITIALLY DEFERRED
  );`;

const compatTable = `
  CREATE TABLE config_compat_revisions (
    scope            TEXT NOT NULL CHECK (scope IN ('profile', 'binding')),
    subject_id       TEXT NOT NULL CHECK (length(subject_id) > 0),
    revision         BIGINT NOT NULL CHECK (revision >= 1 AND revision <= 9007199254740991),
    compat_revision  BIGINT NOT NULL CHECK (compat_revision >= 1 AND compat_revision <= 9007199254740991),
    created_at       TEXT NOT NULL,
    PRIMARY KEY (scope, subject_id, revision),
    UNIQUE (scope, subject_id, compat_revision)
  );`;

const receiptsTable = `
  CREATE TABLE config_mutation_receipts (
    mutation_id             TEXT NOT NULL PRIMARY KEY,
    actor_scope             TEXT NOT NULL CHECK (length(actor_scope) > 0),
    operation               TEXT NOT NULL CHECK (operation IN
      ('profile.create', 'profile.save', 'binding.create', 'binding.save')),
    target_scope            TEXT NOT NULL CHECK (length(target_scope) > 0),
    command_digest          TEXT NOT NULL CHECK (length(command_digest) = 64),
    result_json             TEXT NOT NULL CHECK (length(result_json) > 0),
    result_profile_agent_id TEXT,
    result_profile_revision BIGINT,
    result_profile_digest   TEXT,
    result_binding_id       TEXT,
    result_binding_revision BIGINT,
    result_binding_digest   TEXT,
    audit_id                TEXT NOT NULL UNIQUE,
    created_at              TEXT NOT NULL,
    CHECK ((result_profile_agent_id IS NULL AND result_profile_revision IS NULL AND result_profile_digest IS NULL)
      OR (result_profile_agent_id IS NOT NULL AND result_profile_revision IS NOT NULL AND result_profile_digest IS NOT NULL)),
    CHECK ((result_binding_id IS NULL AND result_binding_revision IS NULL AND result_binding_digest IS NULL)
      OR (result_binding_id IS NOT NULL AND result_binding_revision IS NOT NULL AND result_binding_digest IS NOT NULL))
  );`;

const auditTable = `
  CREATE TABLE config_mutation_audit (
    id             TEXT NOT NULL PRIMARY KEY,
    mutation_id    TEXT NOT NULL UNIQUE,
    actor_kind     TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'system')),
    actor_id       TEXT NOT NULL CHECK (length(actor_id) > 0),
    operation      TEXT NOT NULL CHECK (operation IN
      ('profile.create', 'profile.save', 'binding.create', 'binding.save')),
    target_kind    TEXT NOT NULL CHECK (target_kind IN ('profile', 'binding')),
    target_id      TEXT NOT NULL CHECK (length(target_id) > 0),
    command_digest TEXT NOT NULL CHECK (length(command_digest) = 64),
    before_json    TEXT,
    after_json     TEXT NOT NULL CHECK (length(after_json) > 0),
    created_at     TEXT NOT NULL,
    FOREIGN KEY (mutation_id) REFERENCES config_mutation_receipts(mutation_id)
      DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (id) REFERENCES config_mutation_receipts(audit_id)
      DEFERRABLE INITIALLY DEFERRED
  );`;

const indexes = `
  CREATE INDEX ix_profile_version_created ON agent_profile_versions (agent_id, revision);
  CREATE INDEX ix_binding_version_created ON group_binding_config_versions (binding_id, revision);
  CREATE INDEX ix_config_compat_subject ON config_compat_revisions (scope, subject_id, compat_revision);
  CREATE INDEX ix_config_mutation_audit_target ON config_mutation_audit (target_kind, target_id, created_at);`;

const sqliteTables = [
  `CREATE TABLE agent_profile_versions (\n${profileVersionsBody},\n` +
    "    FOREIGN KEY (agent_id) REFERENCES agent_profiles(agent_id) ON DELETE RESTRICT ON UPDATE RESTRICT\n  );",
  `CREATE TABLE group_binding_config_versions (\n${bindingVersionsBody},\n` +
    "    FOREIGN KEY (binding_id) REFERENCES group_bindings(id) ON DELETE RESTRICT ON UPDATE RESTRICT\n  );",
  compatTable,
  receiptsTable,
  auditTable,
  profileHeadTable,
  bindingHeadTable,
  indexes,
].join("\n");

const postgresTables = [
  `CREATE TABLE agent_profile_versions (\n${profileVersionsBody}\n  );`,
  `CREATE TABLE group_binding_config_versions (\n${bindingVersionsBody}\n  );`,
  compatTable,
  receiptsTable,
  auditTable,
  profileHeadTable,
  bindingHeadTable,
  `ALTER TABLE agent_profile_versions ADD CONSTRAINT m2_r02_fk_head
    FOREIGN KEY (agent_id) REFERENCES agent_profiles(agent_id) ON DELETE RESTRICT ON UPDATE RESTRICT;`,
  `ALTER TABLE group_binding_config_versions ADD CONSTRAINT m2_r04_fk_head
    FOREIGN KEY (binding_id) REFERENCES group_bindings(id) ON DELETE RESTRICT ON UPDATE RESTRICT;`,
  indexes,
].join("\n");

const immutableTables = [
  "agent_profile_versions",
  "group_binding_config_versions",
  "config_compat_revisions",
  "config_mutation_receipts",
  "config_mutation_audit",
] as const;

const sqliteGuards = immutableTables.map(table => `
  CREATE TRIGGER trg_${table}_no_update BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT, '${table}_immutable'); END;
  CREATE TRIGGER trg_${table}_no_delete BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT, '${table}_immutable'); END;
`).join("");

const postgresGuards = immutableTables.map(table => `
  CREATE FUNCTION ${table}_immutable_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $pcfg_guard$
  BEGIN
    RAISE EXCEPTION '${table}_immutable' USING ERRCODE = '23514';
  END;
  $pcfg_guard$;
  CREATE TRIGGER trg_${table}_no_update BEFORE UPDATE ON ${table}
    FOR EACH ROW EXECUTE FUNCTION ${table}_immutable_guard_fn();
  CREATE TRIGGER trg_${table}_no_delete BEFORE DELETE ON ${table}
    FOR EACH ROW EXECUTE FUNCTION ${table}_immutable_guard_fn();
`).join("");

export const profileConfigAuthorityV22Migration: Migration = {
  version: 22,
  name: "profile_config_authority_core",
  up: sqliteTables + sqliteGuards,
  upPostgres: postgresTables + postgresGuards,
};
