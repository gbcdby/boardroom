import type { DbDriver, DbTransaction, DbRow } from "./driver.ts";
import { AsyncLocalStorage } from "node:async_hooks";
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
import { createTasksRepository, type TasksRepository } from "../tasks/repository.ts";
import {
  createAuditRepository,
  type AuditRepository,
} from "../audit.ts";
import type {
  Agent,
  DeliveryStatus,
  DeliveryWake,
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
 *
 * #61：本层只经 {@link RepoCtx}（基于 DbDriver 抽象）访问持久化，不再直接持有
 * SQLite 句柄；SQLite 与 PostgreSQL 双方言通过统一的 `?` 占位符与 `exec` 返回
 * 影响行数（与 SQLite `changes` 对齐）切换，阶段 1 默认行为不回归。
 */

/** 仓储层统一执行上下文：建立在 DbDriver 之上的薄封装。 */
export interface RepoCtx {
  /** 读取查询；参数使用统一 `?` 占位符。 */
  query<T extends DbRow = DbRow>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /**
   * 执行语句（DML/DDL），不返回行；返回值为影响行数（与 SQLite `changes` 对齐）。
   */
  exec(sql: string, params?: readonly unknown[]): Promise<number>;
  /** 读取单行；无匹配返回 undefined。 */
  one<T extends DbRow = DbRow>(sql: string, params?: readonly unknown[]): Promise<T | undefined>;
  /** 在单个写事务内运行 fn；失败回滚并向上抛出。 */
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;
}

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
  create(input: NewAgent): Promise<Agent>;
  /** 以完整字段插入（含外部提供的 ID），重复 ID 报 ConflictError。 */
  insertRaw(agent: Agent): Promise<Agent>;
  get(id: string): Promise<Agent | null>;
  /**
   * 按全局身份键（displayName + hostType）查找 agent（T2 身份唯一性）。
   * 命中返回已有 agent；未命中返回 null，由调用方决定创建。
   */
  findByIdentity(displayName: string, hostType: string): Promise<Agent | null>;
  list(): Promise<Agent[]>;
  update(id: string, patch: Partial<Pick<Agent, "displayName" | "hostType">>): Promise<Agent>;
  touchLastSeen(id: string, at: string): Promise<Agent>;
  delete(id: string): Promise<void>;
}

/**
 * 永久删除的级联清单（#48 / LIFE-ARC-02）：删除前给人看的「会被清掉什么」，
 * 删除后作为实际清除的行数返回。口径 = 当前已落库的范围（阶段 1/2/3）；
 * 阶段 4 记忆落库时继续按同一形状补进清单。
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
  readonly agentRuntimeBindings: number;
  readonly agentRunnerStates: number;
  readonly agentRuntimeMembers: number;
  readonly taskSettings: number;
  readonly tasks: number;
  readonly taskComments: number;
  readonly taskHistory: number;
  readonly taskMessageLinks: number;
  readonly reviewRounds: number;
  readonly reviewReports: number;
  readonly workEvents: number;
}

/** 群组级联清单（#48）：删群组只清群聊与参与者关系，**不动成员本身**。 */
export interface GroupPurgeCounts {
  readonly taskMessageLinks: number;
  readonly messages: number;
  readonly deliveries: number;
  readonly participants: number;
  readonly mcpSessions: number;
  readonly agentRuntimeBindings: number;
  readonly agentRunnerStates: number;
  readonly agentRuntimeMembers: number;
}

export interface ProjectsRepository {
  create(input: NewProject): Promise<Project>;
  get(id: string): Promise<Project | null>;
  /** 默认只列**未归档**项目；`includeArchived` 时连归档项目一起返回（#48 / PROJECT-03）。 */
  list(options?: ListOptions): Promise<Project[]>;
  rename(id: string, name: string): Promise<Project>;
  /** 归档：写入归档时间；已归档时幂等返回（可恢复，不删数据）。 */
  archive(id: string, at?: string): Promise<Project>;
  /** 恢复：清除归档时间；未归档时幂等返回。 */
  restore(id: string): Promise<Project>;
  /** 永久删除前的级联清单（只读，不改数据）。项目不存在时抛 NotFoundError。 */
  previewPurge(id: string): Promise<PurgeCounts>;
  /**
   * 永久删除项目：在**单个事务**内按「子 → 父」顺序级联清除群组、群聊消息、投递、
   * 参与者关系、成员、成员状态与 MCP 会话，最后删项目本身；返回实际清除的行数。
   * 只应在人二次确认后由入口调用（PROJECT-03）：agent 主体没有 `project:purge` 能力点。
   */
  purge(id: string): Promise<PurgeCounts>;
  delete(id: string): Promise<void>;
}

export interface MembersRepository {
  create(input: NewMember): Promise<Member>;
  get(id: string): Promise<Member | null>;
  listByProject(projectId: string): Promise<Member[]>;
  /** 查找某 agent 在某项目中的成员关系（T2 幂等入群）。 */
  findByAgent(projectId: string, agentId: string): Promise<Member | null>;
  getManager(projectId: string): Promise<Member | null>;
  update(id: string, patch: Partial<Pick<Member, "displayName" | "role">>): Promise<Member>;
  /**
   * T3（#50）成员状态机：在合法转换表内切换生命周期状态。
   * 只更新 `status` 与 `updated_at`，**不物理删除成员、不动岗位(node_id)/历史/数据/
   * 群组参与/运行状态/连接状态**（LIFE-MEM-01/02/03）。
   * - 同态 = 幂等 no-op；非法转换 → ConflictError；未知状态 → InvalidArgumentError；
   *   成员不存在 → NotFoundError；归档项目 → ArchivedError（复用 T1 归档写规则）。
   */
  setStatus(id: string, status: MemberLifecycleStatus): Promise<Member>;
  delete(id: string): Promise<void>;
  /**
   * T5（#52）撤销补偿：按 `before` 全量快照**直接复原**成员行（upsert）。
   * 专供撤销入口在单事务内调用：故意绕过 `setStatus` 的单向转换表与
   * `requireNoOtherManager` 约束，因为补偿恢复的是「已确认存在的历史状态」，
   * 不是一次新的前向业务变更。FK/唯一约束仍由数据库把关。
   */
  restoreRow(member: Member): Promise<void>;
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
  createNode(input: NewOrgNode): Promise<OrgNode>;
  getNode(id: string): Promise<OrgNode | null>;
  /** 项目全部岗位（层级展示顺序：父 → 子，同级按 sort_order）。 */
  listNodes(projectId: string): Promise<OrgNode[]>;
  getRootNode(projectId: string): Promise<OrgNode | null>;
  /**
   * 某节点的子树节点 id 集合（**含自身**）。
   * SQLite/PG 通用的 `WITH RECURSIVE` CTE 现算（#24：本地量小不建闭包表）；
   * 节点不存在时返回空数组。
   */
  subtreeNodeIds(nodeId: string): Promise<string[]>;
  /** 改岗位：改名 / 改角色 / 调整汇报线 / 排序。防环与根规则在这里统一把关。 */
  updateNode(id: string, patch: Partial<Pick<OrgNode, "name" | "role" | "parentId" | "sortOrder">>): Promise<OrgNode>;
  /** 删除岗位：直接子节点提升到本节点的父；占据成员回到未落位。 */
  deleteNode(id: string): Promise<void>;
  /**
   * 成员占据/腾出岗位（`nodeId = null` 为腾出）。ORG-02/08：manager 分配、人可调整。
   * 同步阶段 1 兼容投影：占据顶层岗 → legacy `role='manager'`（旧 manager 降 normal）；
   * 让出顶层岗 → 归还 normal。保证升级路径与 T1 API（`PUT /manager`、projectView）一致。
   */
  assignNode(memberId: string, nodeId: string | null): Promise<Member>;
  /**
   * manager 自动分配新成员岗位（ORG-02）：项目**已有组织树**时，在根下建一个
   * `member` 岗（名称取成员展示名）并让该成员占据；项目尚无组织树时返回 null
   * ——不自动造树，保证阶段 1 兼容路径与既有行为不变（人可另行独立创建，ORG-08）。
   * 成员已落位时幂等返回其现有岗位。
   */
  autoPlaceMember(projectId: string, memberId: string): Promise<OrgNode | null>;
  /** 某成员当前占据的岗位（未落位返回 null）。 */
  nodeOfMember(memberId: string): Promise<OrgNode | null>;
  /**
   * T5（#52）撤销补偿：按 `before` 全量快照直接复原岗位行（upsert）。
   * 绕过前向的防环/根唯一校验——补偿恢复的是已存在的历史状态，
   * 余下约束（父指针外键、单根唯一索引）仍由数据库把关。
   */
  restoreRow(node: OrgNode): Promise<void>;
}

