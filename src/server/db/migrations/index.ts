import { decisionsMigration } from "./decisions.ts";
import { workEventDeliveryInvalidationsMigration } from "./work-event-delivery-invalidations.ts";
import { memoryMigration } from "./memory.ts";
import { memberLifecycleMigration } from "./member-lifecycle.ts";
import type { Migration } from "../migrate.ts";
import { durableMessageDispatch } from "./message-dispatch.ts";
import { managedRuntime } from "./runtime.ts";
import { runtimeObservabilityMigration } from "./runtime-observability.ts";
import { runtimeProcessIdentityMigration } from "./runtime-process-identity.ts";
import { tasksMigration } from "./tasks.ts";
import { identityCatalogMigration } from "./identity-catalog.ts";
import { projectWorkspacesMigration } from "./project-workspaces.ts";
import { taskIntakeMigration } from "./task-intake.ts";
import { policyConfigurationMigration } from "./policy-configuration.ts";
import { storageMaintenanceMigration } from "./storage-maintenance.ts";
import { mcpConnectionsMigration } from "./mcp-connections.ts";

/**
 * 生产迁移列表。
 *
 * F1（#11）只建立迁移版本表 `schema_migrations`，不建领域表。
 * F2（#12）新增 `init_domain_model`：Agent/Project/Member/Group/Message/
 * MessageDelivery/MemberStatus 领域表、索引与外键约束。
 * T1（#48）新增 `archive_flags_for_project_and_group`：项目/群组的归档标记。
 * T2（#49）新增 `org_tree_and_static_roles`：`org_nodes` 组织树（岗位 + 汇报线）、
 * `members.node_id` 占岗锚点与「一人一岗」唯一索引；移除与多层树冲突的旧
 * `ux_members_project_manager`（决策票 #24；阶段 1 兼容语义下沉到 repository 应用层校验）。
 * T3（#50）新增 `member_lifecycle_status`：`members.status` 生命周期枚举
 * （active/disabled/pending），老库默认 active、可恢复、不物理删除。
 * T5（#52）新增 `init_audit_log`：最小审计单表（append-only、无外键、before/after
 * 快照 + 撤销两列），老库升级后为空表，不影响既有数据（决策票 #30/#28）。
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
    // PostgreSQL 镜像：与 SQLite 同构，但省略 SQLite 专有的
    // `CHECK (json_valid(mentions) AND json_type(mentions) = 'array')` —— PG 无
    // json_valid/json_type 函数。`mentions` 仍为 TEXT，其 JSON 合法性由仓储层写入前
    // 保证（与 #61 运行态一致）。
    upPostgres: `
      -- Agent（PostgreSQL 镜像；省略 SQLite 专有的 json_valid/json_type 检查，
      -- mentions 的 JSON 合法性由仓储层写入前保证，见 #61）。
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

      CREATE UNIQUE INDEX ux_members_project_manager
        ON members (project_id)
        WHERE role = 'manager';

      CREATE INDEX ix_members_project ON members (project_id);
      CREATE UNIQUE INDEX ux_members_project_agent
        ON members (project_id, agent_id)
        WHERE agent_id IS NOT NULL;

      CREATE TABLE groups (
        id          TEXT PRIMARY KEY NOT NULL,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        CHECK (length(trim(name)) > 0)
      );

      CREATE INDEX ix_groups_project ON groups (project_id);

      CREATE TABLE group_participants (
        group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        joined_at   TEXT NOT NULL,
        PRIMARY KEY (group_id, member_id)
      );

      CREATE INDEX ix_group_participants_member ON group_participants (member_id);

      CREATE TABLE messages (
        id               TEXT PRIMARY KEY NOT NULL,
        group_id         TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        sender_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
        seq              INTEGER NOT NULL,
        body             TEXT NOT NULL,
        mentions         TEXT NOT NULL DEFAULT '[]',
        created_at       TEXT NOT NULL,
        CHECK (seq > 0)
      );

      CREATE UNIQUE INDEX ux_messages_group_seq ON messages (group_id, seq);
      CREATE INDEX ix_messages_group_seq ON messages (group_id, seq);

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
  {
    version: 2,
    name: "mcp_sessions_and_agent_identity",
    up: `
      -- T2（#15）：双宿主 MCP 入群与在线。
      --
      -- 1) Agent 全局身份唯一：同一 agent（display_name + host_type）全局唯一，
      --    避免同名同宿主的 agent 重复声明出多个全局身份。入群时按此键查找或创建。
      --    用唯一索引把不变量落到数据库，而不是只在应用层判断。
      CREATE UNIQUE INDEX ux_agents_identity ON agents (display_name, host_type);

      -- 2) MCP 连接状态（全局会话层，D1）：与 member_statuses（项目成员运行状态）分开。
      --    只在库中持久化「可恢复」的会话信息（会话 id、绑定的 agent/项目/群组、连接/
      --    断开时间）；「连接是否存活」由运行时按心跳推导，不把连接对象落库。
      --    进程重启后，未正常断开的会话在启动时被标记为断开（stale），不臆造在线。
      CREATE TABLE mcp_sessions (
        id            TEXT PRIMARY KEY NOT NULL,
        agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        group_id      TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        display_name  TEXT NOT NULL,
        host_type     TEXT NOT NULL,
        state         TEXT NOT NULL DEFAULT 'connected' CHECK (state IN ('connected', 'disconnected')),
        connected_at  TEXT NOT NULL,
        last_heartbeat_at TEXT,
        disconnected_at   TEXT,
        updated_at    TEXT NOT NULL
      );

      CREATE INDEX ix_mcp_sessions_agent ON mcp_sessions (agent_id);
      CREATE INDEX ix_mcp_sessions_state ON mcp_sessions (state);
      -- 一个 agent 在同一项目/群组下最多一个活跃会话（阶段 1 单项目单群组）。
      CREATE UNIQUE INDEX ux_mcp_sessions_active
        ON mcp_sessions (agent_id, project_id, group_id)
        WHERE state = 'connected';
    `,
  },
  {
    version: 3,
    name: "archive_flags_for_project_and_group",
    up: `
      -- T1（#48）归档标记（PROJECT-03 / GROUP-04 / LIFE-ARC-01）。
      --
      -- 归档 = 可恢复的非活跃态：只加一个可空时间戳，NULL 表示未归档。
      -- 不新增状态枚举、不删数据：恢复即把该列置回 NULL，
      -- 永久删除（LIFE-ARC-02）走 repository 的显式级联清除，不靠这里。
      ALTER TABLE projects ADD COLUMN archived_at TEXT;
      ALTER TABLE groups ADD COLUMN archived_at TEXT;

      -- 列表默认只取未归档行（项目列表 / 项目内群组列表），按归档位建索引避免全表扫。
      CREATE INDEX ix_projects_archived ON projects (archived_at);
      CREATE INDEX ix_groups_project_archived ON groups (project_id, archived_at);
    `,
  },
  {
    version: 4,
    name: "org_tree_and_static_roles",
    up: `
      -- T2（#49）组织树与角色（决策票 #24/#25；spec #45 §4/§6.2）。
      --
      -- org_nodes 表达「岗位 + 汇报线」：parent_id 即汇报线（上级=父节点），递归 CTE 现算子树。
      -- role 是**静态枚举**（spec #45 §3/§5.3 假设 4，不引入动态 RBAC）；角色与岗位分离：
      -- 这里是「该岗位实例是什么角色」，能力集合由 F2 的 ROLE_CAPABILITIES 静态矩阵表达。
      -- owner 属于角色枚举（人的内建角色），但**不建节点**（人是全局主体，决策票 #26）。
      CREATE TABLE org_nodes (
        id          TEXT PRIMARY KEY NOT NULL,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        parent_id   TEXT NULL REFERENCES org_nodes(id),
        name        TEXT NOT NULL,
        role        TEXT NOT NULL CHECK (role IN ('owner', 'top_manager', 'sub_manager', 'member')),
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        CHECK (length(trim(name)) > 0)
      );

      -- 每项目根层最多一个节点（顶端 = 顶层 manager 岗位，#24：顶层唯一性由根位置推导）。
      CREATE UNIQUE INDEX ux_org_nodes_single_root
        ON org_nodes (project_id)
        WHERE parent_id IS NULL;
      CREATE INDEX ix_org_nodes_project ON org_nodes (project_id);
      CREATE INDEX ix_org_nodes_parent  ON org_nodes (parent_id);

      -- 成员「占据」岗位：node_id 为刚性外键锚点（#24）；ON DELETE SET NULL 保证
      -- 删岗位不误删成员——岗位被删只腾出岗位（成员回到未落位态），成员本身保留。
      ALTER TABLE members ADD COLUMN node_id TEXT REFERENCES org_nodes(id) ON DELETE SET NULL;

      -- 一人一岗、一岗一实例（AC-ORG-05：同一 agent 同项目只占一岗位由 members 本身唯一 + 此索引）。
      CREATE UNIQUE INDEX ux_members_node
        ON members (node_id)
        WHERE node_id IS NOT NULL;

      -- #24 迁移步骤：旧「每项目至多一个 manager」部分唯一索引与多层树冲突，删除；
      -- 阶段 1 兼容语义（legacy role='manager' 唯一）改由 members repository 应用层校验，
      -- 保证升级路径与 e2e-phase1 行为不变。回填岗位**不自动执行**：
      -- 升级后的库默认无组织树数据（票面硬约束），由人经 WebUI/API 建立（ORG-08）。
      DROP INDEX ux_members_project_manager;
    `,
  },
  {
    version: 5,
    name: "member_lifecycle_status",
    up: `
      -- T3（#50）成员生命周期状态（LIFE-MEM-01/02/03；决策票 #27）。
      --
      -- active / disabled / pending 是「成员在不在岗」的**持久化标记**：
      --   active   = 正常在岗；
      --   disabled = 已暂停/停用（保留身份、历史、数据、岗位与群组参与，不物理删除）；
      --   pending  = 待激活（已登记、尚未正式在岗）。
      -- 与 member_statuses（online/offline/waiting/working 运行状态）、mcp_sessions
      -- （连接/心跳状态）分开建模：断连不删除成员、不改写本列（LIFE-MEM-03）。
      -- 只加列 + CHECK + 列表索引：老库一律默认 active（阶段 1 行为不回归），
      -- 不回填业务数据、不删任何行；disable/re-enable 的状态机在 members repository。
      ALTER TABLE members ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled', 'pending'));

      CREATE INDEX ix_members_project_status ON members (project_id, status);
    `,
  },
  {
    version: 6,
    name: "init_audit_log",
    up: `
      -- T5（#52）最小审计单表（决策票 #30 的结论；spec #45 §6.7 / §8.2 AC-PROJ-AUDIT-01）。
      --
      -- 复用普通表、append-only、不引入审计子系统。记录关键操作
      -- （成员增删/暂停恢复、组织变更、项目/群组归档恢复/永久删除），
      -- 每条含 actor / action / target(scope) / timestamp，以及足以撤销的
      -- before / after 最小全量快照与字段级 changed diff。
      --
      -- 关键设计（#30）：
      --  * 无外键（含不指向 projects/members/org_nodes/groups）：项目/群组被永久删除后
      --    审计痕迹仍在；也不进入 #28 的 PROJECT_SCOPED_TABLES 级联删除注册表。
      --  * id 为时间有序 ULID（复用阶段 1 newId），可作列表游标与「最近一条」判定。
      --  * 索引不写 DESC，排序在查询里做，保证 SQLite/PostgreSQL 双引擎可移植。
      --  * 历史行除 reversed_at / reversed_by_audit_id 两列外永不改写；
      --    撤销本身写一条新行（reversed_by_audit_id 指向被撤销事件）。
      --  * 老库升级后为空表（无历史回填），既有数据不受影响。
      CREATE TABLE audit_log (
        id                   TEXT PRIMARY KEY NOT NULL,
        project_id           TEXT NOT NULL,
        actor_kind           TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'system')),
        actor_member_id      TEXT,
        actor_name           TEXT NOT NULL,
        action               TEXT NOT NULL,
        target_kind          TEXT NOT NULL CHECK (target_kind IN ('member', 'node', 'role', 'capability', 'group', 'project')),
        target_id            TEXT NOT NULL,
        target_name          TEXT NOT NULL,
        changed              TEXT,
        before               TEXT,
        after                TEXT,
        detail               TEXT,
        reversed_at          TEXT,
        reversed_by_audit_id TEXT,
        created_at           TEXT NOT NULL
      );

      CREATE INDEX ix_audit_project_created ON audit_log (project_id, created_at, id);
      CREATE INDEX ix_audit_project_target  ON audit_log (project_id, target_kind, target_id, id);
      CREATE INDEX ix_audit_project_action  ON audit_log (project_id, action);
    `,
  },
  durableMessageDispatch,
  managedRuntime,
  runtimeObservabilityMigration,
  runtimeProcessIdentityMigration,
  tasksMigration,
  memoryMigration,
  memberLifecycleMigration,
  identityCatalogMigration,
  projectWorkspacesMigration,
  taskIntakeMigration,
  policyConfigurationMigration,
  storageMaintenanceMigration,
  mcpConnectionsMigration,
  decisionsMigration,
  workEventDeliveryInvalidationsMigration,
];
