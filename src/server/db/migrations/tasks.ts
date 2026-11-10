import type { Migration } from "../migrate.ts";

/** 阶段 3：任务、固定候选双轴评审与可重投工作事件；两种数据库共用 DDL。 */
export const tasksMigration: Migration = {
  version: 11,
  name: "tasks_reviews_and_work_events",
  up: `
    CREATE TABLE project_task_settings (
      project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      default_reviewer_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1)
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
      body TEXT NOT NULL,
      labels TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('todo', 'in-progress', 'review', 'blocked', 'done')),
      assignee_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
      reviewer_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
      repo_path TEXT,
      fixed_point TEXT,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      current_review_round_id TEXT,
      blocked_reason TEXT,
      author TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, id)
    );
    CREATE INDEX ix_tasks_project_state ON tasks (project_id, state, created_at, id);
    CREATE INDEX ix_tasks_assignee ON tasks (project_id, assignee_member_id);
    CREATE TABLE task_review_rounds (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      task_revision INTEGER NOT NULL CHECK (task_revision >= 1),
      state TEXT NOT NULL CHECK (state IN ('ready', 'running', 'reported', 'decided', 'failed', 'superseded')),
      reviewer_member_id TEXT NOT NULL,
      spec_snapshot TEXT NOT NULL,
      candidate TEXT,
      failure TEXT,
      decision TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, task_id, id),
      FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE
    );
    CREATE INDEX ix_task_rounds_task ON task_review_rounds (project_id, task_id, created_at, id);
    CREATE TABLE task_review_reports (
      id TEXT PRIMARY KEY NOT NULL,
      round_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      axis TEXT NOT NULL CHECK (axis IN ('spec', 'standards')),
      verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'changes_requested')),
      body TEXT NOT NULL,
      sources TEXT NOT NULL,
      evidence TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      author TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (round_id, axis),
      UNIQUE (project_id, task_id, id),
      FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE,
      FOREIGN KEY (project_id, task_id, round_id) REFERENCES task_review_rounds(project_id, task_id, id) ON DELETE CASCADE
    );
    CREATE INDEX ix_task_reports_task ON task_review_reports (project_id, task_id, created_at, id);
    CREATE TABLE task_comments (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('comment', 'review_report')),
      author TEXT NOT NULL,
      author_actor_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      review_report_id TEXT,
      CHECK ((kind = 'comment' AND review_report_id IS NULL) OR (kind = 'review_report' AND review_report_id IS NOT NULL)),
      FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE,
      FOREIGN KEY (project_id, task_id, review_report_id) REFERENCES task_review_reports(project_id, task_id, id) ON DELETE CASCADE
    );
    CREATE INDEX ix_task_comments_task ON task_comments (project_id, task_id, created_at, id);
    CREATE INDEX ix_task_comments_author ON task_comments (project_id, task_id, author_actor_id);
    CREATE TABLE task_history (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      task_revision INTEGER NOT NULL CHECK (task_revision >= 1),
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE
    );
    CREATE INDEX ix_task_history_task ON task_history (project_id, task_id, created_at, id);
    CREATE TABLE task_message_links (
      task_id TEXT NOT NULL,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, message_id),
      FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE
    );
    CREATE INDEX ix_task_links_message ON task_message_links (project_id, message_id);
    CREATE TABLE work_events (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      recipient_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      task_id TEXT,
      kind TEXT NOT NULL,
      event_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      delivery_state TEXT NOT NULL CHECK (delivery_state IN ('pending', 'delivered', 'acked')),
      attempts INTEGER NOT NULL CHECK (attempts >= 0),
      created_at TEXT NOT NULL,
      first_delivered_at TEXT,
      last_delivered_at TEXT,
      acked_at TEXT,
      UNIQUE (recipient_member_id, event_key),
      CHECK (kind NOT LIKE 'task.%' OR task_id IS NOT NULL),
      FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE
    );
    CREATE INDEX ix_work_events_recipient ON work_events (project_id, recipient_member_id, delivery_state, created_at, id);

    -- 既有审计无外键；保留删除后的痕迹和撤销链。v6 内容及 checksum 不变。
    CREATE TABLE audit_log_v11 (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'system')),
      actor_member_id TEXT,
      actor_name TEXT NOT NULL,
      action TEXT NOT NULL,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('member', 'node', 'role', 'capability', 'group', 'project', 'task')),
      target_id TEXT NOT NULL,
      target_name TEXT NOT NULL,
      changed TEXT,
      before TEXT,
      after TEXT,
      detail TEXT,
      reversed_at TEXT,
      reversed_by_audit_id TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO audit_log_v11 (id, project_id, actor_kind, actor_member_id, actor_name, action, target_kind, target_id,
      target_name, changed, before, after, detail, reversed_at, reversed_by_audit_id, created_at)
      SELECT id, project_id, actor_kind, actor_member_id, actor_name, action, target_kind, target_id,
        target_name, changed, before, after, detail, reversed_at, reversed_by_audit_id, created_at FROM audit_log;
    DROP TABLE audit_log;
    ALTER TABLE audit_log_v11 RENAME TO audit_log;
    CREATE INDEX ix_audit_project_created ON audit_log (project_id, created_at, id);
    CREATE INDEX ix_audit_project_target ON audit_log (project_id, target_kind, target_id, id);
    CREATE INDEX ix_audit_project_action ON audit_log (project_id, action);
  `,
};