export interface GroupsRepository {
  create(input: NewGroup): Promise<Group>;
  get(id: string): Promise<Group | null>;
  /** 默认只列**未归档**群组；`includeArchived` 时连归档群组一起返回（#48 / GROUP-04）。 */
  listByProject(projectId: string, options?: ListOptions): Promise<Group[]>;
  /** 归档（可恢复）：写入归档时间；已归档时幂等。 */
  archive(id: string, at?: string): Promise<Group>;
  /** 恢复：清除归档时间；未归档时幂等。 */
  restore(id: string): Promise<Group>;
  /** 永久删除前的级联清单（只读）。群组不存在时抛 NotFoundError。 */
  previewPurge(id: string): Promise<GroupPurgeCounts>;
  /**
   * 永久删除群组（#48 / GROUP-04、LIFE-ARC-02）：单事务内清除**该群组的群聊**
   * （消息与投递记录）、**参与者关系**，以及随群组消失的连接会话记录。
   * 项目成员本身**不动**——这是与 {@link ProjectsRepository.purge} 的关键差别。
   */
  purge(id: string): Promise<GroupPurgeCounts>;
  participants(groupId: string): Promise<string[]>;
  addParticipant(groupId: string, memberId: string): Promise<void>;
  removeParticipant(groupId: string, memberId: string): Promise<void>;
  /**
   * T5（#52）撤销补偿：直接补回一条参与者关系（INSERT OR IGNORE），
   * 故意不跑 `requireGroupActive`——撤销复原的是删除前的历史参与事实。
   */
  restoreParticipant(groupId: string, memberId: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface MessagesRepository {
  create(input: NewMessage): Promise<Message>;
  get(id: string): Promise<Message | null>;
  findByClientKey(senderMemberId: string, clientMessageId: string): Promise<Message | null>;
  listByGroup(groupId: string, options?: MessageListOptions): Promise<Message[]>;
  /** T4（#51）：项目内消息总数（跨其全部群组），用于跨项目概览的「消息数」。 */
  countByProject(projectId: string): Promise<number>;
  /** T4（#51）：项目内最近一条消息的时间（ISO），无消息则返回 null（用于「最近活跃」）。 */
  latestByProject(projectId: string): Promise<string | null>;
}

export interface DeliveriesRepository {
  /** 确保 (message, member) 的投递记录存在（不存在则建 pending）；幂等去重。 */
  ensure(messageId: string, memberId: string, wake?: DeliveryWake): Promise<MessageDelivery>;
  get(messageId: string, memberId: string): Promise<MessageDelivery | null>;
  /** 记录一次投递尝试并更新状态；不存在则先 ensure。 */
  recordAttempt(messageId: string, memberId: string, status: DeliveryStatus, at?: string): Promise<MessageDelivery>;
  /**
   * 某成员在项目中**尚未完成**（未 acked）的积压，按群组 seq 排序。
   *
   * 「未完成」包含 pending 与 delivered——两者都还没被客户端确认。这样至少一次投递的
   * 重连补发才能重投「已投递但未确认」的消息（NFR-02）；只有 acked 才视为不需要再投。
   */
  listPending(projectId: string, memberId: string): Promise<MessageDelivery[]>;
  /** 可自动触发的持久化积压；ACK 与唤醒判定分别过滤，不重新评估历史抑制。 */
  listWakeable(projectId: string, memberId: string): Promise<MessageDelivery[]>;
  delete(messageId: string, memberId: string): Promise<void>;
}

export interface StatusesRepository {
  /** upsert 项目成员状态。 */
  set(projectId: string, memberId: string, state: MemberState): Promise<MemberStatus>;
  get(projectId: string, memberId: string): Promise<MemberStatus | null>;
  listByProject(projectId: string): Promise<MemberStatus[]>;
  delete(projectId: string, memberId: string): Promise<void>;
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
  }): Promise<McpSession>;
  /** 按会话 id 查找。 */
  get(id: string): Promise<McpSession | null>;
  /** 查找某 agent 在某项目/群组的活跃（connected）会话。 */
  findActive(agentId: string, projectId: string, groupId: string): Promise<McpSession | null>;
  /** 某项目下所有会话（含断开的历史会话），用于成员在线视图。 */
  listByProject(projectId: string): Promise<McpSession[]>;
  /** 记录一次心跳时间（不改变 state）。 */
  heartbeat(id: string, at: string): Promise<McpSession>;
  /** 把会话标记为断开（未连接时幂等）。 */
  disconnect(id: string, at: string): Promise<McpSession>;
  /** 启动时把所有仍为 connected 的会话标记为 disconnected（进程重启后连接已失效）。 */
  markAllStale(at: string): Promise<number>;
  delete(id: string): Promise<void>;
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
  readonly tasks: TasksRepository;
  /** 在单个写事务内运行 fn；失败回滚并抛出归一化后的错误。 */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

// 仅用于泛型查询结果的标量行形状（type 别名带隐式索引签名，可满足 DbRow 约束）。
type ProjectIdRow = { project_id: string };
type DisplayNameRow = { display_name: string };
type IdRow = { id: string };
type GroupIdRow = { group_id: string };
type MemberIdRow = { member_id: string };
type CountRow = { c: number | string };
type MaxRow = { max: number | string };
type LatestRow = { t: string | null };

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

/** 创建 repository 集合；同一 db 连接共享。所有仓储经 {@link RepoCtx} 访问持久化。 */
export function createRepositories(db: DbDriver): RepositorySet {
  // 只有当前异步调用链才能使用自己的事务会话；其它请求回落到顶层 DbDriver。
  // 不再用共享闭包变量，避免请求交错时把已回滚/未提交连接交给另一请求。
  const transactionScope = new AsyncLocalStorage<{ tx: DbTransaction; active: boolean }>();
  const active = (): DbTransaction => {
    const scope = transactionScope.getStore();
    return scope?.active ? scope.tx : db;
  };

  const ctx: RepoCtx = {
    query: <T extends DbRow = DbRow>(sql: string, params?: readonly unknown[]): Promise<T[]> =>
      active().query<T>(sql, params),
    exec: (sql: string, params?: readonly unknown[]): Promise<number> => active().exec(sql, params),
    one: async <T extends DbRow = DbRow>(sql: string, params?: readonly unknown[]): Promise<T | undefined> =>
      (await active().query<T>(sql, params))[0],
    withTransaction: <T>(fn: () => Promise<T>): Promise<T> =>
      db.transaction(async (tx: DbTransaction) => {
        const scope = { tx, active: true };
        try {
          return await transactionScope.run(scope, fn);
        } catch (error) {
          // #61：与原 runInTransaction 一致，事务体内错误归一化为 RepositoryError
          // （唯一/主键冲突 → ConflictError，跨双方言），避免裸驱动错误逃逸。
          throw normalizeError(error);
        } finally {
          scope.active = false;
        }
      }),
  };

  return {
    agents: createAgents(ctx),
    projects: createProjects(ctx),
    members: createMembers(ctx),
    org: createOrg(ctx),
    groups: createGroups(ctx),
    messages: createMessages(ctx, db.kind),
    deliveries: createDeliveries(ctx),
    statuses: createStatuses(ctx),
    mcpSessions: createMcpSessions(ctx),
    audit: createAuditRepository(ctx),
    tasks: createTasksRepository(ctx),
    transaction: ctx.withTransaction,
  };
}

// ---------------------------------------------------------------------------
// 事务 & 错误归一
// ---------------------------------------------------------------------------

/**
 * 把底层错误归一到持久化层错误类型。已知业务错误原样抛出；
 * SQLite 约束/只读/闭合等错误映射为对应语义；其余视为写入失败。
 */
function normalizeError(error: unknown): RepositoryError {
  if (error instanceof RepositoryError) return error;
  const err = error as { code?: string; message?: string };
  const code = err?.code ?? "";
  const message = err?.message ?? String(error);
  // 唯一/主键冲突 → ConflictError（SQLite 与 PostgreSQL 双方言对齐）。
  if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "23505") {
    return new ConflictError(`唯一约束冲突：${message}`, error);
  }
  // 外键冲突 → InvalidReferenceError。
  if (code === "SQLITE_CONSTRAINT_FOREIGNKEY" || code === "23503") {
    return new InvalidReferenceError(`外键约束失败：${message}`, error);
  }
  // 其余约束（NOT NULL / CHECK 等）→ InvalidArgumentError。
  if (code.startsWith("SQLITE_CONSTRAINT") || code === "23514" || code === "23502") {
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
async function requireProjectActive(ctx: RepoCtx, projectId: string, action: string): Promise<void> {
  const row = (await ctx.one(
    "SELECT archived_at FROM projects WHERE id = ?",
    [projectId],
  )) as { archived_at: string | null } | undefined;
  if (row?.archived_at != null) {
    throw new ArchivedError(`项目已归档，不能${action}；如需继续，请先恢复该项目。`);
  }
}

/** 同 {@link requireProjectActive}，但面向群组：群组自身或其所属项目归档即拒绝写入。 */
async function requireGroupActive(ctx: RepoCtx, groupId: string, action: string): Promise<void> {
  const row = (await ctx.one(
    `SELECT g.archived_at AS group_archived, p.archived_at AS project_archived
       FROM groups g JOIN projects p ON p.id = g.project_id
      WHERE g.id = ?`,
    [groupId],
  )) as { group_archived: string | null; project_archived: string | null } | undefined;
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
async function projectPurgeCounts(ctx: RepoCtx, projectId: string): Promise<PurgeCounts> {
  const count = async (sql: string): Promise<number> => {
    const r = (await ctx.one(sql, [projectId])) as CountRow | undefined;
    return Number(r?.c ?? 0);
  };
  const managed = await hasRuntimeSchema(ctx);
  const tasks = await hasTasksSchema(ctx);
  return {
    taskSettings: tasks ? await count("SELECT COUNT(*) AS c FROM project_task_settings WHERE project_id = ?") : 0,
    tasks: tasks ? await count("SELECT COUNT(*) AS c FROM tasks WHERE project_id = ?") : 0,
    taskComments: tasks ? await count("SELECT COUNT(*) AS c FROM task_comments WHERE project_id = ?") : 0,
    taskHistory: tasks ? await count("SELECT COUNT(*) AS c FROM task_history WHERE project_id = ?") : 0,
    taskMessageLinks: tasks ? await count("SELECT COUNT(*) AS c FROM task_message_links WHERE project_id = ?") : 0,
    reviewRounds: tasks ? await count("SELECT COUNT(*) AS c FROM task_review_rounds WHERE project_id = ?") : 0,
    reviewReports: tasks ? await count("SELECT COUNT(*) AS c FROM task_review_reports WHERE project_id = ?") : 0,
    workEvents: tasks ? await count("SELECT COUNT(*) AS c FROM work_events WHERE project_id = ?") : 0,
    groups: await count("SELECT COUNT(*) AS c FROM groups WHERE project_id = ?"),
    members: await count("SELECT COUNT(*) AS c FROM members WHERE project_id = ?"),
    orgNodes: await count("SELECT COUNT(*) AS c FROM org_nodes WHERE project_id = ?"),
    messages: await count(
      "SELECT COUNT(*) AS c FROM messages m WHERE m.group_id IN (SELECT id FROM groups WHERE project_id = ?)",
    ),
    deliveries: await count("SELECT COUNT(*) AS c FROM message_deliveries WHERE project_id = ?"),
    memberStatuses: await count("SELECT COUNT(*) AS c FROM member_statuses WHERE project_id = ?"),
    mcpSessions: await count("SELECT COUNT(*) AS c FROM mcp_sessions WHERE project_id = ?"),
    agentRuntimeBindings: managed ? await count("SELECT COUNT(*) AS c FROM agent_runtime_bindings WHERE project_id = ?") : 0,
    agentRunnerStates: managed ? await count("SELECT COUNT(*) AS c FROM agent_runner_states WHERE binding_id IN (SELECT id FROM agent_runtime_bindings WHERE project_id = ?)") : 0,
    agentRuntimeMembers: managed ? await count("SELECT COUNT(*) AS c FROM agent_runtime_members WHERE project_id = ?") : 0,
  };
}

/**
 * 永久删除群组时会波及的行数清单（#48 / LIFE-ARC-02）。
 * 口径只含群聊与参与者关系（外加随群组消失的会话记录），**不含成员**。
 */
async function groupPurgeCounts(ctx: RepoCtx, groupId: string): Promise<GroupPurgeCounts> {
  const count = async (sql: string): Promise<number> => {
    const r = (await ctx.one(sql, [groupId])) as CountRow | undefined;
    return Number(r?.c ?? 0);
  };
  const managed = await hasRuntimeSchema(ctx);
  return {
    taskMessageLinks: await hasTasksSchema(ctx) ? await count("SELECT COUNT(*) AS c FROM task_message_links WHERE group_id = ?") : 0,
    messages: await count("SELECT COUNT(*) AS c FROM messages WHERE group_id = ?"),
    deliveries: await count(
      "SELECT COUNT(*) AS c FROM message_deliveries WHERE message_id IN (SELECT id FROM messages WHERE group_id = ?)",
    ),
    participants: await count("SELECT COUNT(*) AS c FROM group_participants WHERE group_id = ?"),
    mcpSessions: await count("SELECT COUNT(*) AS c FROM mcp_sessions WHERE group_id = ?"),
    agentRuntimeBindings: managed ? await count("SELECT COUNT(*) AS c FROM agent_runtime_bindings WHERE group_id = ?") : 0,
    agentRunnerStates: managed ? await count("SELECT COUNT(*) AS c FROM agent_runner_states WHERE binding_id IN (SELECT id FROM agent_runtime_bindings WHERE group_id = ?)") : 0,
    agentRuntimeMembers: managed ? await count(`SELECT COUNT(*) AS c FROM agent_runtime_members rm
      WHERE rm.member_id IN (SELECT member_id FROM agent_runtime_bindings WHERE group_id = ?)
        AND (SELECT COUNT(*) FROM agent_runtime_bindings b WHERE b.member_id = rm.member_id) = 1`) : 0,
  };
}

/** 迁移测试允许暂时操作旧库；升级后的正常运行总是具备 v8。 */
async function hasRuntimeSchema(ctx: RepoCtx): Promise<boolean> {
  return (await ctx.one("SELECT version FROM schema_migrations WHERE version = 8")) !== undefined;
}

/** 老版本迁移 fixture 尚无阶段 3 表，计数/清理不能提前访问它们。 */
async function hasTasksSchema(ctx: RepoCtx): Promise<boolean> {
  return (await ctx.one("SELECT version FROM schema_migrations WHERE version = 11")) !== undefined;
}

/**
 * 永久删除与 runner claim 共用成员行写锁。lease 过期仍须等待真正退出，
 * 不能通过项目/成员级联删除绕过「先停止托管配置」。父级锁也阻止并发新增绑定。
 */
async function requireManagedStopped(ctx: RepoCtx, kind: "project" | "group" | "member", id: string): Promise<void> {
  if (!await hasRuntimeSchema(ctx)) return;
  if (kind === "project") await ctx.exec("UPDATE projects SET updated_at = updated_at WHERE id = ?", [id]);
  if (kind === "group") {
    const group = await ctx.one<GroupIdRow & ProjectIdRow>("SELECT project_id FROM groups WHERE id = ?", [id]);
    if (group) await ctx.exec("UPDATE projects SET updated_at = updated_at WHERE id = ?", [group.project_id]);
    await ctx.exec("UPDATE groups SET updated_at = updated_at WHERE id = ?", [id]);
  }
  const column = kind === "project" ? "project_id" : kind === "group" ? "group_id" : "member_id";
  const members = await ctx.query<MemberIdRow>(`SELECT DISTINCT member_id FROM agent_runtime_bindings WHERE ${column} = ? ORDER BY member_id`, [id]);
  for (const member of members) await ctx.exec("UPDATE members SET updated_at = updated_at WHERE id = ?", [member.member_id]);
  const active = await ctx.one(`SELECT b.id FROM agent_runtime_bindings b
    JOIN agent_runner_states s ON s.binding_id = b.id WHERE b.${column} = ?
      AND (b.desired_state <> 'stopped' OR s.lease_owner IS NOT NULL OR s.exit_confirmed <> 1
        OR s.state NOT IN ('stopped', 'failed')) LIMIT 1`, [id]);
  if (active) throw new ConflictError("runtime_must_stop_first");
}

async function cleanOrphanRuntimeMembers(ctx: RepoCtx): Promise<void> {
  if (!await hasRuntimeSchema(ctx)) return;
  await ctx.exec(`DELETE FROM agent_runtime_members WHERE binding_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM agent_runtime_bindings b WHERE b.member_id = agent_runtime_members.member_id)`);
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

type AgentRow = {
  id: string;
  display_name: string;
  host_type: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
};

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

function createAgents(ctx: RepoCtx): AgentsRepository {
  const insertSql =
    `INSERT INTO agents (id, display_name, host_type, created_at, updated_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`;

  const insertRow = async (agent: Agent): Promise<void> => {
    try {
      await ctx.exec(insertSql, [
        agent.id,
        agent.displayName,
        agent.hostType,
        agent.createdAt,
        agent.updatedAt,
        agent.lastSeenAt,
      ]);
    } catch (error) {
      throw normalizeError(error);
    }
  };

  return {
    async create(input) {
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
      await ctx.withTransaction(async () => insertRow(agent));
      return agent;
    },
    async insertRaw(agent) {
      await insertRow(agent);
      return agent;
    },
    async get(id) {
      const row = await ctx.one<AgentRow>("SELECT * FROM agents WHERE id = ?", [id]);
      return row ? toAgent(row) : null;
    },
    async findByIdentity(displayName, hostType) {
      const row = await ctx.one<AgentRow>(
        "SELECT * FROM agents WHERE display_name = ? AND host_type = ?",
        [displayName, hostType],
      );
      return row ? toAgent(row) : null;
    },
    async list() {
      return (await ctx.query<AgentRow>("SELECT * FROM agents ORDER BY created_at, id")).map(toAgent);
    },
    async update(id, patch) {
      const existing = await this.get(id);
      if (!existing) throw new NotFoundError(`Agent ${id} 不存在。`);
      const displayName =
        patch.displayName === undefined ? existing.displayName : requireNonEmpty(patch.displayName, "Agent.displayName");
      const hostType =
        patch.hostType === undefined ? existing.hostType : requireNonEmpty(patch.hostType, "Agent.hostType");
      await ctx.withTransaction(async () => {
        if ((displayName !== existing.displayName || hostType !== existing.hostType) && await hasRuntimeSchema(ctx)
          && await ctx.one("SELECT id FROM agent_runtimes WHERE agent_id = ?", [id])) {
          throw new ConflictError("runtime_identity_immutable");
        }
        await ctx.exec(
          "UPDATE agents SET display_name = ?, host_type = ?, updated_at = ? WHERE id = ?",
          [displayName, hostType, nowIso(), id],
        );
      });
      return (await this.get(id))!;
    },
    async touchLastSeen(id, at) {
      const existing = await this.get(id);
      if (!existing) throw new NotFoundError(`Agent ${id} 不存在。`);
      await ctx.withTransaction(async () =>
        ctx.exec(
          "UPDATE agents SET last_seen_at = ?, updated_at = ? WHERE id = ?",
          [at, nowIso(), id],
        ),
      );
      return (await this.get(id))!;
    },
    async delete(id) {
      const result = await ctx.exec("DELETE FROM agents WHERE id = ?", [id]);
      if (result === 0) throw new NotFoundError(`Agent ${id} 不存在。`);
    },
  };
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

type ProjectRow = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? null,
  };
}

function createProjects(ctx: RepoCtx): ProjectsRepository {
  return {
    async create(input) {
      const name = requireNonEmpty(input.name, "Project.name");
      // 创建时指定顶层 manager（#48 / PROJECT-02）：agent 必须已存在，否则整体拒绝，
      // 不留半个项目（引用校验放在写入之前）。
      const managerAgentId = input.managerAgentId ?? null;
      let managerName: string | null = null;
      if (managerAgentId !== null) {
        const agent = await ctx.one<DisplayNameRow>(
          "SELECT display_name FROM agents WHERE id = ?",
          [managerAgentId],
        );
        if (!agent) {
          throw new InvalidReferenceError(
            `Agent ${managerAgentId} 不存在，无法在创建项目时指定为顶层 manager。`,
          );
        }
        managerName = agent.display_name;
      }
      const at = nowIso();
      const project: Project = { id: newId(), name, createdAt: at, updatedAt: at, archivedAt: null };
      await ctx.withTransaction(async () => {
        await ctx.exec(
          "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
          [project.id, project.name, project.createdAt, project.updatedAt],
        );
        if (managerAgentId !== null && managerName !== null) {
          await ctx.exec(
            `INSERT INTO members (id, project_id, agent_id, kind, display_name, role, created_at, updated_at)
             VALUES (?, ?, ?, 'agent', ?, 'manager', ?, ?)`,
            [newId(), project.id, managerAgentId, managerName, at, at],
          );
        }
      });
      return project;
    },
    async get(id) {
      const row = await ctx.one<ProjectRow>("SELECT * FROM projects WHERE id = ?", [id]);
      return row ? toProject(row) : null;
    },
    async list(options = {}) {
      const where = options.includeArchived ? "" : "WHERE archived_at IS NULL";
      return (await ctx.query<ProjectRow>(`SELECT * FROM projects ${where} ORDER BY created_at, id`)).map(toProject);
    },
    async rename(id, name) {
      const value = requireNonEmpty(name, "Project.name");
      const result = await ctx.exec(
        "UPDATE projects SET name = ?, updated_at = ? WHERE id = ?",
        [value, nowIso(), id],
      );
      if (result === 0) throw new NotFoundError(`Project ${id} 不存在。`);
      return (await this.get(id))!;
    },
    async archive(id, at) {
      const existing = await this.get(id);
      if (!existing) throw new NotFoundError(`Project ${id} 不存在。`);
      if (existing.archivedAt !== null) return existing;
      const stamp = at ?? nowIso();
      await ctx.withTransaction(async () =>
        ctx.exec(
          "UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?",
          [stamp, stamp, id],
        ),
      );
      return (await this.get(id))!;
    },
    async restore(id) {
      const existing = await this.get(id);
      if (!existing) throw new NotFoundError(`Project ${id} 不存在。`);
      if (existing.archivedAt === null) return existing;
      await ctx.withTransaction(async () =>
        ctx.exec(
          "UPDATE projects SET archived_at = NULL, updated_at = ? WHERE id = ?",
          [nowIso(), id],
        ),
      );
      return (await this.get(id))!;
    },
    async previewPurge(id) {
      if (!(await this.get(id))) throw new NotFoundError(`Project ${id} 不存在。`);
      return projectPurgeCounts(ctx, id);
    },
    async purge(id) {
      if (!(await this.get(id))) throw new NotFoundError(`Project ${id} 不存在。`);
      return ctx.withTransaction(async () => {
        await requireManagedStopped(ctx, "project", id);
        const counts = await projectPurgeCounts(ctx, id);
        if (await hasTasksSchema(ctx)) {
          for (const table of ["work_events", "task_comments", "task_history", "task_message_links", "task_review_reports", "task_review_rounds", "tasks", "project_task_settings"]) {
            await ctx.exec(`DELETE FROM ${table} WHERE project_id = ?`, [id]);
          }
        }
        // 显式「子 → 父」顺序，而不是只依赖外键级联：清单与实际清除的行必须一一对得上，
        // 也让 PG 重写（M1 #54）时不依赖特定级联顺序。
        await ctx.exec("DELETE FROM message_deliveries WHERE project_id = ?", [id]);
        await ctx.exec(
          "DELETE FROM messages WHERE group_id IN (SELECT id FROM groups WHERE project_id = ?)",
          [id],
        );
        await ctx.exec(
          "DELETE FROM group_participants WHERE group_id IN (SELECT id FROM groups WHERE project_id = ?)",
          [id],
        );
        await ctx.exec("DELETE FROM groups WHERE project_id = ?", [id]);
        await ctx.exec("DELETE FROM mcp_sessions WHERE project_id = ?", [id]);
        await ctx.exec("DELETE FROM member_statuses WHERE project_id = ?", [id]);
        await ctx.exec("DELETE FROM members WHERE project_id = ?", [id]);
        // T2 #49：members 先删（node_id 外键指向 org_nodes），再清组织岗位，避免悬空引用。
        await ctx.exec("DELETE FROM org_nodes WHERE project_id = ?", [id]);
        const removed = await ctx.exec("DELETE FROM projects WHERE id = ?", [id]);
        if (removed === 0) throw new NotFoundError(`Project ${id} 不存在。`);
        return counts;
      });
    },
    async delete(id) {
      await ctx.withTransaction(async () => {
        await requireManagedStopped(ctx, "project", id);
        const result = await ctx.exec("DELETE FROM projects WHERE id = ?", [id]);
        if (result === 0) throw new NotFoundError(`Project ${id} 不存在。`);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

type MemberRow = {
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
};

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

function createMembers(ctx: RepoCtx): MembersRepository {
  const projectExistsSql = "SELECT 1 FROM projects WHERE id = ?";
  const agentExistsSql = "SELECT 1 FROM agents WHERE id = ?";
  /**
   * 阶段 1 兼容投影的唯一性（D2「每项目最多一个顶层 manager」）。
   * 原 `ux_members_project_manager` 部分唯一索引已按决策票 #24 移除（与多层树冲突），
   * 不变量下沉到这条查询——legacy `role='manager'` 只作为阶段 1 兼容与
   * `PUT /api/projects/:id/manager`、`projectView.manager` 的投影存在；
   * 真实顶层岗位由组织树根节点（`org_nodes`，`role='top_manager'`）表达。
   */
  const otherManagerSql = "SELECT id FROM members WHERE project_id = ? AND role = 'manager' AND id <> ? LIMIT 1";

  async function requireNoOtherManager(projectId: string, selfId: string): Promise<void> {
    const clash = await ctx.one<IdRow>(otherManagerSql, [projectId, selfId]);
    if (clash) {
      throw new ConflictError(
        `项目 ${projectId} 已有顶层 manager（成员 ${clash.id}）；阶段 1 语义下每项目最多一个，请先更换。`,
      );
    }
  }

  const repo: MembersRepository = {
    async create(input) {
      if (!(await ctx.one(projectExistsSql, [input.projectId]))) {
        throw new InvalidReferenceError(`项目 ${input.projectId} 不存在，无法添加成员。`);
      }
      await requireProjectActive(ctx, input.projectId, "添加项目成员");
      const displayName = requireNonEmpty(input.displayName, "Member.displayName");
      if (input.kind !== "agent" && input.kind !== "human") {
        throw new InvalidArgumentError(`Member.kind 必须是 agent 或 human，收到：${String(input.kind)}。`);
      }
      let agentId: string | null = input.agentId ?? null;
      if (input.kind === "agent") {
        if (agentId === null) {
          throw new InvalidArgumentError("agent 类型成员必须提供 agentId。");
        }
        if (!(await ctx.one(agentExistsSql, [agentId]))) {
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
      await ctx.withTransaction(async () => {
        if (role === "manager") await requireNoOtherManager(input.projectId, id);
        await ctx.exec(
          `INSERT INTO members (id, project_id, agent_id, kind, display_name, role, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, input.projectId, agentId, input.kind, displayName, role, status, at, at],
        );
      });
      return (await repo.get(id))!;
    },
    async get(id) {
      const row = await ctx.one<MemberRow>("SELECT * FROM members WHERE id = ?", [id]);
      return row ? toMember(row) : null;
    },
    async listByProject(projectId) {
      return (await ctx.query<MemberRow>(
        "SELECT * FROM members WHERE project_id = ? ORDER BY created_at, id",
        [projectId],
      )).map(toMember);
    },
    async findByAgent(projectId, agentId) {
      const row = await ctx.one<MemberRow>(
        "SELECT * FROM members WHERE project_id = ? AND agent_id = ?",
        [projectId, agentId],
      );
      return row ? toMember(row) : null;
    },
    async getManager(projectId) {
      const row = await ctx.one<MemberRow>(
        "SELECT * FROM members WHERE project_id = ? AND role = 'manager' LIMIT 1",
        [projectId],
      );
      return row ? toMember(row) : null;
    },
    async update(id, patch) {
      const existing = await this.get(id);
      if (!existing) throw new NotFoundError(`成员 ${id} 不存在。`);
      await requireProjectActive(ctx, existing.projectId, "更新项目成员");
      const displayName =
        patch.displayName === undefined ? existing.displayName : requireNonEmpty(patch.displayName, "Member.displayName");
      const role =
        patch.role === undefined ? existing.role : requireNonEmpty(patch.role, "Member.role");
      await ctx.withTransaction(async () => {
        if (role === "manager" && existing.role !== "manager") {
          // 阶段 1 语义：每项目至多一个顶层 manager，提升第二名为 manager 必须拒绝。
          await requireNoOtherManager(existing.projectId, id);
        }
        await ctx.exec(
          "UPDATE members SET display_name = ?, role = ?, updated_at = ? WHERE id = ?",
          [displayName, role, nowIso(), id],
        );
      });
      return (await this.get(id))!;
    },
    async setStatus(id, status) {
      const existing = await this.get(id);
      if (!existing) throw new NotFoundError(`成员 ${id} 不存在。`);
      await requireProjectActive(ctx, existing.projectId, "切换成员生命周期状态");
      if (!MEMBER_LIFECYCLE_STATUSES.includes(status)) {
        throw new InvalidArgumentError(`Member.status 必须是 active/disabled/pending，收到：${String(status)}。`);
      }
      if (existing.status === status) return existing;
      const allowed = MEMBER_STATUS_TRANSITIONS[existing.status];
      if (!allowed.includes(status)) {
        throw new ConflictError(
          `成员 ${id} 的生命周期状态 ${existing.status} 不能转换到 ${status}（合法转换：${allowed.join("/")}）。`,
        );
      }
      await ctx.withTransaction(async () =>
        ctx.exec(
          "UPDATE members SET status = ?, updated_at = ? WHERE id = ?",
          [status, nowIso(), id],
        ),
      );
      return (await this.get(id))!;
    },
    async delete(id) {
      await ctx.withTransaction(async () => {
        await requireManagedStopped(ctx, "member", id);
        const result = await ctx.exec("DELETE FROM members WHERE id = ?", [id]);
        if (result === 0) throw new NotFoundError(`成员 ${id} 不存在。`);
      });
    },
    async restoreRow(member) {
      await ctx.exec(
        `INSERT INTO members (id, project_id, agent_id, kind, display_name, role, status, node_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id, agent_id = excluded.agent_id, kind = excluded.kind,
           display_name = excluded.display_name, role = excluded.role, status = excluded.status,
           node_id = excluded.node_id, created_at = excluded.created_at, updated_at = excluded.updated_at`,
        [
          member.id, member.projectId, member.agentId, member.kind, member.displayName,
          member.role, member.status, member.nodeId, member.createdAt, member.updatedAt,
        ],
      );
    },
  };
  return repo;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

type GroupRow = {
  id: string;
  project_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

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

function createGroups(ctx: RepoCtx): GroupsRepository {
  const projectExistsSql = "SELECT 1 FROM projects WHERE id = ?";
  const memberInProjectSql = "SELECT 1 FROM members WHERE id = ? AND project_id = ?";
  const getGroupRowSql = "SELECT * FROM groups WHERE id = ?";

  const repo: GroupsRepository = {
    async create(input) {
      if (!(await ctx.one(projectExistsSql, [input.projectId]))) {
        throw new InvalidReferenceError(`项目 ${input.projectId} 不存在，无法创建群组。`);
      }
      await requireProjectActive(ctx, input.projectId, "在项目内创建群组");
      const name = requireNonEmpty(input.name, "Group.name");
      const participants = dedupe(input.participantMemberIds ?? []);
      for (const memberId of participants) {
        if (!(await ctx.one(memberInProjectSql, [memberId, input.projectId]))) {
          throw new InvalidReferenceError(
            `成员 ${memberId} 不属于项目 ${input.projectId}，不能加入该群组。`,
          );
        }
      }
      const at = nowIso();
      const id = newId();
      await ctx.withTransaction(async () => {
        await ctx.exec(
          "INSERT INTO groups (id, project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          [id, input.projectId, name, at, at],
        );
        for (const memberId of participants) {
          await ctx.exec(
            "INSERT INTO group_participants (group_id, member_id, joined_at) VALUES (?, ?, ?)",
            [id, memberId, at],
          );
        }
      });
      return (await repo.get(id))!;
    },
    async get(id) {
      const row = await ctx.one<GroupRow>(getGroupRowSql, [id]);
      return row ? toGroup(row) : null;
    },
    async listByProject(projectId, options = {}) {
      const where = options.includeArchived
        ? "WHERE project_id = ?"
        : "WHERE project_id = ? AND archived_at IS NULL";
      return (await ctx.query<GroupRow>(`SELECT * FROM groups ${where} ORDER BY created_at, id`, [projectId])).map(toGroup);
    },
    async archive(id, at) {
      const existing = await this.get(id);
      if (!existing) throw new NotFoundError(`Group ${id} 不存在。`);
      if (existing.archivedAt !== null) return existing;
      const stamp = at ?? nowIso();
      await ctx.withTransaction(async () =>
        ctx.exec(
          "UPDATE groups SET archived_at = ?, updated_at = ? WHERE id = ?",
          [stamp, stamp, id],
        ),
      );
      return (await this.get(id))!;
    },
    async restore(id) {
      const existing = await this.get(id);
      if (!existing) throw new NotFoundError(`Group ${id} 不存在。`);
      if (existing.archivedAt === null) return existing;
      await ctx.withTransaction(async () =>
        ctx.exec(
          "UPDATE groups SET archived_at = NULL, updated_at = ? WHERE id = ?",
          [nowIso(), id],
        ),
      );
      return (await this.get(id))!;
    },
    async previewPurge(id) {
      if (!(await repo.get(id))) throw new NotFoundError(`Group ${id} 不存在。`);
      return groupPurgeCounts(ctx, id);
    },
    async purge(id) {
      if (!(await repo.get(id))) throw new NotFoundError(`Group ${id} 不存在。`);
      return ctx.withTransaction(async () => {
        await requireManagedStopped(ctx, "group", id);
        const counts = await groupPurgeCounts(ctx, id);
        if (await hasTasksSchema(ctx)) await ctx.exec("DELETE FROM task_message_links WHERE group_id = ?", [id]);
        // 只清「群聊 + 参与者关系」（LIFE-ARC-02）：投递记录随消息一起清，
        // 会话记录随群组一起清；**members 与 member_statuses 一行都不动**。
        await ctx.exec(
          `DELETE FROM message_deliveries
             WHERE message_id IN (SELECT id FROM messages WHERE group_id = ?)`,
          [id],
        );
        await ctx.exec("DELETE FROM messages WHERE group_id = ?", [id]);
        await ctx.exec("DELETE FROM group_participants WHERE group_id = ?", [id]);
        await ctx.exec("DELETE FROM mcp_sessions WHERE group_id = ?", [id]);
        const removed = await ctx.exec("DELETE FROM groups WHERE id = ?", [id]);
        if (removed === 0) throw new NotFoundError(`Group ${id} 不存在。`);
        await cleanOrphanRuntimeMembers(ctx);
        return counts;
      });
    },
    async participants(groupId) {
      return (await ctx.query<MemberIdRow>(
        "SELECT member_id FROM group_participants WHERE group_id = ? ORDER BY joined_at, member_id",
        [groupId],
      )).map((row) => row.member_id);
    },
    async addParticipant(groupId, memberId) {
      const group = await repo.get(groupId);
      if (!group) throw new NotFoundError(`Group ${groupId} 不存在。`);
      // 归档 = 非活跃态：不再接受新参与者（含 MCP 入群时落到本群组的 addParticipant）。
      await requireGroupActive(ctx, groupId, "把成员加入群组");
      if (!(await ctx.one(memberInProjectSql, [memberId, group.projectId]))) {
        throw new InvalidReferenceError(
          `成员 ${memberId} 不属于项目 ${group.projectId}，不能加入该群组。`,
        );
      }
      await ctx.exec(
        "INSERT INTO group_participants (group_id, member_id, joined_at) VALUES (?, ?, ?) ON CONFLICT (group_id, member_id) DO NOTHING",
        [groupId, memberId, nowIso()],
      );
    },
    async removeParticipant(groupId, memberId) {
      await ctx.exec(
        "DELETE FROM group_participants WHERE group_id = ? AND member_id = ?",
        [groupId, memberId],
      );
    },
    // T5 #52：撤销补偿：直接补回一条参与者关系（INSERT OR IGNORE），
    // 故意不跑 requireGroupActive——撤销复原的是删除前的历史参与事实。
    async restoreParticipant(groupId, memberId) {
      await ctx.exec(
        "INSERT INTO group_participants (group_id, member_id, joined_at) VALUES (?, ?, ?) ON CONFLICT (group_id, member_id) DO NOTHING",
        [groupId, memberId, nowIso()],
      );
    },
    async delete(id) {
      await ctx.withTransaction(async () => {
        await requireManagedStopped(ctx, "group", id);
        const result = await ctx.exec("DELETE FROM groups WHERE id = ?", [id]);
        if (result === 0) throw new NotFoundError(`Group ${id} 不存在。`);
        await cleanOrphanRuntimeMembers(ctx);
      });
    },
  };
  return repo;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

type MessageRow = {
  id: string;
  group_id: string;
  sender_member_id: string;
  seq: number;
  body: string;
  mentions: string;
  created_at: string;
};

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

function createMessages(ctx: RepoCtx, driverKind: DbDriver["kind"]): MessagesRepository {
  return {
    async create(input) {
      // 前置校验：错误必须明确，不留给数据库外键泛化报错。
      return ctx.withTransaction(async () => {
        const group = await ctx.one<ProjectIdRow>(
          `SELECT project_id FROM groups WHERE id = ?${driverKind === "postgres" ? " FOR UPDATE" : ""}`,
          [input.groupId],
        );
        if (!group) throw new InvalidReferenceError(`群组 ${input.groupId} 不存在，无法发送消息。`);
        await requireGroupActive(ctx, input.groupId, "向群组发送消息");

        const sender = await ctx.one<ProjectIdRow>(
          "SELECT project_id FROM members WHERE id = ?",
          [input.senderMemberId],
        );
        if (!sender) throw new InvalidReferenceError(`发送者成员 ${input.senderMemberId} 不存在。`);
        if (sender.project_id !== group.project_id) {
          throw new InvalidReferenceError("发送者不属于该群组所在项目。");
        }
        const isParticipant = await ctx.one(
          "SELECT 1 FROM group_participants WHERE group_id = ? AND member_id = ?",
          [input.groupId, input.senderMemberId],
        );
        if (!isParticipant) {
          throw new InvalidReferenceError(`发送者 ${input.senderMemberId} 不是群组 ${input.groupId} 的参与者。`);
        }

        const body = requireNonEmpty(input.body, "Message.body");
        const mentions = dedupe(input.mentions ?? []);
        // mentions 里的成员必须存在且属于同项目（避免悬空/跨项目）。
        for (const memberId of mentions) {
          const m = await ctx.one<ProjectIdRow>(
            "SELECT project_id FROM members WHERE id = ?",
            [memberId],
          );
          if (!m) throw new InvalidReferenceError(`被 @ 的成员 ${memberId} 不存在。`);
          if (m.project_id !== group.project_id) {
            throw new InvalidReferenceError(`被 @ 的成员 ${memberId} 不属于该项目。`);
          }
        }

        const id = input.id ?? newId();
        if (await ctx.one("SELECT 1 FROM messages WHERE id = ?", [id])) {
          throw new ConflictError(`消息 ID ${id} 已存在，拒绝重复插入。`);
        }
        // 群组内 seq = max+1；同一事务内串行化。失败回滚时不消耗序号。
        const maxRow = await ctx.one<MaxRow>(
          "SELECT COALESCE(MAX(seq), 0) AS max FROM messages WHERE group_id = ?",
          [input.groupId],
        );
        const seq = Number(maxRow?.max ?? 0) + 1;
        const at = nowIso();
        await ctx.exec(
          `INSERT INTO messages (id, group_id, sender_member_id, seq, body, mentions, created_at, client_message_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, input.groupId, input.senderMemberId, seq, body, JSON.stringify(mentions), at, input.clientMessageId || null],
        );

        const row = await ctx.one<MessageRow>("SELECT * FROM messages WHERE id = ?", [id]);
        return toMessage(row!);
      });
    },
    async get(id) {
      const row = await ctx.one<MessageRow>("SELECT * FROM messages WHERE id = ?", [id]);
      return row ? toMessage(row) : null;
    },
    async findByClientKey(senderMemberId, clientMessageId) {
      const row = await ctx.one<MessageRow>(
        "SELECT * FROM messages WHERE sender_member_id = ? AND client_message_id = ?",
        [senderMemberId, clientMessageId],
      );
      return row ? toMessage(row) : null;
    },
    async listByGroup(groupId, options = {}) {
      const afterSeq = options.afterSeq ?? 0;
      const limit = options.limit ?? -1;
      const params: unknown[] = [groupId, afterSeq];
      let sql = "SELECT * FROM messages WHERE group_id = ? AND seq > ? ORDER BY seq";
      // #61/PG：SQLite 接受 LIMIT -1 表示「不限」，但 PostgreSQL 拒绝负数 LIMIT。
      // 统一在 limit<=0 时省略 LIMIT 子句（两方言均支持）。
      if (limit > 0) {
        sql += " LIMIT ?";
        params.push(limit);
      }
      return (await ctx.query<MessageRow>(sql, params)).map(toMessage);
    },
    async countByProject(projectId) {
      const row = await ctx.one<CountRow>(
        `SELECT COUNT(*) AS c FROM messages m JOIN groups g ON g.id = m.group_id WHERE g.project_id = ?`,
        [projectId],
      );
      return Number(row?.c ?? 0);
    },
    async latestByProject(projectId) {
      const row = await ctx.one<LatestRow>(
        `SELECT MAX(m.created_at) AS t FROM messages m JOIN groups g ON g.id = m.group_id WHERE g.project_id = ?`,
        [projectId],
      );
      return row?.t ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// MessageDeliveries
// ---------------------------------------------------------------------------

type DeliveryRow = {
  id: string;
  message_id: string;
  member_id: string;
  project_id: string;
  status: string;
  wake_decision: MessageDelivery["wakeDecision"];
  wake_suppressed_reason: MessageDelivery["wakeSuppressedReason"];
  attempt_count: number;
  first_delivered_at: string | null;
  last_delivered_at: string | null;
  acked_at: string | null;
  created_at: string;
  updated_at: string;
};

function toDelivery(row: DeliveryRow): MessageDelivery {
  return {
    id: row.id,
    messageId: row.message_id,
    memberId: row.member_id,
    projectId: row.project_id,
    status: row.status as DeliveryStatus,
    wakeDecision: row.wake_decision,
    wakeSuppressedReason: row.wake_suppressed_reason,
    attemptCount: row.attempt_count,
    firstDeliveredAt: row.first_delivered_at,
    lastDeliveredAt: row.last_delivered_at,
    ackedAt: row.acked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createDeliveries(ctx: RepoCtx): DeliveriesRepository {
  const getRowSql = "SELECT * FROM message_deliveries WHERE message_id = ? AND member_id = ?";

  const getRow = async (messageId: string, memberId: string): Promise<DeliveryRow | undefined> =>
    ctx.one<DeliveryRow>(getRowSql, [messageId, memberId]);

  const repo: DeliveriesRepository = {
    async ensure(messageId, memberId, wake) {
      return ctx.withTransaction(async () => {
        const existing = await getRow(messageId, memberId);
        if (existing) return toDelivery(existing);

        const message = await ctx.one<GroupIdRow>("SELECT group_id FROM messages WHERE id = ?", [messageId]);
        if (!message) throw new InvalidReferenceError(`消息 ${messageId} 不存在，无法创建投递。`);
        const member = await ctx.one<ProjectIdRow>("SELECT project_id FROM members WHERE id = ?", [memberId]);
        if (!member) throw new InvalidReferenceError(`成员 ${memberId} 不存在，无法创建投递。`);

        const at = nowIso();
        const id = newId();
        await ctx.exec(
          `INSERT INTO message_deliveries
             (id, message_id, member_id, project_id, status, attempt_count,
              first_delivered_at, last_delivered_at, acked_at, created_at, updated_at,
              wake_decision, wake_suppressed_reason)
           VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?, ?, ?, ?)`,
          [id, messageId, memberId, member.project_id, at, at,
            wake?.decision ?? null, wake?.decision === "suppressed" ? wake.reason : null],
        );
        return toDelivery((await getRow(messageId, memberId))!);
      });
    },
    async get(messageId, memberId) {
      const row = await getRow(messageId, memberId);
      return row ? toDelivery(row) : null;
    },
    async recordAttempt(messageId, memberId, status, at) {
      if (!DELIVERY_STATUSES.includes(status)) {
        throw new InvalidArgumentError(`非法投递状态：${String(status)}。`);
      }
      const timestamp = at ?? nowIso();
      await repo.ensure(messageId, memberId);
      return ctx.withTransaction(async () => {
        const current = (await getRow(messageId, memberId))!;
        const firstDelivered = current.first_delivered_at ?? (status !== "pending" ? timestamp : null);
        const ackedAt = status === "acked" ? (current.acked_at ?? timestamp) : current.acked_at;
        await ctx.exec(
          `UPDATE message_deliveries
             SET status = ?, attempt_count = attempt_count + 1,
                 first_delivered_at = ?, last_delivered_at = ?, acked_at = ?, updated_at = ?
           WHERE message_id = ? AND member_id = ?`,
          [status, firstDelivered, timestamp, ackedAt, timestamp, messageId, memberId],
        );
        return toDelivery((await getRow(messageId, memberId))!);
      });
    },
    async listPending(projectId, memberId) {
      return (await ctx.query<DeliveryRow>(
        `SELECT d.* FROM message_deliveries d
           JOIN messages m ON m.id = d.message_id
          WHERE d.project_id = ? AND d.member_id = ? AND d.status <> 'acked'
          ORDER BY m.group_id, m.seq`,
        [projectId, memberId],
      )).map(toDelivery);
    },
    async listWakeable(projectId, memberId) {
      return (await ctx.query<DeliveryRow>(
        `SELECT d.* FROM message_deliveries d JOIN messages m ON m.id = d.message_id
          WHERE d.project_id = ? AND d.member_id = ? AND d.status <> 'acked'
            AND d.wake_decision = 'allowed' ORDER BY m.group_id, m.seq`,
        [projectId, memberId],
      )).map(toDelivery);
    },
    async delete(messageId, memberId) {
      await ctx.exec(
        "DELETE FROM message_deliveries WHERE message_id = ? AND member_id = ?",
        [messageId, memberId],
      );
    },
  };
  return repo;
}

// ---------------------------------------------------------------------------
// MemberStatuses
// ---------------------------------------------------------------------------

type StatusRow = {
  project_id: string;
  member_id: string;
  state: string;
  updated_at: string;
};

function toStatus(row: StatusRow): MemberStatus {
  return {
    projectId: row.project_id,
    memberId: row.member_id,
    state: row.state as MemberState,
    updatedAt: row.updated_at,
  };
}

function createStatuses(ctx: RepoCtx): StatusesRepository {
  return {
    async set(projectId, memberId, state) {
      if (!MEMBER_STATES.includes(state)) {
        throw new InvalidArgumentError(`非法成员状态：${String(state)}，允许：${MEMBER_STATES.join("/")}。`);
      }
      const member = await ctx.one<ProjectIdRow>("SELECT project_id FROM members WHERE id = ?", [memberId]);
      if (!member) throw new InvalidReferenceError(`成员 ${memberId} 不存在，无法记录状态。`);
      if (member.project_id !== projectId) {
        throw new InvalidReferenceError(`成员 ${memberId} 不属于项目 ${projectId}。`);
      }
      const at = nowIso();
      await ctx.exec(
        `INSERT INTO member_statuses (project_id, member_id, state, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, member_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
        [projectId, memberId, state, at],
      );
      return { projectId, memberId, state, updatedAt: at };
    },
    async get(projectId, memberId) {
      const row = await ctx.one<StatusRow>(
        "SELECT * FROM member_statuses WHERE project_id = ? AND member_id = ?",
        [projectId, memberId],
      );
      return row ? toStatus(row) : null;
    },
    async listByProject(projectId) {
      return (await ctx.query<StatusRow>(
        "SELECT * FROM member_statuses WHERE project_id = ? ORDER BY member_id",
        [projectId],
      )).map(toStatus);
    },
    async delete(projectId, memberId) {
      await ctx.exec(
        "DELETE FROM member_statuses WHERE project_id = ? AND member_id = ?",
        [projectId, memberId],
      );
    },
  };
}

// ---------------------------------------------------------------------------
// McpSessions（MCP 连接状态，全局层 D1；与 member_statuses 分开）
// ---------------------------------------------------------------------------

type McpSessionRow = {
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
};

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

function createMcpSessions(ctx: RepoCtx): McpSessionsRepository {
  const repo: McpSessionsRepository = {
    async connect(input) {
      return ctx.withTransaction(async () => {
        const existing = await repo.findActive(input.agentId, input.projectId, input.groupId);
        const at = nowIso();
        if (existing) {
          // 复用同一活跃会话；刷新成员/显示名与心跳，不改变 connected_at（会话连续性）。
          await ctx.exec(
            `UPDATE mcp_sessions
               SET member_id = ?, display_name = ?, host_type = ?, last_heartbeat_at = ?, updated_at = ?
             WHERE id = ?`,
            [input.memberId, input.displayName, input.hostType, at, at, existing.id],
          );
          return (await repo.get(existing.id))!;
        }
        const id = newId();
        await ctx.exec(
          `INSERT INTO mcp_sessions
             (id, agent_id, project_id, group_id, member_id, display_name, host_type, state,
              connected_at, last_heartbeat_at, disconnected_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?, NULL, ?)`,
          [
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
          ],
        );
        return (await repo.get(id))!;
      });
    },
    async get(id) {
      const row = await ctx.one<McpSessionRow>("SELECT * FROM mcp_sessions WHERE id = ?", [id]);
      return row ? toMcpSession(row) : null;
    },
    async findActive(agentId, projectId, groupId) {
      const row = await ctx.one<McpSessionRow>(
        `SELECT * FROM mcp_sessions
          WHERE agent_id = ? AND project_id = ? AND group_id = ? AND state = 'connected'
          ORDER BY connected_at DESC, id DESC LIMIT 1`,
        [agentId, projectId, groupId],
      );
      return row ? toMcpSession(row) : null;
    },
    async listByProject(projectId) {
      return (await ctx.query<McpSessionRow>(
        "SELECT * FROM mcp_sessions WHERE project_id = ? ORDER BY connected_at, id",
        [projectId],
      )).map(toMcpSession);
    },
    async heartbeat(id, at) {
      const row = await repo.get(id);
      if (!row) throw new NotFoundError(`MCP 会话 ${id} 不存在。`);
      await ctx.withTransaction(async () =>
        ctx.exec(
          "UPDATE mcp_sessions SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?",
          [at, at, id],
        ),
      );
      return (await repo.get(id))!;
    },
    async disconnect(id, at) {
      const row = await repo.get(id);
      if (!row) throw new NotFoundError(`MCP 会话 ${id} 不存在。`);
      if (row.state === "disconnected") return (await repo.get(id))!;
      await ctx.withTransaction(async () =>
        ctx.exec(
          "UPDATE mcp_sessions SET state = 'disconnected', disconnected_at = ?, updated_at = ? WHERE id = ?",
          [at, at, id],
        ),
      );
      return (await repo.get(id))!;
    },
    async markAllStale(at) {
      return ctx.withTransaction(async () => {
        const result = await ctx.exec(
          "UPDATE mcp_sessions SET state = 'disconnected', disconnected_at = ?, updated_at = ? WHERE state = 'connected'",
          [at, at],
        );
        return result;
      });
    },
    async delete(id) {
      await ctx.exec("DELETE FROM mcp_sessions WHERE id = ?", [id]);
    },
  };
  return repo;
}

// ---------------------------------------------------------------------------
// Org（T2 #49 / 决策票 #24、#25）
// ---------------------------------------------------------------------------

/** 岗位角色的静态枚举（与 F2 `AUTHZ_ROLES` 同值）；`owner` 是人的内建角色，不建岗。 */
const ORG_NODE_ROLES: readonly OrgNodeRole[] = ["owner", "top_manager", "sub_manager", "member"];

type OrgNodeRow = {
  id: string;
  project_id: string;
  parent_id: string | null;
  name: string;
  role: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

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
 * - 一人一岗、一岗一实例（`ux_members_node`，AC-ORG-05）。
 * - 阶段 1 兼容投影：legacy `members.role='manager'` 只由「占据根岗位」的成员持有；
 *   无组织树数据的库（v3→v4 升级默认无）不受影响，兼容映射继续可用。
 */
function createOrg(ctx: RepoCtx): OrgRepository {
  const projectExistsSql = "SELECT 1 FROM projects WHERE id = ?";
  const nodeByIdSql = "SELECT * FROM org_nodes WHERE id = ?";
  const memberByIdSql = "SELECT * FROM members WHERE id = ?";
  const childrenOfSql = "SELECT COUNT(*) AS c FROM org_nodes WHERE parent_id = ?";
  const rootOfProjectSql = "SELECT * FROM org_nodes WHERE project_id = ? AND parent_id IS NULL";
  /**
   * 子树边界（#24）：`WITH RECURSIVE` 现算，含自身。统一 `?` 占位符，
   * 经 F1 方言抽象可原样渲染到 SQLite / PostgreSQL 的 `$1`。
   * 不建闭包表：本地单用户、数据量小，现算足够；防环由应用层保证不会死循环。
   */
  const subtreeSql = `WITH RECURSIVE subtree(id) AS (
       SELECT id FROM org_nodes WHERE id = ?
       UNION ALL
       SELECT n.id FROM org_nodes n JOIN subtree s ON n.parent_id = s.id
     )
     SELECT id FROM subtree`;

  async function getRow(id: string): Promise<OrgNodeRow | null> {
    return (await ctx.one<OrgNodeRow>(nodeByIdSql, [id])) ?? null;
  }

  async function get(id: string): Promise<OrgNode | null> {
    const row = await getRow(id);
    return row ? toOrgNode(row) : null;
  }

  async function subtreeNodeIds(nodeId: string): Promise<string[]> {
    if (!(await getRow(nodeId))) return [];
    return (await ctx.query<IdRow>(subtreeSql, [nodeId])).map((row) => row.id);
  }

  async function requireProject(projectId: string): Promise<void> {
    if (!(await ctx.one(projectExistsSql, [projectId]))) {
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
  async function applyAssignment(memberRow: MemberRow, nodeId: string | null, isRoot: boolean, at: string): Promise<void> {
    if (isRoot) {
      await ctx.exec(
        "UPDATE members SET role = 'normal', updated_at = ? WHERE project_id = ? AND role = 'manager' AND id <> ?",
        [at, memberRow.project_id, memberRow.id],
      );
    }
    const role = isRoot ? "manager" : memberRow.role === "manager" ? "normal" : memberRow.role;
    await ctx.exec(
      "UPDATE members SET node_id = ?, role = ?, updated_at = ? WHERE id = ?",
      [nodeId, role, at, memberRow.id],
    );
  }

  const repo: OrgRepository = {
    async createNode(input) {
      await requireProject(input.projectId);
      await requireProjectActive(ctx, input.projectId, "建立组织岗位");
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
        if (await ctx.one(rootOfProjectSql, [input.projectId])) {
          throw new ConflictError(`项目 ${input.projectId} 已有根岗位（顶层 manager），每项目最多一个。`);
        }
      } else {
        if (role === "top_manager") {
          throw new InvalidArgumentError("只有根岗位可以是 top_manager；下级 manager 请用 sub_manager。");
        }
        const parent = await getRow(parentId);
        if (!parent) throw new InvalidReferenceError(`父岗位 ${parentId} 不存在。`);
        if (parent.project_id !== input.projectId) {
          throw new InvalidReferenceError(`父岗位 ${parentId} 不属于项目 ${input.projectId}，不能跨项目建岗。`);
        }
      }

      const at = nowIso();
      const id = newId();
      await ctx.withTransaction(async () =>
        ctx.exec(
          `INSERT INTO org_nodes (id, project_id, parent_id, name, role, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, input.projectId, parentId, name, role, sortOrder, at, at],
        ),
      );
      return (await get(id))!;
    },

    getNode: get,

    async listNodes(projectId) {
      // 层级展示顺序：父 → 子（递归 CTE 算深度），同级按 sort_order / created_at 稳定排序。
      const rows = await ctx.query<OrgNodeRow>(
        `WITH RECURSIVE tree(id, depth) AS (
             SELECT id, 0 FROM org_nodes WHERE project_id = ? AND parent_id IS NULL
             UNION ALL
             SELECT n.id, t.depth + 1 FROM org_nodes n JOIN tree t ON n.parent_id = t.id
           )
           SELECT o.* FROM org_nodes o
             LEFT JOIN tree t ON t.id = o.id
           WHERE o.project_id = ?
           ORDER BY COALESCE(t.depth, 0), o.sort_order, o.created_at, o.id`,
        [projectId, projectId],
      );
      return rows.map(toOrgNode);
    },

    async getRootNode(projectId) {
      const row = await ctx.one<OrgNodeRow>(rootOfProjectSql, [projectId]);
      return row ? toOrgNode(row) : null;
    },

    subtreeNodeIds,

    async updateNode(id, patch) {
      const row = await getRow(id);
      if (!row) throw new NotFoundError(`组织岗位 ${id} 不存在。`);
      await requireProjectActive(ctx, row.project_id, "调整组织岗位");

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
          const parent = await getRow(target);
          if (!parent) throw new InvalidReferenceError(`父岗位 ${target} 不存在。`);
          if (parent.project_id !== row.project_id) {
            throw new InvalidReferenceError(`父岗位 ${target} 不属于同一项目，不能跨项目调整汇报线。`);
          }
          // 防环：目标父不能是本岗位的子孙（子树递归 CTE 现算，含自身）。
          if ((await subtreeNodeIds(id)).includes(target)) {
            throw new InvalidArgumentError("汇报线调整会形成环：目标父岗位是本岗位的子孙。");
          }
          parentId = target;
        }
      }

      const sortOrder = patch.sortOrder ?? row.sort_order;
      validateSortOrder(sortOrder);
      await ctx.withTransaction(async () =>
        ctx.exec(
          "UPDATE org_nodes SET parent_id = ?, name = ?, role = ?, sort_order = ?, updated_at = ? WHERE id = ?",
          [parentId, name, role, sortOrder, nowIso(), id],
        ),
      );
      return (await get(id))!;
    },

    async deleteNode(id) {
      const row = await getRow(id);
      if (!row) throw new NotFoundError(`组织岗位 ${id} 不存在。`);
      await requireProjectActive(ctx, row.project_id, "删除组织岗位");
      const childRow = await ctx.one<CountRow>(childrenOfSql, [id]);
      const childCount = Number(childRow?.c ?? 0);
      if (row.parent_id === null && childCount > 0) {
        throw new InvalidArgumentError("根岗位还有下级岗位，不能直接删除（否则会出现多个根）；请先调整汇报线。");
      }
      await ctx.withTransaction(async () => {
        // 子树提升到被删节点的父（不级联删；无子节点的根删除时该 UPDATE 无匹配行）。
        await ctx.exec(
          "UPDATE org_nodes SET parent_id = ?, updated_at = ? WHERE parent_id = ?",
          [row.parent_id, nowIso(), id],
        );
        // members.node_id ON DELETE SET NULL：占据成员腾出岗位，成员本身保留。
        await ctx.exec("DELETE FROM org_nodes WHERE id = ?", [id]);
      });
    },

    async assignNode(memberId, nodeId) {
      const memberRow = await ctx.one<MemberRow>(memberByIdSql, [memberId]);
      if (!memberRow) throw new NotFoundError(`成员 ${memberId} 不存在。`);
      let nodeRow: OrgNodeRow | null = null;
      if (nodeId !== null) {
        nodeRow = await getRow(nodeId);
        if (!nodeRow) throw new InvalidReferenceError(`组织岗位 ${nodeId} 不存在。`);
        if (nodeRow.project_id !== memberRow.project_id) {
          throw new InvalidReferenceError(`岗位 ${nodeId} 与成员 ${memberId} 不属于同一项目，拒绝跨项目占岗。`);
        }
      }
      await requireProjectActive(ctx, memberRow.project_id, "分配成员岗位");
      const isRoot = nodeRow !== null && nodeRow.parent_id === null;
      await ctx.withTransaction(async () => applyAssignment(memberRow, nodeId, isRoot, nowIso()));
      return toMember((await ctx.one<MemberRow>(memberByIdSql, [memberId]))!);
    },

    async autoPlaceMember(projectId, memberId) {
      const memberRow = await ctx.one<MemberRow>(memberByIdSql, [memberId]);
      if (!memberRow) throw new NotFoundError(`成员 ${memberId} 不存在。`);
      if (memberRow.project_id !== projectId) {
        throw new InvalidReferenceError(`成员 ${memberId} 不属于项目 ${projectId}。`);
      }
      await requireProjectActive(ctx, projectId, "自动分配成员岗位");
      // 幂等：已落位的成员返回其现有岗位，不重复建岗。
      if (memberRow.node_id !== null) {
        const existing = await get(memberRow.node_id);
        if (existing) return existing;
      }
      const rootRow = await ctx.one<OrgNodeRow>(rootOfProjectSql, [projectId]);
      // 阶段 1 兼容：项目尚无组织树时不自动造树（升级路径默认无组织数据）。
      if (!rootRow) return null;
      const at = nowIso();
      const nodeId = newId();
      await ctx.withTransaction(async () => {
        await ctx.exec(
          `INSERT INTO org_nodes (id, project_id, parent_id, name, role, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'member', 0, ?, ?)`,
          [nodeId, projectId, rootRow.id, memberRow.display_name, at, at],
        );
        await applyAssignment(memberRow, nodeId, false, at);
      });
      return (await get(nodeId))!;
    },

    async nodeOfMember(memberId) {
      const row = await ctx.one<MemberRow>(memberByIdSql, [memberId]);
      if (!row || row.node_id === null) return null;
      return get(row.node_id);
    },
    // T5 #52：按 before 快照直接复原岗位行（撤销补偿，upsert）。
    async restoreRow(node) {
      await ctx.exec(
        `INSERT INTO org_nodes
           (id, project_id, parent_id, name, role, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id, parent_id = excluded.parent_id, name = excluded.name,
           role = excluded.role, sort_order = excluded.sort_order,
           created_at = excluded.created_at, updated_at = excluded.updated_at`,
        [
          node.id, node.projectId, node.parentId, node.name, node.role,
          node.sortOrder, node.createdAt, node.updatedAt,
        ],
      );
    },
  };
  return repo;
}

// ---------------------------------------------------------------------------

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
