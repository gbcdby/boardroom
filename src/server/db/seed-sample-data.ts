/**
 * 示例业务数据种子（M1 #54 测试与真实迁移演示共用）。
 *
 * 经仓库既有迁移建表后的 SQLite 库插入一套覆盖全部 11 张业务表的代表性数据：
 * 含 org_nodes 树（层级）、复合主键表（group_participants / member_statuses）、
 * messages.mentions JSON、seq、message_deliveries 投递状态、member 生命周期
 * 状态、mcp_sessions、audit_log。所有值满足既有 CHECK 约束与唯一索引。
 *
 * 本文件仅用于「造数据」，不参与任何产品逻辑；迁移工具按 `SELECT *` 读取源库，
 * 数据来源（本种子或真实业务库）对迁移正确性无影响。
 */
import type Database from "better-sqlite3";

const TS = "2024-01-15T10:00:00.000Z";

/** 在已建表的 SQLite 连接上写入示例业务数据。 */
export function seedSampleData(db: Database.Database): void {
  const run = (sql: string, ...params: unknown[]): void => {
    db.prepare(sql).run(...params);
  };

  // agents
  run(
    `INSERT INTO agents (id, display_name, host_type, created_at, updated_at, last_seen_at)
     VALUES (?,?,?,?,?,?)`,
    "ag1",
    "Claude",
    "claude-code",
    TS,
    TS,
    TS,
  );
  run(
    `INSERT INTO agents (id, display_name, host_type, created_at, updated_at, last_seen_at)
     VALUES (?,?,?,?,?,?)`,
    "ag2",
    "Codex",
    "codex-cli",
    TS,
    TS,
    TS,
  );

  // projects
  run(
    `INSERT INTO projects (id, name, created_at, updated_at) VALUES (?,?,?,?)`,
    "pr1",
    "Demo Project",
    TS,
    TS,
  );

  // org_nodes（树：nd0 根 → nd1/nd2；nd1 → nd3）
  run(
    `INSERT INTO org_nodes (id, project_id, parent_id, name, role, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    "nd0",
    "pr1",
    null,
    "Root",
    "top_manager",
    0,
    TS,
    TS,
  );
  run(
    `INSERT INTO org_nodes (id, project_id, parent_id, name, role, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    "nd1",
    "pr1",
    "nd0",
    "Team A",
    "sub_manager",
    1,
    TS,
    TS,
  );
  run(
    `INSERT INTO org_nodes (id, project_id, parent_id, name, role, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    "nd2",
    "pr1",
    "nd0",
    "Team B",
    "member",
    2,
    TS,
    TS,
  );
  run(
    `INSERT INTO org_nodes (id, project_id, parent_id, name, role, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    "nd3",
    "pr1",
    "nd1",
    "IC",
    "member",
    0,
    TS,
    TS,
  );

  // members（agent / human，含 node_id 与生命周期 status）
  run(
    `INSERT INTO members (id, project_id, agent_id, kind, display_name, role, created_at, updated_at, node_id, status)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    "mb1",
    "pr1",
    "ag1",
    "agent",
    "Claude",
    "manager",
    TS,
    TS,
    "nd0",
    "active",
  );
  run(
    `INSERT INTO members (id, project_id, agent_id, kind, display_name, role, created_at, updated_at, node_id, status)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    "mb2",
    "pr1",
    "ag2",
    "agent",
    "Codex",
    "normal",
    TS,
    TS,
    "nd1",
    "active",
  );
  run(
    `INSERT INTO members (id, project_id, agent_id, kind, display_name, role, created_at, updated_at, node_id, status)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    "mb3",
    "pr1",
    null,
    "human",
    "Alice",
    "normal",
    TS,
    TS,
    "nd2",
    "active",
  );

  // groups（含一个已归档）
  run(
    `INSERT INTO groups (id, project_id, name, created_at, updated_at, archived_at)
     VALUES (?,?,?,?,?,?)`,
    "gp1",
    "pr1",
    "General",
    TS,
    TS,
    null,
  );
  run(
    `INSERT INTO groups (id, project_id, name, created_at, updated_at, archived_at)
     VALUES (?,?,?,?,?,?)`,
    "gp2",
    "pr1",
    "Archived",
    TS,
    TS,
    TS,
  );

  // group_participants（复合主键）
  run(`INSERT INTO group_participants (group_id, member_id, joined_at) VALUES (?,?,?)`, "gp1", "mb1", TS);
  run(`INSERT INTO group_participants (group_id, member_id, joined_at) VALUES (?,?,?)`, "gp1", "mb2", TS);
  run(`INSERT INTO group_participants (group_id, member_id, joined_at) VALUES (?,?,?)`, "gp1", "mb3", TS);

  // messages（seq、mentions JSON）
  run(
    `INSERT INTO messages (id, group_id, sender_member_id, seq, body, mentions, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    "msg1",
    "gp1",
    "mb1",
    1,
    "hello",
    '["mb2"]',
    TS,
  );
  run(
    `INSERT INTO messages (id, group_id, sender_member_id, seq, body, mentions, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    "msg2",
    "gp1",
    "mb2",
    2,
    "hi",
    "[]",
    TS,
  );

  // message_deliveries
  run(
    `INSERT INTO message_deliveries
       (id, message_id, member_id, project_id, status, attempt_count, first_delivered_at, last_delivered_at, acked_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    "md1",
    "msg1",
    "mb2",
    "pr1",
    "delivered",
    1,
    TS,
    TS,
    TS,
    TS,
    TS,
  );
  run(
    `INSERT INTO message_deliveries
       (id, message_id, member_id, project_id, status, attempt_count, first_delivered_at, last_delivered_at, acked_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    "md2",
    "msg1",
    "mb3",
    "pr1",
    "acked",
    2,
    TS,
    TS,
    TS,
    TS,
    TS,
  );

  // member_statuses（复合主键）
  run(`INSERT INTO member_statuses (project_id, member_id, state, updated_at) VALUES (?,?,?,?)`, "pr1", "mb1", "working", TS);
  run(`INSERT INTO member_statuses (project_id, member_id, state, updated_at) VALUES (?,?,?,?)`, "pr1", "mb2", "waiting", TS);
  run(`INSERT INTO member_statuses (project_id, member_id, state, updated_at) VALUES (?,?,?,?)`, "pr1", "mb3", "online", TS);

  // mcp_sessions
  run(
    `INSERT INTO mcp_sessions
       (id, agent_id, project_id, group_id, member_id, display_name, host_type, state, connected_at, last_heartbeat_at, disconnected_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    "sx1",
    "ag1",
    "pr1",
    "gp1",
    "mb1",
    "Claude",
    "claude-code",
    "connected",
    TS,
    TS,
    null,
    TS,
  );

  // audit_log
  run(
    `INSERT INTO audit_log
       (id, project_id, actor_kind, actor_member_id, actor_name, action, target_kind, target_id, target_name, changed, before, after, detail, reversed_at, reversed_by_audit_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    "au1",
    "pr1",
    "human",
    "mb3",
    "Alice",
    "member.add",
    "member",
    "mb2",
    "Codex",
    '{"role":"normal"}',
    "null",
    '{"role":"normal"}',
    "",
    null,
    null,
    TS,
  );
}
