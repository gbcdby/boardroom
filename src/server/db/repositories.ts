import type Database from "better-sqlite3";
import {
  ArchivedError,
  ConflictError,
  InvalidArgumentError,
  InvalidReferenceError,
  NotFoundError,
  RepositoryError,
  WriteFailedError,
} from "./errors.ts";
import { newId } from "./ids.ts";
import {
  createAuditRepository,
  type AuditRepository,
} from "../audit.ts";
import type {
  Agent,
  DeliveryStatus,
  Group,
  McpSession,
  McpSessionState,
  Member,
  MemberLifecycleStatus,
  MemberRole,
  MemberState,
  MemberStatus,
  Message,
  MessageDelivery,
  NewAgent,
  NewGroup,
  NewMember,
  NewMessage,
  NewOrgNode,
  NewProject,
  OrgNode,
  OrgNodeRole,
  Project,
} from "./types.ts";

/**
 * F2 repository 层：数据库持久化的数据访问边界，供 T1–T7 复用。
 *
 * 约定：
 * - 所有写操作通过 {@link RepositorySet.transaction} 或内置单条事务执行；
 *   底层写入失败归一为 {@link WriteFailedError}，不静默吞错。
 * - 跨实体引用（成员属于项目、群组参与者属于同项目、发送者是参与者等）在此校验，
 *   给出明确错误，而不是依赖数据库外键的泛化报错。
 * - 只持久化可恢复字段；不存运行时对象（连接、定时器）。
 */

export interface MessageListOptions {
  /** 只返回 seq 大于该值的消息（游标分页）。 */
  readonly afterSeq?: number;
  /** 返回条数上限。 */
  readonly limit?: number;
}

/** 归档态列表的通用收窄选项（#48：默认只看未归档对象）。 */
export interface ListOptions {
  /** true = 连已归档行一起返回；缺省 false 只返回未归档行。 */
  readonly includeArchived?: boolean;
}

export interface AgentsRepository {
  create(input: NewAgent): Agent;
  /** 以完整字段插入（含外部提供的 ID），重复 ID 报 ConflictError。 */
  insertRaw(agent: Agent): Agent;
  get(id: string): Agent | null;
  /**
   * 按全局身份键（displayName + hostType）查找 agent（T2 身份唯一性）。
   * 命中返回已有 agent；未命中返回 null，由调用方决定创建。
   */
  findByIdentity(displayName: string, hostType: string): Agent | null;
  list(): Agent[];
  update(id: string, patch: Partial<Pick<Agent, "displayName" | "hostType">>): Agent;
  touchLastSeen(id: string, at: string): Agent;
  delete(id: string): void;
}

/**
 * 永久删除的级联清单（#48 / LIFE-ARC-02）：删除前给人看的「会被清掉什么」，
 * 删除后作为实际清除的行数返回。口径 = 当前已落库的范围（阶段 1/2）；
 * 任务、评论、记忆分别在阶段 3、阶段 4 落库，届时按同一形状补进清单。
 */
export interface PurgeCounts {
  readonly groups: number;
  readonly members: number;
  /** T2 #49：项目组织岗位节点（随项目一起清除，成员先删避免悬空占岗外键）。 */
  readonly orgNodes: number;
  readonly messages: number;
  readonly deliveries: number;
  readonly memberStatuses: number;
  readonly mcpSessions: number;
}

/** 群组级联清单（#48）：删群组只清群聊与参与者关系，**不动成员本身**。 */
export interface GroupPurgeCounts {
  readonly messages: number;
  readonly deliveries: number;
  readonly participants: number;
  readonly mcpSessions: number;
}

export interface ProjectsRepository {
  create(input: NewProject): Project;
  get(id: string): Project | null;
  /** 默认只列**未归档**项目；`includeArchived` 时连归档项目一起返回（#48 / PROJECT-03）。 */
  list(options?: ListOptions): Project[];
  rename(id: string, name: string): Project;
  /** 归档：写入归档时间；已归档时幂等返回（可恢复，不删数据）。 */
  archive(id: string, at?: string): Project;
  /** 恢复：清除归档时间；未归档时幂等返回。 */
  restore(id: string): Project;
  /** 永久删除前的级联清单（只读，不改数据）。项目不存在时抛 NotFoundError。 */
  previewPurge(id: string): PurgeCounts;
  /**
   * 永久删除项目：在**单个事务**内按「子 → 父」顺序级联清除群组、群聊消息、投递、
   * 参与者关系、成员、成员状态与 MCP 会话，最后删项目本身；返回实际清除的行数。
   * 只应在人二次确认后由入口调用（PROJECT-03）：agent 主体没有 `project:purge` 能力点。
   */
  purge(id: string): PurgeCounts;
  delete(id: string): void;
}

export interface MembersRepository {
  create(input: NewMember): Member;
  get(id: string): Member | null;
  listByProject(projectId: string): Member[];
  /** 查找某 agent 在某项目中的成员关系（T2 幂等入群）。 */
  findByAgent(projectId: string, agentId: string): Member | null;
  getManager(projectId: string): Member | null;
  update(id: string, patch: Partial<Pick<Member, "displayName" | "role">>): Member;
  /**
   * T3（#50）成员状态机：在合法转换表内切换生命周期状态。
   * 只更新 `status` 与 `updated_at`，**不物理删除成员、不动岗位(node_id)/历史/数据/
   * 群组参与/运行状态/连接状态**（LIFE-MEM-01/02/03）。
   * - 同态 = 幂等 no-op；非法转换 → ConflictError；未知状态 → InvalidArgumentError；
   *   成员不存在 → NotFoundError；归档项目 → ArchivedError（复用 T1 归档写规则）。
   */
  setStatus(id: string, status: MemberLifecycleStatus): Member;
  delete(id: string): void;
  /**
   * T5（#52）撤销补偿：按 `before` 全量快照**直接复原**成员行（upsert）。
   * 专供撤销入口在单事务内调用：故意绕过 `setStatus` 的单向转换表与
   * `requireNoOtherManager` 约束，因为补偿恢复的是「已确认存在的历史状态」，
   * 不是一次新的前向业务变更。FK/唯一约束仍由数据库把关。
   */
  restoreRow(member: Member): void;
}

/**
 * 组织树 repository（T2 #49 / 决策票 #24）。
 *
 * 唯一写入边界，规则与 #45 §6.2 对应：
 * - 根岗位（`parent_id IS NULL`）每项目最多一个，位置即「顶层 manager 岗位」（ORG-01）；
 * - 角色是静态枚举，写在**岗位**上（角色与岗位分离）；`owner` 不建岗（人是全局主体）；
 * - 汇报线调整应用层防环（#24：目标父不能是自身或自身子孙，无深度上限）；
 * - 删除岗位时**子树提升到父**，占据成员腾出岗位但成员保留（`ON DELETE SET NULL`）；
 * - 一人一岗、一岗一实例（`ux_members_node`，AC-ORG-05）。
 */
export interface OrgRepository {
  createNode(input: NewOrgNode): OrgNode;
  getNode(id: string): OrgNode | null;
  /** 项目全部岗位（层级展示顺序：父 → 子，同级按 sort_order）。 */
  listNodes(projectId: string): OrgNode[];
  getRootNode(projectId: string): OrgNode | null;
  /**
   * 某节点的子树节点 id 集合（**含自身**）。
   * SQLite/PG 通用的 `WITH RECURSIVE` CTE 现算（#24：本地量小不建闭包表）；
   * 节点不存在时返回空数组。
   */
  subtreeNodeIds(nodeId: string): string[];
  /** 改岗位：改名 / 改角色 / 调整汇报线 / 排序。防环与根规则在这里统一把关。 */
  updateNode(id: string, patch: Partial<Pick<OrgNode, "name" | "role" | "parentId" | "sortOrder">>): OrgNode;
  /** 删除岗位：直接子节点提升到本节点的父；占据成员回到未落位。 */
  deleteNode(id: string): void;
  /**
   * 成员占据/腾出岗位（`nodeId = null` 为腾出）。ORG-02/08：manager 分配、人可调整。
   * 同步阶段 1 兼容投影：占据顶层岗 → legacy `role='manager'`（旧 manager 降 normal）；
   * 让出顶层岗 → 归还 normal。保证升级路径与 T1 API（`PUT /manager`、projectView）一致。
   */
  assignNode(memberId: string, nodeId: string | null): Member;
  /**
   * manager 自动分配新成员岗位（ORG-02）：项目**已有组织树**时，在根下建一个
   * `member` 岗（名称取成员展示名）并让该成员占据；项目尚无组织树时返回 null
   * ——不自动造树，保证阶段 1 兼容路径与既有行为不变（人可另行独立创建，ORG-08）。
   * 成员已落位时幂等返回其现有岗位。
   */
  autoPlaceMember(projectId: string, memberId: string): OrgNode | null;
  /** 某成员当前占据的岗位（未落位返回 null）。 */
  nodeOfMember(memberId: string): OrgNode | null;
  /**
   * T5（#52）撤销补偿：按 `before` 全量快照直接复原岗位行（upsert）。
   * 绕过前向的防环/根唯一校验——补偿恢复的是已存在的历史状态，
   * 余下约束（父指针外键、单根唯一索引）仍由数据库把关。
   */
  restoreRow(node: OrgNode): void;
}

