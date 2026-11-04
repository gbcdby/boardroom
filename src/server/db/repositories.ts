import type Database from "better-sqlite3";
import {
  ConflictError,
  InvalidArgumentError,
  InvalidReferenceError,
  NotFoundError,
  RepositoryError,
  WriteFailedError,
} from "./errors.ts";
import { newId } from "./ids.ts";
import type {
  Agent,
  DeliveryStatus,
  Group,
  McpSession,
  McpSessionState,
  Member,
  MemberRole,
  MemberState,
  MemberStatus,
  Message,
  MessageDelivery,
  NewAgent,
  NewGroup,
  NewMember,
  NewMessage,
  NewProject,
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
  delete(id: string): void;
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
  participants(groupId: string): string[];
  addParticipant(groupId: string, memberId: string): void;
  removeParticipant(groupId: string, memberId: string): void;
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
  readonly groups: GroupsRepository;
  readonly messages: MessagesRepository;
  readonly deliveries: DeliveriesRepository;
  readonly statuses: StatusesRepository;
  readonly mcpSessions: McpSessionsRepository;
  /** 在单个写事务内运行 fn；失败回滚并抛出归一化后的错误。 */
  transaction<T>(fn: () => T): T;
}

const MEMBER_ROLES: readonly MemberRole[] = ["manager", "normal"];
const MEMBER_STATES: readonly MemberState[] = ["online", "offline", "waiting", "working"];
const DELIVERY_STATUSES: readonly DeliveryStatus[] = ["pending", "delivered", "acked"];

/** 创建 repository 集合；同一 db 连接共享。 */
export function createRepositories(db: Database.Database): RepositorySet {
  return {
    agents: createAgents(db),
    projects: createProjects(db),
    members: createMembers(db),
    groups: createGroups(db),
    messages: createMessages(db),
    deliveries: createDeliveries(db),
    statuses: createStatuses(db),
    mcpSessions: createMcpSessions(db),
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
      const at = nowIso();
      const project: Project = { id: newId(), name, createdAt: at, updatedAt: at, archivedAt: null };
      runInTransaction(db, () =>
        db
          .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
          .run(project.id, project.name, project.createdAt, project.updatedAt),
      );
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createMembers(db: Database.Database): MembersRepository {
  const projectExists = db.prepare("SELECT 1 FROM projects WHERE id = ?");
  const agentExists = db.prepare("SELECT 1 FROM agents WHERE id = ?");

  const repo: MembersRepository = {
    create(input) {
      if (!projectExists.get(input.projectId)) {
        throw new InvalidReferenceError(`项目 ${input.projectId} 不存在，无法添加成员。`);
      }
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
      const at = nowIso();
      const id = newId();
      runInTransaction(db, () =>
        db
          .prepare(
            `INSERT INTO members (id, project_id, agent_id, kind, display_name, role, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, input.projectId, agentId, input.kind, displayName, role, at, at),
      );
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
      const displayName =
        patch.displayName === undefined
          ? existing.displayName
          : requireNonEmpty(patch.displayName, "Member.displayName");
      const role = patch.role ?? existing.role;
      if (!MEMBER_ROLES.includes(role)) {
        throw new InvalidArgumentError(`Member.role 必须是 manager 或 normal，收到：${String(patch.role)}。`);
      }
      runInTransaction(db, () =>
        db
          .prepare("UPDATE members SET display_name = ?, role = ?, updated_at = ? WHERE id = ?")
          .run(displayName, role, nowIso(), id),
      );
      return repo.get(id)!;
    },
    delete(id) {
      const result = db.prepare("DELETE FROM members WHERE id = ?").run(id);
      if (result.changes === 0) throw new NotFoundError(`Member ${id} 不存在。`);
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

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}