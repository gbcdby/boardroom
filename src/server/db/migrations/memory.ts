import type { Migration } from "../migrate.ts";

/** 阶段 4：三层记忆、不可变版本、目标 Agent 总结与持久来源扫描。 */
export const memoryMigration: Migration = {
  version: 12,
  name: "memory_documents_summaries_and_scan_checkpoints",
  up: `
    CREATE TABLE memory_documents (
      id TEXT PRIMARY KEY NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('global', 'project', 'project-agent')),
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL CHECK (version >= 1),
      markdown TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('agent', 'human', 'manager', 'self-summary')),
      CHECK ((scope = 'global' AND project_id IS NULL AND agent_id IS NOT NULL)
        OR (scope = 'project' AND project_id IS NOT NULL AND agent_id IS NULL)
        OR (scope = 'project-agent' AND project_id IS NOT NULL AND agent_id IS NOT NULL))
    );
    CREATE UNIQUE INDEX ux_memory_global ON memory_documents (agent_id) WHERE scope = 'global';
    CREATE UNIQUE INDEX ux_memory_project ON memory_documents (project_id) WHERE scope = 'project';
    CREATE UNIQUE INDEX ux_memory_project_agent ON memory_documents (project_id, agent_id) WHERE scope = 'project-agent';
    CREATE INDEX ix_memory_documents_project ON memory_documents (project_id, updated_at, id);
    CREATE TABLE memory_versions (
      id TEXT PRIMARY KEY NOT NULL,
      document_id TEXT NOT NULL REFERENCES memory_documents(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK (version >= 1),
      parent_version INTEGER NOT NULL CHECK (parent_version = version - 1),
      markdown TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
      content_sha256 TEXT NOT NULL,
      author TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('agent', 'human', 'manager', 'self-summary')),
      client_mutation_id TEXT NOT NULL,
      summary_request_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (document_id, version),
      UNIQUE (document_id, actor_id, client_mutation_id)
    );
    CREATE TABLE memory_summary_requests (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
      recipient_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      context_group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
      document_id TEXT REFERENCES memory_documents(id) ON DELETE SET NULL,
      base_version INTEGER NOT NULL CHECK (base_version >= 0),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'completed', 'failed', 'conflicted', 'cancelled')),
      trigger TEXT NOT NULL CHECK (trigger IN ('task_completed', 'message_threshold', 'session_end', 'retry')),
      trigger_key TEXT NOT NULL,
      task_id TEXT,
      completed_task_revision INTEGER CHECK (completed_task_revision >= 1),
      message_ids TEXT NOT NULL,
      source_work_event_id TEXT,
      retry_of_request_id TEXT,
      attempt_id TEXT,
      begin_mutation_id TEXT,
      result_version INTEGER CHECK (result_version >= 1),
      result_sha256 TEXT,
      error TEXT,
      evidence TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      UNIQUE (project_id, agent_id, trigger_key),
      FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE
    );
    CREATE INDEX ix_memory_requests_agent ON memory_summary_requests (project_id, agent_id, state, created_at, id);
    CREATE INDEX ix_memory_requests_expiry ON memory_summary_requests (project_id, agent_id, state, started_at, id);
    CREATE INDEX ix_memory_requests_source ON memory_summary_requests (source_work_event_id);
    CREATE INDEX ix_memory_requests_group ON memory_summary_requests (context_group_id);
    CREATE TABLE memory_message_receipts (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      first_observed_at TEXT NOT NULL,
      counter_value INTEGER NOT NULL CHECK (counter_value >= 1),
      PRIMARY KEY (agent_id, message_id),
      UNIQUE (project_id, agent_id, group_id, counter_value)
    );
    CREATE TABLE memory_trigger_counters (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      lifetime_count INTEGER NOT NULL CHECK (lifetime_count >= 0),
      next_threshold INTEGER NOT NULL CHECK (next_threshold >= 1),
      configured_n INTEGER NOT NULL CHECK (configured_n BETWEEN 1 AND 10000),
      threshold_sequence INTEGER NOT NULL CHECK (threshold_sequence >= 0),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      PRIMARY KEY (project_id, agent_id, group_id)
    );
    CREATE TABLE memory_scan_checkpoints (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('message_threshold', 'task_completed')),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
      group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
      after_cursor TEXT,
      through_cursor TEXT,
      sweep INTEGER NOT NULL CHECK (sweep >= 0),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      updated_at TEXT NOT NULL,
      CHECK ((kind = 'message_threshold' AND group_id IS NOT NULL) OR (kind = 'task_completed' AND group_id IS NULL)),
      CHECK (after_cursor IS NULL OR through_cursor IS NOT NULL)
    );
    CREATE UNIQUE INDEX ux_memory_scan_messages ON memory_scan_checkpoints (project_id, agent_id, group_id) WHERE kind = 'message_threshold';
    CREATE UNIQUE INDEX ux_memory_scan_tasks ON memory_scan_checkpoints (project_id, agent_id) WHERE kind = 'task_completed';
    -- 不从旧 delivered/acked 状态推导真实 MCP 投递事实。
    ALTER TABLE message_deliveries ADD COLUMN first_mcp_delivered_at TEXT;
    CREATE INDEX ix_delivery_mcp_source ON message_deliveries (project_id, member_id, first_mcp_delivered_at, id);
    ALTER TABLE work_events ADD COLUMN context_group_id TEXT REFERENCES groups(id) ON DELETE CASCADE;
    CREATE INDEX ix_work_events_group ON work_events (project_id, recipient_member_id, context_group_id, delivery_state, created_at, id);

    -- 追加新版本扩大 target CHECK，保留既有行、撤销列与索引；不修改旧迁移 checksum。
    CREATE TABLE audit_log_v12 (
      id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'system')),
      actor_member_id TEXT, actor_name TEXT NOT NULL, action TEXT NOT NULL,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('member', 'node', 'role', 'capability', 'group', 'project', 'task', 'memory')),
      target_id TEXT NOT NULL, target_name TEXT NOT NULL, changed TEXT, before TEXT, after TEXT, detail TEXT,
      reversed_at TEXT, reversed_by_audit_id TEXT, created_at TEXT NOT NULL
    );
    INSERT INTO audit_log_v12 (id, project_id, actor_kind, actor_member_id, actor_name, action, target_kind, target_id,
      target_name, changed, before, after, detail, reversed_at, reversed_by_audit_id, created_at)
      SELECT id, project_id, actor_kind, actor_member_id, actor_name, action, target_kind, target_id,
        target_name, changed, before, after, detail, reversed_at, reversed_by_audit_id, created_at FROM audit_log;
    DROP TABLE audit_log;
    ALTER TABLE audit_log_v12 RENAME TO audit_log;
    CREATE INDEX ix_audit_project_created ON audit_log (project_id, created_at, id);
    CREATE INDEX ix_audit_project_target ON audit_log (project_id, target_kind, target_id, id);
    CREATE INDEX ix_audit_project_action ON audit_log (project_id, action);
  `,
};
