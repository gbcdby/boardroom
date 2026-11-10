import type { Migration } from "../migrate.ts";

/** #84：新增配置/绑定/runner 与成员预留；不改 Agent 身份或旧 MCP 会话。 */
export const managedRuntime: Migration = {
  version: 8,
  name: "managed_runtime_configuration_and_ownership",
  up: `
    CREATE TABLE agent_runtimes (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
      config_version INTEGER NOT NULL DEFAULT 1 CHECK (config_version > 0),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      defaults_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE agent_runtime_bindings (
      id TEXT PRIMARY KEY NOT NULL,
      runtime_id TEXT NOT NULL REFERENCES agent_runtimes(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      overrides_json TEXT NOT NULL DEFAULT '{}',
      advanced_json TEXT,
      desired_state TEXT NOT NULL DEFAULT 'stopped' CHECK (desired_state IN ('running', 'stopped')),
      intent_revision INTEGER NOT NULL DEFAULT 0 CHECK (intent_revision >= 0),
      requested_snapshot_json TEXT,
      reset_session_requested INTEGER NOT NULL DEFAULT 0 CHECK (reset_session_requested IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (runtime_id, project_id, group_id),
      UNIQUE (member_id, group_id)
    );
    CREATE INDEX ix_runtime_bindings_project ON agent_runtime_bindings (project_id, group_id);
    CREATE INDEX ix_runtime_bindings_desired ON agent_runtime_bindings (desired_state);
    CREATE TABLE agent_runner_states (
      binding_id TEXT PRIMARY KEY NOT NULL REFERENCES agent_runtime_bindings(id) ON DELETE CASCADE,
      state TEXT NOT NULL DEFAULT 'stopped' CHECK (state IN ('stopped', 'starting', 'running', 'stopping', 'failed')),
      phase TEXT NOT NULL DEFAULT 'unknown' CHECK (phase IN ('idle', 'working', 'unknown')),
      generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
      lease_owner TEXT,
      lease_expires_at TEXT,
      applied_json TEXT,
      harness_session_id TEXT,
      session_key TEXT UNIQUE,
      session_state TEXT NOT NULL DEFAULT 'new' CHECK (session_state IN ('new', 'resumable', 'invalid', 'reset', 'unknown')),
      pid INTEGER,
      exit_confirmed INTEGER NOT NULL DEFAULT 1 CHECK (exit_confirmed IN (0, 1)),
      observed_at TEXT,
      started_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_retry_at TEXT,
      last_error_code TEXT,
      last_exit_code INTEGER,
      last_exit_signal TEXT,
      permission_observed TEXT NOT NULL DEFAULT 'unknown',
      updated_at TEXT NOT NULL,
      CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
    );
    CREATE TABLE agent_runtime_members (
      member_id TEXT PRIMARY KEY NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      runtime_id TEXT NOT NULL REFERENCES agent_runtimes(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      binding_id TEXT REFERENCES agent_runtime_bindings(id) ON DELETE RESTRICT,
      generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
      lease_owner TEXT,
      lease_expires_at TEXT,
      updated_at TEXT NOT NULL,
      CHECK ((binding_id IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)
        OR (binding_id IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
    );
    CREATE INDEX ix_runtime_members_runtime ON agent_runtime_members (runtime_id);
  `,
};
