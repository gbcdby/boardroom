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

export interface AgentsRepository {
  create(input: NewAgent): Agent;
  /** 以完整字段插入（含外部提供的 ID），重复 ID 报 ConflictError。 */
  insertRaw(agent: Agent): Agent;
  get(id: string): Agent | null;
  list(): Agent[];
  update(id: string, patch: Partial<Pick<Agent, "displayName" | "hostType">>): Agent;
  touchLastSeen(id: string, at: string): Agent;
  delete(id: string): void;
}

export interface ProjectsRepository {
  create(input: NewProject): Project;
  get(id: string): Project | null;
  list(): Project[];
  rename(id: string, name: string): Project;
  delete(id: string): void;
}

export interface MembersRepository {
  create(input: NewMember): Member;
  get(id: string): Member | null;
  listByProject(projectId: string): Member[];
  getManager(projectId: string): Member | null;
  update(id: string, patch: Partial<Pick<Member, "displayName" | "role">>): Member;
  delete(id: string): void;
}

export interface GroupsRepository {
  create(input: NewGroup): Group;
  get(id: string): Group | null;
  listByProject(projectId: string): Group[];
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
  /** 某成员在项目中尚未投递完成（pending）的积压，按消息 seq 排序。 */
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

export interface RepositorySet {
  readonly agents: AgentsRepository;
  readonly projects: ProjectsRepository;
  readonly members: MembersRepository;
  readonly groups: GroupsRepository;
  readonly messages: MessagesRepository;
  readonly deliveries: DeliveriesRepository;
  readonly statuses: StatusesRepository;
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
}

function toProject(row: ProjectRow): Project {
  return { id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at };
}

function createProjects(db: Database.Database): ProjectsRepository {
  return {
    create(input) {
      const name = requireNonEmpty(input.name, "Project.name");
      const at = nowIso();
      const project: Project = { id: newId(), name, createdAt: at, updatedAt: at };
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
    list() {
      return (db.prepare("SELECT * FROM projects ORDER BY created_at, id").all() as ProjectRow[]).map(toProject);
    },
    rename(id, name) {
      const value = requireNonEmpty(name, "Project.name");
      const result = db
        .prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?")
        .run(value, nowIso(), id);
      if (result.changes === 0) throw new NotFoundError(`Project ${id} 不存在。`);
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
}

function toGroup(row: GroupRow): Group {
  return { id: row.id, projectId: row.project_id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at };
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
    listByProject(projectId) {
      return (
        db.prepare("SELECT * FROM groups WHERE project_id = ? ORDER BY created_at, id").all(projectId) as GroupRow[]
      ).map(toGroup);
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
              WHERE d.project_id = ? AND d.member_id = ? AND d.status = 'pending'
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

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