export interface GroupsRepository {
  create(input: NewGroup): Group;
  get(id: string): Group | null;
  /** 默认只列**未归档**群组；`includeArchived` 时连归档群组一起返回（#48 / GROUP-04）。 */
  listByProject(projectId: string, options?: ListOptions): Group[];
  /** 归档（可恢复）：写入归档时间；已归档时幂等。 */
  archive(id: string, at?: string): Group;
  /** 恢复：清除归档时间；未归档时幂等。 */
  restore(id: string): Group;
  /** 永久删除前的级联清单（只读）。群组不存在时抛 NotFoundError。 */
  previewPurge(id: string): GroupPurgeCounts;
  /**
   * 永久删除群组（#48 / GROUP-04、LIFE-ARC-02）：单事务内清除**该群组的群聊**
   * （消息与投递记录）、**参与者关系**，以及随群组消失的连接会话记录。
   * 项目成员本身**不动**——这是与 {@link ProjectsRepository.purge} 的关键差别。
   */
  purge(id: string): GroupPurgeCounts;
  participants(groupId: string): string[];
  addParticipant(groupId: string, memberId: string): void;
  removeParticipant(groupId: string, memberId: string): void;
  /**
   * T5（#52）撤销补偿：直接补回一条参与者关系（INSERT OR IGNORE），
   * 故意不跑 `requireGroupActive`——撤销复原的是删除前的历史参与事实。
   */
  restoreParticipant(groupId: string, memberId: string): void;
  delete(id: string): void;
}

export interface MessagesRepository {
  create(input: NewMessage): Message;
  get(id: string): Message | null;
  listByGroup(groupId: string, options?: MessageListOptions): Message[];
}

export interface DeliveriesRepository {
  /** 确保 (message, member) 的投递记录存在（不存在则建 pending）；幂等去重。 */
  ensure(messageId: string, memberId: string): MessageDelivery;
  get(messageId: string, memberId: string): MessageDelivery | null;
  /** 记录一次投递尝试并更新状态；不存在则先 ensure。 */
  recordAttempt(messageId: string, memberId: string, status: DeliveryStatus, at?: string): MessageDelivery;
  /**
   * 某成员在项目中**尚未完成**（未 acked）的积压，按群组 seq 排序。
   *
   * 「未完成」包含 pending 与 delivered——两者都还没被客户端确认。这样至少一次投递的
   * 重连补发才能重投「已投递但未确认」的消息（NFR-02）；只有 acked 才视为不需要再投。
   */
  listPending(projectId: string, memberId: string): MessageDelivery[];
  delete(messageId: string, memberId: string): void;
}

export interface StatusesRepository {
  /** upsert 项目成员状态。 */
  set(projectId: string, memberId: string, state: MemberState): MemberStatus;
  get(projectId: string, memberId: string): MemberStatus | null;
  listByProject(projectId: string): MemberStatus[];
  delete(projectId: string, memberId: string): void;
}

/**
 * MCP 会话连接状态（T2，全局层 D1）。持久化可恢复部分，与 member_statuses 分开。
 * 连接是否存活由运行时按心跳推导；本 repository 只记录状态与时间戳。
 */
export interface McpSessionsRepository {
  /** 建立/恢复一个活跃会话：若同 agent+project+group 已有 connected 会话则复用其 id。 */
  connect(input: {
    agentId: string;
    projectId: string;
    groupId: string;
    memberId: string;
    displayName: string;
    hostType: string;
  }): McpSession;
  /** 按会话 id 查找。 */
  get(id: string): McpSession | null;
  /** 查找某 agent 在某项目/群组的活跃（connected）会话。 */
  findActive(agentId: string, projectId: string, groupId: string): McpSession | null;
  /** 某项目下所有会话（含断开的历史会话），用于成员在线视图。 */
  listByProject(projectId: string): McpSession[];
  /** 记录一次心跳时间（不改变 state）。 */
  heartbeat(id: string, at: string): McpSession;
  /** 把会话标记为断开（未连接时幂等）。 */
  disconnect(id: string, at: string): McpSession;
  /** 启动时把所有仍为 connected 的会话标记为 disconnected（进程重启后连接已失效）。 */
  markAllStale(at: string): number;
  delete(id: string): void;
}

export interface RepositorySet {
  readonly agents: AgentsRepository;
  readonly projects: ProjectsRepository;
  readonly members: MembersRepository;
  /** T2 #49：组织树唯一写入边界（递归 CTE 子树、占岗、自动落位）。 */
  readonly org: OrgRepository;
  readonly groups: GroupsRepository;
  readonly messages: MessagesRepository;
  readonly deliveries: DeliveriesRepository;
  readonly statuses: StatusesRepository;
  readonly mcpSessions: McpSessionsRepository;
  /** T5（#52）：最小审计单表仓储（append-only + 撤销两列回写）。 */
  readonly audit: AuditRepository;
  /** 在单个写事务内运行 fn；失败回滚并抛出归一化后的错误。 */
  transaction<T>(fn: () => T): T;
}

const MEMBER_ROLES: readonly MemberRole[] = ["manager", "normal"];
const MEMBER_STATES: readonly MemberState[] = ["online", "offline", "waiting", "working"];
const DELIVERY_STATUSES: readonly DeliveryStatus[] = ["pending", "delivered", "acked"];

/** T3（#50）：成员生命周期枚举（与迁移 v5 的 CHECK 约束一致）。 */
const MEMBER_LIFECYCLE_STATUSES: readonly MemberLifecycleStatus[] = ["active", "disabled", "pending"];

/**
 * T3（#50）状态机合法转换表（fail-closed：表外转换一律拒绝）。
 *
 * - `pending` 是创建时的「待激活」初态：可激活（→active）或暂停（→disabled），激活后不再回到 pending。
 * - `active ↔ disabled` 是「暂停 / 恢复」闭环：disabled **只能先 re-enable 回 active**
 *   （恢复岗位，LIFE-MEM-02），不能直接跳到 pending；active 也不能直接退回 pending。
 * - 任何转换都不删除成员行（可恢复、不物理删除，LIFE-MEM-01）。
 */
const MEMBER_STATUS_TRANSITIONS: Readonly<Record<MemberLifecycleStatus, readonly MemberLifecycleStatus[]>> = {
  active: ["disabled"],
  disabled: ["active"],
  pending: ["active", "disabled"],
};

/** 创建 repository 集合；同一 db 连接共享。 */
export function createRepositories(db: Database.Database): RepositorySet {
  return {
    agents: createAgents(db),
    projects: createProjects(db),
    members: createMembers(db),
    org: createOrg(db),
    groups: createGroups(db),
    messages: createMessages(db),
    deliveries: createDeliveries(db),
    statuses: createStatuses(db),
    mcpSessions: createMcpSessions(db),
    audit: createAuditRepository(db),
    transaction: (fn) => runInTransaction(db, fn),
  };
}

// ---------------------------------------------------------------------------
// 事务 & 错误归一
// ---------------------------------------------------------------------------

function runInTransaction<T>(db: Database.Database, fn: () => T): T {
  // 嵌套调用时用保存点，保证内层失败只回滚内层。
  const savepoint = db.inTransaction;
  const name = `sp_${Math.floor(Math.random() * 1e9).toString(36)}`;
  try {
    db.exec(savepoint ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
    const result = fn();
    db.exec(savepoint ? `RELEASE ${name}` : "COMMIT");
    return result;
  } catch (error) {
    try {
      if (savepoint) {
        db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      } else {
        db.exec("ROLLBACK");
      }
    } catch {
      // 回滚本身失败时不再抛，避免掩盖原始错误（原始 error 会在下方重新抛出）。
      // 事务可能已被数据库自动结束，或连接已关闭。
    }
    throw normalizeError(error);
  }
}

/**
 * 把底层错误归一到持久化层错误类型。已知业务错误原样抛出；
 * SQLite 约束/只读/闭合等错误映射为对应语义；其余视为写入失败。
 */
function normalizeError(error: unknown): RepositoryError {
  if (error instanceof RepositoryError) return error;
  const err = error as { code?: string; message?: string };
  const code = err?.code ?? "";
  const message = err?.message ?? String(error);
  if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
    return new ConflictError(`唯一约束冲突：${message}`, error);
  }
  if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
    return new InvalidReferenceError(`外键约束失败：${message}`, error);
  }
  if (code.startsWith("SQLITE_CONSTRAINT")) {
    return new InvalidArgumentError(`约束校验失败：${message}`, error);
  }
  return new WriteFailedError(`写入数据库失败：${message}`, error);
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidArgumentError(`${field} 不能为空。`);
  }
  return value;
}

