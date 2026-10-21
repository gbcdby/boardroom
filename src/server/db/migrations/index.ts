import type { Migration } from "../migrate.ts";

/**
 * 生产迁移列表。
 *
 * F1（#11）只建立迁移版本表 `schema_migrations`，不建领域表。
 * F2（#12）新增 `init_domain_model`：Agent/Project/Member/Group/Message/
 * MessageDelivery/MemberStatus 领域表、索引与外键约束。
 *
 * 规则：版本号递增，一旦应用就不可修改（runner 校验 checksum）；后续票只追加迁移。
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "init_domain_model",
    up: `
      -- Agent：跨项目的全局身份。连接相关字段（last_seen_at）可恢复、可持久化；
      -- 不存运行时对象（如 WebSocket 连接），连接是否存活由心跳在运行时推导。
      CREATE TABLE agents (
        id            TEXT PRIMARY KEY NOT NULL,
        display_name  TEXT NOT NULL,
        host_type     TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        last_seen_at  TEXT,
        CHECK (length(trim(display_name)) > 0),
        CHECK (length(trim(host_type)) > 0)
      );

      -- Project：协作容器。阶段 1 只验收一个项目，但按项目作用域建模。
      CREATE TABLE projects (
        id          TEXT PRIMARY KEY NOT NULL,
        name        TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        CHECK (length(trim(name)) > 0)
      );

      -- Member：agent 或人在某项目中的成员关系与岗位。
      -- kind=agent 的成员必须绑定全局 agent；kind=human 的成员不绑定 agent。
      -- 用 CHECK 保证一致性，repository 层做进一步校验（如 agent 是否已加入）。
      CREATE TABLE members (
        id            TEXT PRIMARY KEY NOT NULL,
        project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_id      TEXT REFERENCES agents(id) ON DELETE RESTRICT,
        kind          TEXT NOT NULL CHECK (kind IN ('agent', 'human')),
        display_name  TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'normal' CHECK (role IN ('manager', 'normal')),
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        CHECK (length(trim(display_name)) > 0),
        CHECK ((kind = 'agent' AND agent_id IS NOT NULL) OR (kind = 'human' AND agent_id IS NULL))
      );

      -- 每项目最多一个顶层 manager（D2）：部分唯一索引只约束 role='manager' 的行。
      CREATE UNIQUE INDEX ux_members_project_manager
        ON members (project_id)
        WHERE role = 'manager';

      CREATE INDEX ix_members_project ON members (project_id);
      CREATE UNIQUE INDEX ux_members_project_agent
        ON members (project_id, agent_id)
        WHERE agent_id IS NOT NULL;

      -- Group：项目内聊天空间。参与者只能从项目成员中选择（repository 校验）。
      CREATE TABLE groups (
        id          TEXT PRIMARY KEY NOT NULL,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        CHECK (length(trim(name)) > 0)
      );

      CREATE INDEX ix_groups_project ON groups (project_id);

      -- 群组参与者关系（多对多）。member 必须属于同一项目，由 repository 校验。
      CREATE TABLE group_participants (
        group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        joined_at   TEXT NOT NULL,
        PRIMARY KEY (group_id, member_id)
      );

      CREATE INDEX ix_group_participants_member ON group_participants (member_id);

      -- Message：群组消息。seq 为群组内单调递增序号（插入时按群组取 max+1），
      -- 与 id（稳定、可去重）一起提供稳定排序与游标分页。
      CREATE TABLE messages (
        id               TEXT PRIMARY KEY NOT NULL,
        group_id         TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        sender_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
        seq              INTEGER NOT NULL,
        body             TEXT NOT NULL,
        mentions         TEXT NOT NULL DEFAULT '[]',
        created_at       TEXT NOT NULL,
        CHECK (seq > 0),
        CHECK (json_valid(mentions) AND json_type(mentions) = 'array')
      );

      CREATE UNIQUE INDEX ux_messages_group_seq ON messages (group_id, seq);
      CREATE INDEX ix_messages_group_seq ON messages (group_id, seq);

      -- MessageDelivery：至少一次投递 + 去重。按 (message_id, member_id) 唯一，
      -- 记录首次/最后投递与状态，支持重连补发。
      CREATE TABLE message_deliveries (
        id                 TEXT PRIMARY KEY NOT NULL,
        message_id         TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        member_id          TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status             TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'acked')),
        attempt_count      INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        first_delivered_at TEXT,
        last_delivered_at  TEXT,
        acked_at           TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );

      CREATE UNIQUE INDEX ux_deliveries_message_member
        ON message_deliveries (message_id, member_id);
      CREATE INDEX ix_deliveries_member_status
        ON message_deliveries (project_id, member_id, status);

      -- MemberStatus：项目成员运行状态（D1），按 (project_id, member_id) 唯一。
      -- 与 Agent 全局连接状态分开建模；与任务状态（阶段 1 不实现）分开。
      CREATE TABLE member_statuses (
        project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        member_id    TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        state        TEXT NOT NULL CHECK (state IN ('online', 'offline', 'waiting', 'working')),
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (project_id, member_id)
      );

      CREATE UNIQUE INDEX ux_member_statuses_scope
        ON member_statuses (project_id, member_id);
      CREATE INDEX ix_member_statuses_state ON member_statuses (project_id, state);
    `,
  },
];