/**
 * 归档态写检查（#48 / PROJECT-03、GROUP-04）。
 *
 * 归档 = **可恢复的非活跃态**：不删数据、历史仍可读，但拒绝新写入。
 * 强制点放在 repository 这一唯一的写入边界上，HTTP（人）与 MCP（agent）两个入口
 * 因此共享同一条规则，不依赖调用方自律。
 */
function requireProjectActive(db: Database.Database, projectId: string, action: string): void {
  const row = db
    .prepare("SELECT archived_at FROM projects WHERE id = ?")
    .get(projectId) as { archived_at: string | null } | undefined;
  if (row?.archived_at != null) {
    throw new ArchivedError(`项目已归档，不能${action}；如需继续，请先恢复该项目。`);
  }
}

/** 同 {@link requireProjectActive}，但面向群组：群组自身或其所属项目归档即拒绝写入。 */
function requireGroupActive(db: Database.Database, groupId: string, action: string): void {
  const row = db
    .prepare(
      `SELECT g.archived_at AS group_archived, p.archived_at AS project_archived
         FROM groups g JOIN projects p ON p.id = g.project_id
        WHERE g.id = ?`,
    )
    .get(groupId) as { group_archived: string | null; project_archived: string | null } | undefined;
  if (row === undefined) return; // 群组不存在由调用方各自的引用校验负责，这里不重复报错。
  if (row.group_archived != null) {
    throw new ArchivedError(`群组已归档，不能${action}；如需继续，请先恢复该群组。`);
  }
  if (row.project_archived != null) {
    throw new ArchivedError(`项目已归档，不能${action}；如需继续，请先恢复该项目。`);
  }
}

/**
 * 永久删除项目时会波及的行数清单（#48 / LIFE-ARC-02）。
 * 只读；与 {@link ProjectsRepository.purge} 的删除顺序一一对应。
 */
function projectPurgeCounts(db: Database.Database, projectId: string): PurgeCounts {
  const count = (sql: string): number => (db.prepare(sql).get(projectId) as { c: number }).c;
  return {
    groups: count("SELECT COUNT(*) AS c FROM groups WHERE project_id = ?"),
    members: count("SELECT COUNT(*) AS c FROM members WHERE project_id = ?"),
    orgNodes: count("SELECT COUNT(*) AS c FROM org_nodes WHERE project_id = ?"),
    messages: count(
      "SELECT COUNT(*) AS c FROM messages m WHERE m.group_id IN (SELECT id FROM groups WHERE project_id = ?)",
    ),
    deliveries: count("SELECT COUNT(*) AS c FROM message_deliveries WHERE project_id = ?"),
    memberStatuses: count("SELECT COUNT(*) AS c FROM member_statuses WHERE project_id = ?"),
    mcpSessions: count("SELECT COUNT(*) AS c FROM mcp_sessions WHERE project_id = ?"),
  };
}

/**
 * 永久删除群组时会波及的行数清单（#48 / LIFE-ARC-02）。
 * 口径只含群聊与参与者关系（外加随群组消失的会话记录），**不含成员**。
 */
function groupPurgeCounts(db: Database.Database, groupId: string): GroupPurgeCounts {
  const count = (sql: string): number => (db.prepare(sql).get(groupId) as { c: number }).c;
  return {
    messages: count("SELECT COUNT(*) AS c FROM messages WHERE group_id = ?"),
    deliveries: count(
      "SELECT COUNT(*) AS c FROM message_deliveries WHERE message_id IN (SELECT id FROM messages WHERE group_id = ?)",
    ),
    participants: count("SELECT COUNT(*) AS c FROM group_participants WHERE group_id = ?"),
    mcpSessions: count("SELECT COUNT(*) AS c FROM mcp_sessions WHERE group_id = ?"),
  };
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    displayName: row.display_name,
    hostType: row.host_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}

interface AgentRow {
  id: string;
  display_name: string;
  host_type: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

function createAgents(db: Database.Database): AgentsRepository {
  const insert = db.prepare(
    `INSERT INTO agents (id, display_name, host_type, created_at, updated_at, last_seen_at)
     VALUES (@id, @display_name, @host_type, @created_at, @updated_at, @last_seen_at)`,
  );

  const insertRow = (agent: Agent): void => {
    try {
      insert.run({
        id: agent.id,
        display_name: agent.displayName,
        host_type: agent.hostType,
        created_at: agent.createdAt,
        updated_at: agent.updatedAt,
        last_seen_at: agent.lastSeenAt,
      });
    } catch (error) {
      throw normalizeError(error);
    }
  };

  return {
    create(input) {
      const displayName = requireNonEmpty(input.displayName, "Agent.displayName");
      const hostType = requireNonEmpty(input.hostType, "Agent.hostType");
      const at = nowIso();
      const agent: Agent = {
        id: newId(),
        displayName,
        hostType,
        createdAt: at,
        updatedAt: at,
        lastSeenAt: null,
      };
      runInTransaction(db, () => insertRow(agent));
      return agent;
    },
    insertRaw(agent) {
      insertRow(agent);
      return agent;
    },
    get(id) {
      const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
      return row ? toAgent(row) : null;
    },
    findByIdentity(displayName, hostType) {
      const row = db
        .prepare("SELECT * FROM agents WHERE display_name = ? AND host_type = ?")
        .get(displayName, hostType) as AgentRow | undefined;
      return row ? toAgent(row) : null;
    },
    list() {
      return (db.prepare("SELECT * FROM agents ORDER BY created_at, id").all() as AgentRow[]).map(toAgent);
    },
    update(id, patch) {
      const existing = this.get(id);
      if (!existing) throw new NotFoundError(`Agent ${id} 不存在。`);
      const displayName =
        patch.displayName === undefined ? existing.displayName : requireNonEmpty(patch.displayName, "Agent.displayName");
      const hostType =
        patch.hostType === undefined ? existing.hostType : requireNonEmpty(patch.hostType, "Agent.hostType");
      runInTransaction(db, () =>
        db
          .prepare("UPDATE agents SET display_name = ?, host_type = ?, updated_at = ? WHERE id = ?")
          .run(displayName, hostType, nowIso(), id),
      );
      return this.get(id)!;
    },
    touchLastSeen(id, at) {
      const existing = this.get(id);
      if (!existing) throw new NotFoundError(`Agent ${id} 不存在。`);
      runInTransaction(db, () =>
        db.prepare("UPDATE agents SET last_seen_at = ?, updated_at = ? WHERE id = ?").run(at, nowIso(), id),
      );
      return this.get(id)!;
    },
    delete(id) {
      const result = db.prepare("DELETE FROM agents WHERE id = ?").run(id);
      if (result.changes === 0) throw new NotFoundError(`Agent ${id} 不存在。`);
    },
  };
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? null,
  };
}

function createProjects(db: Database.Database): ProjectsRepository {
  return {
    create(input) {
      const name = requireNonEmpty(input.name, "Project.name");
      // 创建时指定顶层 manager（#48 / PROJECT-02）：agent 必须已存在，否则整体拒绝，
      // 不留半个项目（引用校验放在写入之前）。
      const managerAgentId = input.managerAgentId ?? null;
      let managerName: string | null = null;
      if (managerAgentId !== null) {
        const agent = db
          .prepare("SELECT display_name FROM agents WHERE id = ?")
          .get(managerAgentId) as { display_name: string } | undefined;
        if (!agent) {
          throw new InvalidReferenceError(
            `Agent ${managerAgentId} 不存在，无法在创建项目时指定为顶层 manager。`,
          );
        }
        managerName = agent.display_name;
      }
      const at = nowIso();
      const project: Project = { id: newId(), name, createdAt: at, updatedAt: at, archivedAt: null };
      runInTransaction(db, () => {
        db
          .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
          .run(project.id, project.name, project.createdAt, project.updatedAt);
        if (managerAgentId !== null && managerName !== null) {
          db.prepare(
            `INSERT INTO members (id, project_id, agent_id, kind, display_name, role, created_at, updated_at)
             VALUES (?, ?, ?, 'agent', ?, 'manager', ?, ?)`,
          ).run(newId(), project.id, managerAgentId, managerName, at, at);
        }
      });
      return project;
    },
    get(id) {
      const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
      return row ? toProject(row) : null;
    },
    list(options = {}) {
      const where = options.includeArchived ? "" : "WHERE archived_at IS NULL";
      return (
        db.prepare(`SELECT * FROM projects ${where} ORDER BY created_at, id`).all() as ProjectRow[]
      ).map(toProject);
    },
    rename(id, name) {
      const value = requireNonEmpty(name, "Project.name");
      const result = db
        .prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?")
        .run(value, nowIso(), id);
      if (result.changes === 0) throw new NotFoundError(`Project ${id} 不存在。`);
      return this.get(id)!;
    },
    archive(id, at) {
      const existing = this.get(id);
      if (!existing) throw new NotFoundError(`Project ${id} 不存在。`);
      if (existing.archivedAt !== null) return existing;
      const stamp = at ?? nowIso();
      runInTransaction(db, () =>
        db.prepare("UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?").run(stamp, stamp, id),
      );
      return this.get(id)!;
    },
    restore(id) {
      const existing = this.get(id);
      if (!existing) throw new NotFoundError(`Project ${id} 不存在。`);
      if (existing.archivedAt === null) return existing;
      runInTransaction(db, () =>
        db.prepare("UPDATE projects SET archived_at = NULL, updated_at = ? WHERE id = ?").run(nowIso(), id),
      );
      return this.get(id)!;
    },
    previewPurge(id) {
      if (!this.get(id)) throw new NotFoundError(`Project ${id} 不存在。`);
      return projectPurgeCounts(db, id);
    },
    purge(id) {
      if (!this.get(id)) throw new NotFoundError(`Project ${id} 不存在。`);
      const counts = projectPurgeCounts(db, id);
      runInTransaction(db, () => {
        // 显式「子 → 父」顺序，而不是只依赖外键级联：清单与实际清除的行必须一一对得上，
        // 也让 PG 重写（M1 #54）时不依赖特定级联顺序。
        db.prepare("DELETE FROM message_deliveries WHERE project_id = ?").run(id);
        db
          .prepare("DELETE FROM messages WHERE group_id IN (SELECT id FROM groups WHERE project_id = ?)")
          .run(id);
        db
          .prepare("DELETE FROM group_participants WHERE group_id IN (SELECT id FROM groups WHERE project_id = ?)")
          .run(id);
        db.prepare("DELETE FROM groups WHERE project_id = ?").run(id);
        db.prepare("DELETE FROM mcp_sessions WHERE project_id = ?").run(id);
        db.prepare("DELETE FROM member_statuses WHERE project_id = ?").run(id);
        db.prepare("DELETE FROM members WHERE project_id = ?").run(id);
        // T2 #49：members 先删（node_id 外键指向 org_nodes），再清组织岗位，避免悬空引用。
        db.prepare("DELETE FROM org_nodes WHERE project_id = ?").run(id);
        const removed = db.prepare("DELETE FROM projects WHERE id = ?").run(id);
        if (removed.changes === 0) throw new NotFoundError(`Project ${id} 不存在。`);
      });
      return counts;
    },
    delete(id) {
      const result = db.prepare("DELETE FROM projects WHERE id = ?").run(id);
      if (result.changes === 0) throw new NotFoundError(`Project ${id} 不存在。`);
    },
  };
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

interface MemberRow {
  id: string;
  project_id: string;
  agent_id: string | null;
  kind: string;
  display_name: string;
  role: string;
  node_id: string | null;
  /** T3 #50：生命周期状态（迁移 v5 起恒存在，默认 active）。 */
  status: string;
  created_at: string;
  updated_at: string;
}

function toMember(row: MemberRow): Member {
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    kind: row.kind as Member["kind"],
    displayName: row.display_name,
    role: row.role as MemberRole,
    nodeId: row.node_id ?? null,
    status: row.status as MemberLifecycleStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createMembers(db: Database.Database): MembersRepository {
  const projectExists = db.prepare("SELECT 1 FROM projects WHERE id = ?");
  const agentExists = db.prepare("SELECT 1 FROM agents WHERE id = ?");
  /**
   * 阶段 1 兼容投影的唯一性（D2「每项目最多一个顶层 manager」）。
   * 原 `ux_members_project_manager` 部分唯一索引已按决策票 #24 移除（与多层树冲突），
   * 不变量下沉到这条查询——legacy `role='manager'` 只作为阶段 1 兼容与
   * `PUT /api/projects/:id/manager`、`projectView.manager` 的投影存在；
   * 真实顶层岗位由组织树根节点（`org_nodes`，`role='top_manager'`）表达。
   */
  const otherManager = db.prepare(
    "SELECT id FROM members WHERE project_id = ? AND role = 'manager' AND id <> ? LIMIT 1",
  );

  function requireNoOtherManager(projectId: string, selfId: string): void {
    const clash = otherManager.get(projectId, selfId) as { id: string } | undefined;
    if (clash) {
      throw new ConflictError(
        `项目 ${projectId} 已有顶层 manager（成员 ${clash.id}）；阶段 1 语义下每项目最多一个，请先更换。`,
      );
    }
  }

  const repo: MembersRepository = {
    create(input) {
      if (!projectExists.get(input.projectId)) {
        throw new InvalidReferenceError(`项目 ${input.projectId} 不存在，无法添加成员。`);
      }
      requireProjectActive(db, input.projectId, "添加项目成员");
      const displayName = requireNonEmpty(input.displayName, "Member.displayName");
      if (input.kind !== "agent" && input.kind !== "human") {
        throw new InvalidArgumentError(`Member.kind 必须是 agent 或 human，收到：${String(input.kind)}。`);
      }
      let agentId: string | null = input.agentId ?? null;
      if (input.kind === "agent") {
        if (agentId === null) {
          throw new InvalidArgumentError("agent 类型成员必须提供 agentId。");
        }
        if (!agentExists.get(agentId)) {
          throw new InvalidReferenceError(`Agent ${agentId} 不存在，无法作为成员加入。`);
        }
      } else if (agentId !== null) {
        throw new InvalidArgumentError("human 类型成员不能绑定 agentId。");
      }
      const role: MemberRole = input.role ?? "normal";
      if (!MEMBER_ROLES.includes(role)) {
        throw new InvalidArgumentError(`Member.role 必须是 manager 或 normal，收到：${String(input.role)}。`);
      }
      const status: MemberLifecycleStatus = input.status ?? "active";
      if (!MEMBER_LIFECYCLE_STATUSES.includes(status)) {
        throw new InvalidArgumentError(`Member.status 必须是 active/disabled/pending，收到：${String(input.status)}。`);
      }
      const at = nowIso();
      const id = newId();
      runInTransaction(db, () => {
        if (role === "manager") requireNoOtherManager(input.projectId, id);
        db
          .prepare(
            `INSERT INTO members (id, project_id, agent_id, kind, display_name, role, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, input.projectId, agentId, input.kind, displayName, role, status, at, at);
      });
      return repo.get(id)!;
    },
    get(id) {
      const row = db.prepare("SELECT * FROM members WHERE id = ?").get(id) as MemberRow | undefined;
      return row ? toMember(row) : null;
    },
    listByProject(projectId) {
      return (
        db.prepare("SELECT * FROM members WHERE project_id = ? ORDER BY created_at, id").all(projectId) as MemberRow[]
      ).map(toMember);
    },
    findByAgent(projectId, agentId) {
      const row = db
        .prepare("SELECT * FROM members WHERE project_id = ? AND agent_id = ?")
        .get(projectId, agentId) as MemberRow | undefined;
      return row ? toMember(row) : null;
    },
    getManager(projectId) {
      const row = db
        .prepare("SELECT * FROM members WHERE project_id = ? AND role = 'manager'")
        .get(projectId) as MemberRow | undefined;
      return row ? toMember(row) : null;
    },
    update(id, patch) {
      const existing = repo.get(id);
      if (!existing) throw new NotFoundError(`Member ${id} 不存在。`);
      requireProjectActive(db, existing.projectId, "修改项目成员");
      const displayName =
        patch.displayName === undefined
          ? existing.displayName
          : requireNonEmpty(patch.displayName, "Member.displayName");
      const role = patch.role ?? existing.role;
      if (!MEMBER_ROLES.includes(role)) {
        throw new InvalidArgumentError(`Member.role 必须是 manager 或 normal，收到：${String(patch.role)}。`);
      }
      runInTransaction(db, () => {
        if (role === "manager" && existing.role !== "manager") {
          requireNoOtherManager(existing.projectId, id);
        }
        db
          .prepare("UPDATE members SET display_name = ?, role = ?, updated_at = ? WHERE id = ?")
          .run(displayName, role, nowIso(), id);
      });
      return repo.get(id)!;
    },
    setStatus(id, status) {
      const existing = repo.get(id);
      if (!existing) throw new NotFoundError(`Member ${id} 不存在。`);
      if (!MEMBER_LIFECYCLE_STATUSES.includes(status)) {
        throw new InvalidArgumentError(`Member.status 必须是 active/disabled/pending，收到：${String(status)}。`);
      }
      // T1 #48：归档 = 非活跃态，写路径在 repository 这一唯一边界拒绝（与 members.update 同位）。
      requireProjectActive(db, existing.projectId, "修改项目成员状态");
      // 同态幂等：重复暂停/恢复不报错（ORG-07 无需逐次确认），且不改动任何数据。
      if (existing.status === status) return existing;
      if (!MEMBER_STATUS_TRANSITIONS[existing.status].includes(status)) {
        throw new ConflictError(
          `成员状态不能从 ${existing.status} 直接转换为 ${status}；disabled 只能先 re-enable 回 active，pending 为创建时的初态。`,
        );
      }
      // 只改 status 与 updated_at；岗位、历史、数据、群组参与、运行/连接状态一律不动
      // （disable 保留历史与数据、re-enable 恢复岗位，LIFE-MEM-01/02/03）。
      runInTransaction(db, () =>
        db.prepare("UPDATE members SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), id),
      );
      return repo.get(id)!;
    },
    delete(id) {
      const result = db.prepare("DELETE FROM members WHERE id = ?").run(id);
      if (result.changes === 0) throw new NotFoundError(`Member ${id} 不存在。`);
    },
    // T5 #52：按 before 快照直接复原成员行（撤销补偿，upsert）。
    restoreRow(member) {
      db.prepare(
        `INSERT INTO members
           (id, project_id, agent_id, kind, display_name, role, node_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id, agent_id = excluded.agent_id, kind = excluded.kind,
           display_name = excluded.display_name, role = excluded.role, node_id = excluded.node_id,
           status = excluded.status, created_at = excluded.created_at, updated_at = excluded.updated_at`,
      ).run(
        member.id, member.projectId, member.agentId, member.kind, member.displayName,
        member.role, member.nodeId, member.status, member.createdAt, member.updatedAt,
      );
    },
  };
  return repo;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

interface GroupRow {
  id: string;
  project_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

function toGroup(row: GroupRow): Group {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? null,
  };
}

function createGroups(db: Database.Database): GroupsRepository {
  const projectExists = db.prepare("SELECT 1 FROM projects WHERE id = ?");
  const memberInProject = db.prepare("SELECT 1 FROM members WHERE id = ? AND project_id = ?");
  const getGroupRow = (id: string) => db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as GroupRow | undefined;

  const repo: GroupsRepository = {
    create(input) {
      if (!projectExists.get(input.projectId)) {
        throw new InvalidReferenceError(`项目 ${input.projectId} 不存在，无法创建群组。`);
      }
      requireProjectActive(db, input.projectId, "在项目内创建群组");
      const name = requireNonEmpty(input.name, "Group.name");
      const participants = dedupe(input.participantMemberIds ?? []);
      for (const memberId of participants) {
        if (!memberInProject.get(memberId, input.projectId)) {
          throw new InvalidReferenceError(
            `成员 ${memberId} 不属于项目 ${input.projectId}，不能加入该群组。`,
          );
        }
      }
      const at = nowIso();
      const id = newId();
      runInTransaction(db, () => {
        db.prepare("INSERT INTO groups (id, project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
          id,
          input.projectId,
          name,
          at,
          at,
        );
        const add = db.prepare(
          "INSERT INTO group_participants (group_id, member_id, joined_at) VALUES (?, ?, ?)",
        );
        for (const memberId of participants) add.run(id, memberId, at);
      });
      return repo.get(id)!;
    },
    get(id) {
      const row = getGroupRow(id);
      return row ? toGroup(row) : null;
    },
    listByProject(projectId, options = {}) {
      const where = options.includeArchived
        ? "WHERE project_id = ?"
        : "WHERE project_id = ? AND archived_at IS NULL";
      return (
        db.prepare(`SELECT * FROM groups ${where} ORDER BY created_at, id`).all(projectId) as GroupRow[]
      ).map(toGroup);
    },
    archive(id, at) {
      const existing = this.get(id);
      if (!existing) throw new NotFoundError(`Group ${id} 不存在。`);
      if (existing.archivedAt !== null) return existing;
      const stamp = at ?? nowIso();
      runInTransaction(db, () =>
        db.prepare("UPDATE groups SET archived_at = ?, updated_at = ? WHERE id = ?").run(stamp, stamp, id),
      );
      return this.get(id)!;
    },
    restore(id) {
      const existing = this.get(id);
      if (!existing) throw new NotFoundError(`Group ${id} 不存在。`);
      if (existing.archivedAt === null) return existing;
      runInTransaction(db, () =>
        db.prepare("UPDATE groups SET archived_at = NULL, updated_at = ? WHERE id = ?").run(nowIso(), id),
      );
      return this.get(id)!;
    },
    previewPurge(id) {
      if (!getGroupRow(id)) throw new NotFoundError(`Group ${id} 不存在。`);
      return groupPurgeCounts(db, id);
    },
    purge(id) {
      if (!getGroupRow(id)) throw new NotFoundError(`Group ${id} 不存在。`);
      const counts = groupPurgeCounts(db, id);
      runInTransaction(db, () => {
        // 只清「群聊 + 参与者关系」（LIFE-ARC-02）：投递记录随消息一起清，
        // 会话记录随群组一起清；**members 与 member_statuses 一行都不动**。
        db
          .prepare(
            `DELETE FROM message_deliveries
              WHERE message_id IN (SELECT id FROM messages WHERE group_id = ?)`,
          )
          .run(id);
        db.prepare("DELETE FROM messages WHERE group_id = ?").run(id);
        db.prepare("DELETE FROM group_participants WHERE group_id = ?").run(id);
        db.prepare("DELETE FROM mcp_sessions WHERE group_id = ?").run(id);
        const removed = db.prepare("DELETE FROM groups WHERE id = ?").run(id);
        if (removed.changes === 0) throw new NotFoundError(`Group ${id} 不存在。`);
      });
      return counts;
    },
    participants(groupId) {
      return (
        db
          .prepare("SELECT member_id FROM group_participants WHERE group_id = ? ORDER BY joined_at, member_id")
          .all(groupId) as { member_id: string }[]
      ).map((row) => row.member_id);
    },
    addParticipant(groupId, memberId) {
      const group = getGroupRow(groupId);
      if (!group) throw new NotFoundError(`Group ${groupId} 不存在。`);
      // 归档 = 非活跃态：不再接受新参与者（含 MCP 入群时落到本群组的 addParticipant）。
      requireGroupActive(db, groupId, "把成员加入群组");
      if (!memberInProject.get(memberId, group.project_id)) {
        throw new InvalidReferenceError(`成员 ${memberId} 不属于项目 ${group.project_id}，不能加入该群组。`);
      }
      db.prepare(
        "INSERT OR IGNORE INTO group_participants (group_id, member_id, joined_at) VALUES (?, ?, ?)",
      ).run(groupId, memberId, nowIso());
    },
    removeParticipant(groupId, memberId) {
      db.prepare("DELETE FROM group_participants WHERE group_id = ? AND member_id = ?").run(groupId, memberId);
    },
    // T5 #52：撤销补偿：直接补回一条参与者关系（INSERT OR IGNORE），
    // 故意不跑 requireGroupActive——撤销复原的是删除前的历史参与事实。
    restoreParticipant(groupId, memberId) {
      db.prepare(
        "INSERT OR IGNORE INTO group_participants (group_id, member_id, joined_at) VALUES (?, ?, ?)",
      ).run(groupId, memberId, nowIso());
    },
    delete(id) {
      const result = db.prepare("DELETE FROM groups WHERE id = ?").run(id);
      if (result.changes === 0) throw new NotFoundError(`Group ${id} 不存在。`);
    },
  };
  return repo;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

interface MessageRow {
  id: string;
  group_id: string;
  sender_member_id: string;
  seq: number;
  body: string;
  mentions: string;
  created_at: string;
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    groupId: row.group_id,
    senderMemberId: row.sender_member_id,
    seq: row.seq,
    body: row.body,
    mentions: JSON.parse(row.mentions) as string[],
    createdAt: row.created_at,
  };
}

function createMessages(db: Database.Database): MessagesRepository {
  return {
    create(input) {
      // 前置校验：错误必须明确，不留给数据库外键泛化报错。
      return runInTransaction(db, () => {
        const group = db.prepare("SELECT project_id FROM groups WHERE id = ?").get(input.groupId) as
          | { project_id: string }
          | undefined;
        if (!group) throw new InvalidReferenceError(`群组 ${input.groupId} 不存在，无法发送消息。`);
        requireGroupActive(db, input.groupId, "向群组发送消息");

        const sender = db.prepare("SELECT project_id FROM members WHERE id = ?").get(input.senderMemberId) as
          | { project_id: string }
          | undefined;
        if (!sender) throw new InvalidReferenceError(`发送者成员 ${input.senderMemberId} 不存在。`);
        if (sender.project_id !== group.project_id) {
          throw new InvalidReferenceError("发送者不属于该群组所在项目。");
        }
        const isParticipant = db
          .prepare("SELECT 1 FROM group_participants WHERE group_id = ? AND member_id = ?")
          .get(input.groupId, input.senderMemberId);
        if (!isParticipant) {
          throw new InvalidReferenceError(`发送者 ${input.senderMemberId} 不是群组 ${input.groupId} 的参与者。`);
        }

        const body = requireNonEmpty(input.body, "Message.body");
        const mentions = dedupe(input.mentions ?? []);
        // mentions 里的成员必须存在且属于同项目（避免悬空/跨项目）。
        for (const memberId of mentions) {
          const m = db.prepare("SELECT project_id FROM members WHERE id = ?").get(memberId) as
            | { project_id: string }
            | undefined;
          if (!m) throw new InvalidReferenceError(`被 @ 的成员 ${memberId} 不存在。`);
          if (m.project_id !== group.project_id) {
            throw new InvalidReferenceError(`被 @ 的成员 ${memberId} 不属于该项目。`);
          }
        }

        const id = input.id ?? newId();
        if (db.prepare("SELECT 1 FROM messages WHERE id = ?").get(id)) {
          throw new ConflictError(`消息 ID ${id} 已存在，拒绝重复插入。`);
        }
        // 群组内 seq = max+1；同一事务内串行化。失败回滚时不消耗序号。
        const maxRow = db.prepare("SELECT COALESCE(MAX(seq), 0) AS max FROM messages WHERE group_id = ?").get(
          input.groupId,
        ) as { max: number };
        const seq = maxRow.max + 1;
        const at = nowIso();
        db.prepare(
          `INSERT INTO messages (id, group_id, sender_member_id, seq, body, mentions, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, input.groupId, input.senderMemberId, seq, body, JSON.stringify(mentions), at);

        const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow;
        return toMessage(row);
      });
    },
    get(id) {
      const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
      return row ? toMessage(row) : null;
    },
    listByGroup(groupId, options = {}) {
      const afterSeq = options.afterSeq ?? 0;
      const limit = options.limit ?? -1;
      return (
        db
          .prepare("SELECT * FROM messages WHERE group_id = ? AND seq > ? ORDER BY seq LIMIT ?")
          .all(groupId, afterSeq, limit) as MessageRow[]
      ).map(toMessage);
    },
  };
}

// ---------------------------------------------------------------------------
// MessageDeliveries
// ---------------------------------------------------------------------------

interface DeliveryRow {
  id: string;
  message_id: string;
  member_id: string;
  project_id: string;
  status: string;
  attempt_count: number;
  first_delivered_at: string | null;
  last_delivered_at: string | null;
  acked_at: string | null;
  created_at: string;
  updated_at: string;
}

function toDelivery(row: DeliveryRow): MessageDelivery {
  return {
    id: row.id,
    messageId: row.message_id,
    memberId: row.member_id,
    projectId: row.project_id,
    status: row.status as DeliveryStatus,
    attemptCount: row.attempt_count,
    firstDeliveredAt: row.first_delivered_at,
    lastDeliveredAt: row.last_delivered_at,
    ackedAt: row.acked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createDeliveries(db: Database.Database): DeliveriesRepository {
  const getRow = (messageId: string, memberId: string) =>
    db
      .prepare("SELECT * FROM message_deliveries WHERE message_id = ? AND member_id = ?")
      .get(messageId, memberId) as DeliveryRow | undefined;

  const repo: DeliveriesRepository = {
    ensure(messageId, memberId) {
      return runInTransaction(db, () => {
        const existing = getRow(messageId, memberId);
        if (existing) return toDelivery(existing);

        const message = db.prepare("SELECT group_id FROM messages WHERE id = ?").get(messageId) as
          | { group_id: string }
          | undefined;
        if (!message) throw new InvalidReferenceError(`消息 ${messageId} 不存在，无法创建投递。`);
        const member = db.prepare("SELECT project_id FROM members WHERE id = ?").get(memberId) as
          | { project_id: string }
          | undefined;
        if (!member) throw new InvalidReferenceError(`成员 ${memberId} 不存在，无法创建投递。`);

        const at = nowIso();
        const id = newId();
        db.prepare(
          `INSERT INTO message_deliveries
             (id, message_id, member_id, project_id, status, attempt_count,
              first_delivered_at, last_delivered_at, acked_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?, ?)`,
        ).run(id, messageId, memberId, member.project_id, at, at);
        return toDelivery(getRow(messageId, memberId)!);
      });
    },
    get(messageId, memberId) {
      const row = getRow(messageId, memberId);
      return row ? toDelivery(row) : null;
    },
    recordAttempt(messageId, memberId, status, at) {
      if (!DELIVERY_STATUSES.includes(status)) {
        throw new InvalidArgumentError(`非法投递状态：${String(status)}。`);
      }
      const timestamp = at ?? nowIso();
      repo.ensure(messageId, memberId);
      return runInTransaction(db, () => {
        const current = getRow(messageId, memberId)!;
        const firstDelivered = current.first_delivered_at ?? (status !== "pending" ? timestamp : null);
        const ackedAt = status === "acked" ? (current.acked_at ?? timestamp) : current.acked_at;
        db.prepare(
          `UPDATE message_deliveries
             SET status = ?, attempt_count = attempt_count + 1,
                 first_delivered_at = ?, last_delivered_at = ?, acked_at = ?, updated_at = ?
           WHERE message_id = ? AND member_id = ?`,
        ).run(status, firstDelivered, timestamp, ackedAt, timestamp, messageId, memberId);
        return toDelivery(getRow(messageId, memberId)!);
      });
    },
    listPending(projectId, memberId) {
      return (
        db
          .prepare(
            `SELECT d.* FROM message_deliveries d
               JOIN messages m ON m.id = d.message_id
              WHERE d.project_id = ? AND d.member_id = ? AND d.status <> 'acked'
              ORDER BY m.group_id, m.seq`,
          )
          .all(projectId, memberId) as DeliveryRow[]
      ).map(toDelivery);
    },
    delete(messageId, memberId) {
      db.prepare("DELETE FROM message_deliveries WHERE message_id = ? AND member_id = ?").run(messageId, memberId);
    },
  };
  return repo;
}

// ---------------------------------------------------------------------------
// MemberStatuses
// ---------------------------------------------------------------------------

interface StatusRow {
  project_id: string;
  member_id: string;
  state: string;
  updated_at: string;
}

function toStatus(row: StatusRow): MemberStatus {
  return {
    projectId: row.project_id,
    memberId: row.member_id,
    state: row.state as MemberState,
    updatedAt: row.updated_at,
  };
}

function createStatuses(db: Database.Database): StatusesRepository {
  return {
    set(projectId, memberId, state) {
      if (!MEMBER_STATES.includes(state)) {
        throw new InvalidArgumentError(`非法成员状态：${String(state)}，允许：${MEMBER_STATES.join("/")}。`);
      }
      const member = db.prepare("SELECT project_id FROM members WHERE id = ?").get(memberId) as
        | { project_id: string }
        | undefined;
      if (!member) throw new InvalidReferenceError(`成员 ${memberId} 不存在，无法记录状态。`);
      if (member.project_id !== projectId) {
        throw new InvalidReferenceError(`成员 ${memberId} 不属于项目 ${projectId}。`);
      }
      const at = nowIso();
      db.prepare(
        `INSERT INTO member_statuses (project_id, member_id, state, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, member_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      ).run(projectId, memberId, state, at);
      return { projectId, memberId, state, updatedAt: at };
    },
    get(projectId, memberId) {
      const row = db
        .prepare("SELECT * FROM member_statuses WHERE project_id = ? AND member_id = ?")
        .get(projectId, memberId) as StatusRow | undefined;
      return row ? toStatus(row) : null;
    },
    listByProject(projectId) {
      return (
        db.prepare("SELECT * FROM member_statuses WHERE project_id = ? ORDER BY member_id").all(projectId) as StatusRow[]
      ).map(toStatus);
    },
    delete(projectId, memberId) {
      db.prepare("DELETE FROM member_statuses WHERE project_id = ? AND member_id = ?").run(projectId, memberId);
    },
  };
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// McpSessions（MCP 连接状态，全局层 D1；与 member_statuses 分开）
// ---------------------------------------------------------------------------

interface McpSessionRow {
  id: string;
  agent_id: string;
  project_id: string;
  group_id: string;
  member_id: string;
  display_name: string;
  host_type: string;
  state: string;
  connected_at: string;
  last_heartbeat_at: string | null;
  disconnected_at: string | null;
  updated_at: string;
}

function toMcpSession(row: McpSessionRow): McpSession {
  return {
    id: row.id,
    agentId: row.agent_id,
    projectId: row.project_id,
    groupId: row.group_id,
    memberId: row.member_id,
    displayName: row.display_name,
    hostType: row.host_type,
    state: row.state as McpSessionState,
    connectedAt: row.connected_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    disconnectedAt: row.disconnected_at,
    updatedAt: row.updated_at,
  };
}

function createMcpSessions(db: Database.Database): McpSessionsRepository {
  const getRow = (id: string) =>
    db.prepare("SELECT * FROM mcp_sessions WHERE id = ?").get(id) as McpSessionRow | undefined;

  const repo: McpSessionsRepository = {
    connect(input) {
      return runInTransaction(db, () => {
        const existing = repo.findActive(input.agentId, input.projectId, input.groupId);
        const at = nowIso();
        if (existing) {
          // 复用同一活跃会话；刷新成员/显示名与心跳，不改变 connected_at（会话连续性）。
          db.prepare(
            `UPDATE mcp_sessions
               SET member_id = ?, display_name = ?, host_type = ?, last_heartbeat_at = ?, updated_at = ?
             WHERE id = ?`,
          ).run(input.memberId, input.displayName, input.hostType, at, at, existing.id);
          return repo.get(existing.id)!;
        }
        const id = newId();
        db.prepare(
          `INSERT INTO mcp_sessions
             (id, agent_id, project_id, group_id, member_id, display_name, host_type, state,
              connected_at, last_heartbeat_at, disconnected_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?, NULL, ?)`,
        ).run(
          id,
          input.agentId,
          input.projectId,
          input.groupId,
          input.memberId,
          input.displayName,
          input.hostType,
          at,
          at,
          at,
        );
        return repo.get(id)!;
      });
    },
    get(id) {
      const row = getRow(id);
      return row ? toMcpSession(row) : null;
    },
    findActive(agentId, projectId, groupId) {
      const row = db
        .prepare(
          `SELECT * FROM mcp_sessions
            WHERE agent_id = ? AND project_id = ? AND group_id = ? AND state = 'connected'
            ORDER BY connected_at DESC, id DESC LIMIT 1`,
        )
        .get(agentId, projectId, groupId) as McpSessionRow | undefined;
      return row ? toMcpSession(row) : null;
    },
    listByProject(projectId) {
      return (
        db
          .prepare("SELECT * FROM mcp_sessions WHERE project_id = ? ORDER BY connected_at, id")
          .all(projectId) as McpSessionRow[]
      ).map(toMcpSession);
    },
    heartbeat(id, at) {
      const row = getRow(id);
      if (!row) throw new NotFoundError(`MCP 会话 ${id} 不存在。`);
      runInTransaction(db, () =>
        db
          .prepare("UPDATE mcp_sessions SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?")
          .run(at, at, id),
      );
      return repo.get(id)!;
    },
    disconnect(id, at) {
      const row = getRow(id);
      if (!row) throw new NotFoundError(`MCP 会话 ${id} 不存在。`);
      if (row.state === "disconnected") return repo.get(id)!;
      runInTransaction(db, () =>
        db
          .prepare(
            "UPDATE mcp_sessions SET state = 'disconnected', disconnected_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(at, at, id),
      );
      return repo.get(id)!;
    },
    markAllStale(at) {
      return runInTransaction(db, () => {
        const result = db
          .prepare(
            "UPDATE mcp_sessions SET state = 'disconnected', disconnected_at = ?, updated_at = ? WHERE state = 'connected'",
          )
          .run(at, at);
        return result.changes;
      });
    },
    delete(id) {
      db.prepare("DELETE FROM mcp_sessions WHERE id = ?").run(id);
    },
  };
  return repo;
}

// ---------------------------------------------------------------------------
// Org（T2 #49 / 决策票 #24、#25）
// ---------------------------------------------------------------------------

/** 岗位角色的静态枚举（与 F2 `AUTHZ_ROLES` 同值）；`owner` 是人的内建角色，不建岗。 */
const ORG_NODE_ROLES: readonly OrgNodeRole[] = ["owner", "top_manager", "sub_manager", "member"];

interface OrgNodeRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  name: string;
  role: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

function toOrgNode(row: OrgNodeRow): OrgNode {
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    name: row.name,
    role: row.role as OrgNodeRole,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 组织树 repository：唯一写入边界。
 *
 * 规则（#24/#25，spec #45 §6.2）：
 * - 根岗位（`parent_id IS NULL`）每项目最多一个，位置即「顶层 manager 岗位」；
 *   顶层唯一性由 `ux_org_nodes_single_root` 兜底，应用层归一为 `ConflictError`。
 * - 角色写在岗位上（角色静态、岗位动态）；`owner` 不建岗（人是全局主体）；
 *   根岗位固定 `top_manager`，非根岗位不能是 `top_manager`。
 * - 汇报线调整应用层防环：目标父不能是自身或自身子孙（递归 CTE 现算），无深度上限。
 * - 删岗位时**子树提升到父**，占据成员靠 `ON DELETE SET NULL` 腾出岗位但成员保留。
 * - 一人一岗、一岗一实例（`ux_members_node`），跨项目占岗拒绝。
 * - 阶段 1 兼容投影：legacy `members.role='manager'` 只由「占据根岗位」的成员持有；
 *   无组织树数据的库（v3→v4 升级默认无）不受影响，兼容映射继续可用。
 */
function createOrg(db: Database.Database): OrgRepository {
  const projectExists = db.prepare("SELECT 1 FROM projects WHERE id = ?");
  const nodeById = db.prepare("SELECT * FROM org_nodes WHERE id = ?");
  const memberById = db.prepare("SELECT * FROM members WHERE id = ?");
  const childrenOf = db.prepare("SELECT COUNT(*) AS c FROM org_nodes WHERE parent_id = ?");
  const rootOfProject = db.prepare("SELECT * FROM org_nodes WHERE project_id = ? AND parent_id IS NULL");

  /**
   * 子树边界（#24）：`WITH RECURSIVE` 现算，含自身。统一 `?` 占位符，
   * 经 F1 方言抽象（`renderPlaceholders`）可原样渲染到 SQLite / PostgreSQL 的 `$1`。
   * 不建闭包表：本地单用户、数据量小，现算足够；防环由应用层保证不会死循环。
   */
  const subtreeStmt = db.prepare(
    `WITH RECURSIVE subtree(id) AS (
       SELECT id FROM org_nodes WHERE id = ?
       UNION ALL
       SELECT n.id FROM org_nodes n JOIN subtree s ON n.parent_id = s.id
     )
     SELECT id FROM subtree`,
  );

  function getRow(id: string): OrgNodeRow | null {
    return (nodeById.get(id) as OrgNodeRow | undefined) ?? null;
  }

  function get(id: string): OrgNode | null {
    const row = getRow(id);
    return row ? toOrgNode(row) : null;
  }

  function subtreeNodeIds(nodeId: string): string[] {
    if (!getRow(nodeId)) return [];
    return (subtreeStmt.all(nodeId) as { id: string }[]).map((row) => row.id);
  }

  function requireProject(projectId: string): void {
    if (!projectExists.get(projectId)) {
      throw new InvalidReferenceError(`项目 ${projectId} 不存在，无法建立/调整组织岗位。`);
    }
  }

  function validateRole(role: OrgNodeRole): void {
    if (!ORG_NODE_ROLES.includes(role)) {
      throw new InvalidArgumentError(`OrgNode.role 必须是静态枚举之一，收到：${String(role)}。`);
    }
    if (role === "owner") {
      throw new InvalidArgumentError("owner（人）是内建全局主体，不建立组织岗位节点（决策票 #26）。");
    }
  }

  function validateSortOrder(value: number): void {
    if (!Number.isFinite(value)) {
      throw new InvalidArgumentError("OrgNode.sortOrder 必须是有限数字。");
    }
  }

  /** 阶段 1 兼容投影：把 `node_id` 与 legacy `role` 一起更新，保证至多一个 manager。 */
  function applyAssignment(memberRow: MemberRow, nodeId: string | null, isRoot: boolean, at: string): void {
    if (isRoot) {
      db.prepare(
        "UPDATE members SET role = 'normal', updated_at = ? WHERE project_id = ? AND role = 'manager' AND id <> ?",
      ).run(at, memberRow.project_id, memberRow.id);
    }
    const role = isRoot ? "manager" : memberRow.role === "manager" ? "normal" : memberRow.role;
    db.prepare("UPDATE members SET node_id = ?, role = ?, updated_at = ? WHERE id = ?").run(
      nodeId,
      role,
      at,
      memberRow.id,
    );
  }

  const repo: OrgRepository = {
    createNode(input) {
      requireProject(input.projectId);
      requireProjectActive(db, input.projectId, "建立组织岗位");
      const name = requireNonEmpty(input.name, "OrgNode.name");
      const role = input.role;
      validateRole(role);
      const parentId = input.parentId ?? null;
      const sortOrder = input.sortOrder ?? 0;
      validateSortOrder(sortOrder);

      if (parentId === null) {
        // 根位置 = 顶层 manager 岗位；角色固定，且每项目根唯一。
        if (role !== "top_manager") {
          throw new InvalidArgumentError("根岗位（顶层 manager）角色必须是 top_manager。");
        }
        if (rootOfProject.get(input.projectId)) {
          throw new ConflictError(`项目 ${input.projectId} 已有根岗位（顶层 manager），每项目最多一个。`);
        }
      } else {
        if (role === "top_manager") {
          throw new InvalidArgumentError("只有根岗位可以是 top_manager；下级 manager 请用 sub_manager。");
        }
        const parent = getRow(parentId);
        if (!parent) throw new InvalidReferenceError(`父岗位 ${parentId} 不存在。`);
        if (parent.project_id !== input.projectId) {
          throw new InvalidReferenceError(`父岗位 ${parentId} 不属于项目 ${input.projectId}，不能跨项目建岗。`);
        }
      }

      const at = nowIso();
      const id = newId();
      runInTransaction(db, () =>
        db
          .prepare(
            `INSERT INTO org_nodes (id, project_id, parent_id, name, role, sort_order, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, input.projectId, parentId, name, role, sortOrder, at, at),
      );
      return get(id)!;
    },

    getNode: get,

    listNodes(projectId) {
      // 层级展示顺序：父 → 子（递归 CTE 算深度），同级按 sort_order / created_at 稳定排序。
      const rows = db
        .prepare(
          `WITH RECURSIVE tree(id, depth) AS (
             SELECT id, 0 FROM org_nodes WHERE project_id = ? AND parent_id IS NULL
             UNION ALL
             SELECT n.id, t.depth + 1 FROM org_nodes n JOIN tree t ON n.parent_id = t.id
           )
           SELECT o.* FROM org_nodes o
             LEFT JOIN tree t ON t.id = o.id
           WHERE o.project_id = ?
           ORDER BY COALESCE(t.depth, 0), o.sort_order, o.created_at, o.id`,
        )
        .all(projectId, projectId) as OrgNodeRow[];
      return rows.map(toOrgNode);
    },

    getRootNode(projectId) {
      const row = rootOfProject.get(projectId) as OrgNodeRow | undefined;
      return row ? toOrgNode(row) : null;
    },

    subtreeNodeIds,

    updateNode(id, patch) {
      const row = getRow(id);
      if (!row) throw new NotFoundError(`组织岗位 ${id} 不存在。`);
      requireProjectActive(db, row.project_id, "调整组织岗位");

      const name = patch.name === undefined ? row.name : requireNonEmpty(patch.name, "OrgNode.name");
      let role = row.role as OrgNodeRole;
      if (patch.role !== undefined) {
        validateRole(patch.role);
        if (row.parent_id === null && patch.role !== "top_manager") {
          throw new InvalidArgumentError("根岗位角色固定为 top_manager，不能修改。");
        }
        if (row.parent_id !== null && patch.role === "top_manager") {
          throw new InvalidArgumentError("只有根岗位可以是 top_manager；下级 manager 请用 sub_manager。");
        }
        role = patch.role;
      }

      let parentId = row.parent_id;
      if (patch.parentId !== undefined) {
        const target = patch.parentId;
        if (target === null) {
          // 把非根岗位移到根层会产生第二棵树（多个根），拒绝；根保持 null 是无操作。
          if (row.parent_id !== null) {
            throw new InvalidArgumentError("不能把非根岗位移到根层：每项目根岗位唯一（顶层 manager）。");
          }
        } else {
          if (target === id) throw new InvalidArgumentError("汇报线不能指向自身（防环）。");
          const parent = getRow(target);
          if (!parent) throw new InvalidReferenceError(`父岗位 ${target} 不存在。`);
          if (parent.project_id !== row.project_id) {
            throw new InvalidReferenceError(`父岗位 ${target} 不属于同一项目，不能跨项目调整汇报线。`);
          }
          // 防环：目标父不能是本岗位的子孙（子树递归 CTE 现算，含自身）。
          if (subtreeNodeIds(id).includes(target)) {
            throw new InvalidArgumentError("汇报线调整会形成环：目标父岗位是本岗位的子孙。");
          }
          parentId = target;
        }
      }

      const sortOrder = patch.sortOrder ?? row.sort_order;
      validateSortOrder(sortOrder);
      runInTransaction(db, () =>
        db
          .prepare(
            "UPDATE org_nodes SET parent_id = ?, name = ?, role = ?, sort_order = ?, updated_at = ? WHERE id = ?",
          )
          .run(parentId, name, role, sortOrder, nowIso(), id),
      );
      return get(id)!;
    },

    deleteNode(id) {
      const row = getRow(id);
      if (!row) throw new NotFoundError(`组织岗位 ${id} 不存在。`);
      requireProjectActive(db, row.project_id, "删除组织岗位");
      const childCount = (childrenOf.get(id) as { c: number }).c;
      if (row.parent_id === null && childCount > 0) {
        throw new InvalidArgumentError("根岗位还有下级岗位，不能直接删除（否则会出现多个根）；请先调整汇报线。");
      }
      runInTransaction(db, () => {
        // 子树提升到被删节点的父（不级联删；无子节点的根删除时该 UPDATE 无匹配行）。
        db.prepare("UPDATE org_nodes SET parent_id = ?, updated_at = ? WHERE parent_id = ?").run(
          row.parent_id,
          nowIso(),
          id,
        );
        // members.node_id ON DELETE SET NULL：占据成员腾出岗位，成员本身保留。
        db.prepare("DELETE FROM org_nodes WHERE id = ?").run(id);
      });
    },

    assignNode(memberId, nodeId) {
      const memberRow = memberById.get(memberId) as MemberRow | undefined;
      if (!memberRow) throw new NotFoundError(`成员 ${memberId} 不存在。`);
      let nodeRow: OrgNodeRow | null = null;
      if (nodeId !== null) {
        nodeRow = getRow(nodeId);
        if (!nodeRow) throw new InvalidReferenceError(`组织岗位 ${nodeId} 不存在。`);
        if (nodeRow.project_id !== memberRow.project_id) {
          throw new InvalidReferenceError(`岗位 ${nodeId} 与成员 ${memberId} 不属于同一项目，拒绝跨项目占岗。`);
        }
      }
      requireProjectActive(db, memberRow.project_id, "分配成员岗位");
      const isRoot = nodeRow !== null && nodeRow.parent_id === null;
      runInTransaction(db, () => applyAssignment(memberRow, nodeId, isRoot, nowIso()));
      return toMember(memberById.get(memberId) as MemberRow);
    },

    autoPlaceMember(projectId, memberId) {
      const memberRow = memberById.get(memberId) as MemberRow | undefined;
      if (!memberRow) throw new NotFoundError(`成员 ${memberId} 不存在。`);
      if (memberRow.project_id !== projectId) {
        throw new InvalidReferenceError(`成员 ${memberId} 不属于项目 ${projectId}。`);
      }
      requireProjectActive(db, projectId, "自动分配成员岗位");
      // 幂等：已落位的成员返回其现有岗位，不重复建岗。
      if (memberRow.node_id !== null) {
        const existing = get(memberRow.node_id);
        if (existing) return existing;
      }
      const rootRow = rootOfProject.get(projectId) as OrgNodeRow | undefined;
      // 阶段 1 兼容：项目尚无组织树时不自动造树（升级路径默认无组织数据）。
      if (!rootRow) return null;
      const at = nowIso();
      const nodeId = newId();
      runInTransaction(db, () => {
        db.prepare(
          `INSERT INTO org_nodes (id, project_id, parent_id, name, role, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'member', 0, ?, ?)`,
        ).run(nodeId, projectId, rootRow.id, memberRow.display_name, at, at);
        applyAssignment(memberRow, nodeId, false, at);
      });
      return get(nodeId)!;
    },

    nodeOfMember(memberId) {
      const row = memberById.get(memberId) as MemberRow | undefined;
      if (!row || row.node_id === null) return null;
      return get(row.node_id);
    },
    // T5 #52：按 before 快照直接复原岗位行（撤销补偿，upsert）。
    restoreRow(node) {
      db.prepare(
        `INSERT INTO org_nodes
           (id, project_id, parent_id, name, role, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id, parent_id = excluded.parent_id, name = excluded.name,
           role = excluded.role, sort_order = excluded.sort_order,
           created_at = excluded.created_at, updated_at = excluded.updated_at`,
      ).run(
        node.id, node.projectId, node.parentId, node.name, node.role,
        node.sortOrder, node.createdAt, node.updatedAt,
      );
    },
  };
  return repo;
}

// ---------------------------------------------------------------------------

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}