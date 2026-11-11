import type { DbDriver, DbRow } from "../db/driver.ts";
import type { OwnedProcessIdentity } from "./hosts/types.ts";
import { createRepositories, hasMemberLifecycleSchema, type RepoCtx, type RepositorySet } from "../db/repositories.ts";
import type { MutationDiscover, MutationDiscovery, MutationLockPlan } from "../db/mutation-scope.ts";
import { newId } from "../db/ids.ts";
import {
  ArchivedError, ConflictError, InvalidArgumentError, InvalidReferenceError,
  NotFoundError, RepositoryError, WriteFailedError,
} from "../db/errors.ts";
import {
  RUNTIME_CONFIG_VERSION, resolveRuntimeConfig, snapshotRuntimeConfig, validateAdvancedStrategy,
  validateRuntimeBackend, validateRuntimeConfig, validateRuntimeName, validateRuntimeOverrides,
} from "./config.ts";
import type {
  AgentRuntime, AgentRuntimeBinding, AgentRunnerState, FenceOptions, NewRuntimeBinding,
  RunnerFence, RuntimeAppliedConfig, RuntimeBackend, RuntimeBindingView, RuntimeOverrides, RuntimeRepository, RuntimeView,
} from "./types.ts";

type Row = DbRow;
const DEFAULT_LEASE_MS = 30_000;

/** 错误只带固定码，不向 API/日志传播 SQL、配置或宿主输出。 */
function normalize(error: unknown): never {
  if (error instanceof RepositoryError) throw error;
  const code = (error as { code?: string })?.code ?? "";
  // withFence/withMemberLock 包裹 MCP 业务事务；授权/工具错误属于调用方，不能改成500。
  if (!/^(?:SQLITE_|[0-9A-Z]{5}$)/.test(code)) throw error;
  if (["23505", "SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CONSTRAINT_PRIMARYKEY"].includes(code)) {
    throw new ConflictError("runtime_conflict");
  }
  if (["23503", "SQLITE_CONSTRAINT_FOREIGNKEY"].includes(code)) {
    throw new InvalidReferenceError("runtime_reference_invalid");
  }
  throw new WriteFailedError("runtime_write_failed");
}

function json<T>(value: unknown): T { return JSON.parse(String(value)) as T; }
function nullableString(value: unknown): string | null { return value === null || value === undefined ? null : String(value); }
function nullableNumber(value: unknown): number | null { return value === null || value === undefined ? null : Number(value); }
function runtime(row: Row): AgentRuntime {
  return {
    id: String(row.id), agentId: String(row.agent_id), name: String(row.display_name),
    backend: String(row.host_type) as AgentRuntime["backend"], configVersion: Number(row.config_version),
    revision: Number(row.revision), defaults: json(row.defaults_json),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}
function binding(row: Row): AgentRuntimeBinding {
  return {
    id: String(row.id), runtimeId: String(row.runtime_id), projectId: String(row.project_id),
    groupId: String(row.group_id), memberId: String(row.member_id), revision: Number(row.revision),
    overrides: json(row.overrides_json), advanced: row.advanced_json === null ? null : json(row.advanced_json),
    desiredState: String(row.desired_state) as AgentRuntimeBinding["desiredState"],
    intentRevision: Number(row.intent_revision),
    requestedSnapshot: row.requested_snapshot_json === null ? null : json(row.requested_snapshot_json),
    resetSessionRequested: Number(row.reset_session_requested) === 1,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}
function runner(row: Row): AgentRunnerState {
  return {
    bindingId: String(row.binding_id), state: String(row.state) as AgentRunnerState["state"],
    phase: String(row.phase) as AgentRunnerState["phase"], generation: Number(row.generation),
    owner: nullableString(row.lease_owner), leaseExpiresAt: nullableString(row.lease_expires_at),
    applied: row.applied_json === null ? null : json(row.applied_json),
    harnessSessionId: nullableString(row.harness_session_id), sessionState: String(row.session_state) as AgentRunnerState["sessionState"],
    pid: nullableNumber(row.pid), processIdentity: row.process_identity_json == null ? null : json(row.process_identity_json),
    exitConfirmed: Number(row.exit_confirmed) === 1,
    observedAt: nullableString(row.observed_at), startedAt: nullableString(row.started_at),
    attemptCount: Number(row.attempt_count), nextRetryAt: nullableString(row.next_retry_at),
    lastErrorCode: nullableString(row.last_error_code), lastExitCode: nullableNumber(row.last_exit_code),
    lastExitSignal: nullableString(row.last_exit_signal),
    permissionObserved: String(row.permission_observed) as AgentRunnerState["permissionObserved"],
    updatedAt: String(row.updated_at),
  };
}
function revision(value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new InvalidArgumentError("runtime_revision_invalid");
}
function code(value: string | null | undefined): void {
  if (value != null && !/^[a-z][a-z0-9_]{0,63}$/.test(value)) throw new InvalidArgumentError("runtime_reason_invalid");
}
function timestamp(value: string | null | undefined): void {
  if (value != null && (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)) {
    throw new InvalidArgumentError("runtime_timestamp_invalid");
  }
}
function leaseDuration(value: number): void {
  if (!Number.isInteger(value) || value < 100 || value > 300_000) throw new InvalidArgumentError("runtime_lease_invalid");
}
function processIdentity(value: OwnedProcessIdentity): string {
  if (value?.version !== 1 || value.launcherProtocol !== "linux-private-net-v1"
    || !Number.isSafeInteger(value.pid) || value.pid < 1
    || !/^[0-9a-f-]{36}$/.test(value.kernelBootId)
    || !/^pid:\[\d+\]$/.test(value.pidNamespace) || !/^\d+$/.test(value.startTicks)) {
    throw new InvalidArgumentError("runtime_process_identity_invalid");
  }
  return JSON.stringify({ version: 1, launcherProtocol: value.launcherProtocol, pid: value.pid,
    kernelBootId: value.kernelBootId, pidNamespace: value.pidNamespace, startTicks: value.startTicks });
}
function appliedSnapshot(view: RuntimeBindingView): RuntimeAppliedConfig {
  const e = view.effective;
  return snapshotRuntimeConfig(e.backend, e.config, e.versions, e.advancedStrategy);
}

/**
 * 生产装配传入同一个 RepositorySet；兼容调用仍复用 driver 唯一 coordinator。
 * 项目→完整成员→群/运行时的锁序在所有入口一致，锁内只运行短数据库操作。
 */
export function createRuntimeRepository(db: DbDriver, options: { now?: () => Date; repos?: RepositorySet } = {}): RuntimeRepository {
  const repos = options.repos ?? createRepositories(db);
  const now = options.now ?? (() => new Date());
  const at = (): string => now().toISOString();
  const one = async (sql: string, args: readonly unknown[] = []): Promise<Row | undefined> => (await db.query(sql, args))[0];
  const scoped = async <T>(plan: MutationLockPlan, fn: () => Promise<T>): Promise<T> => {
    try { return await repos.mutations.run(plan, fn); } catch (error) { return normalize(error); }
  };
  type BindingScope = { id: string; runtime_id: string; project_id: string; group_id: string; member_id: string };
  function scopeChanged(): never { throw new RepositoryError("mutation_scope_changed", "运行时绑定范围已改变，请刷新后重试。"); }
  async function bindingScope(id: string, tx: Pick<RepoCtx, "one"> = repos.context): Promise<BindingScope> {
    const row = await tx.one<BindingScope>("SELECT id, runtime_id, project_id, group_id, member_id FROM agent_runtime_bindings WHERE id = ?", [id]);
    if (!row) throw new NotFoundError("runtime_binding_not_found");
    return row;
  }
  function sameBinding(left: BindingScope, right: BindingScope): boolean {
    return left.id === right.id && left.runtime_id === right.runtime_id && left.project_id === right.project_id
      && left.group_id === right.group_id && left.member_id === right.member_id;
  }
  function combine(base: MutationDiscovery, extra?: MutationDiscovery): MutationDiscovery {
    return { memberIds: [...base.memberIds, ...(extra?.memberIds ?? [])],
      newMemberIds: [...(base.newMemberIds ?? []), ...(extra?.newMemberIds ?? [])],
      groupIds: [...base.groupIds, ...(extra?.groupIds ?? [])], runtimeIds: [...base.runtimeIds, ...(extra?.runtimeIds ?? [])] };
  }
  async function withBindingScope<T>(id: string, fn: () => Promise<T>, discover?: MutationDiscover): Promise<T> {
    const initial = await bindingScope(id);
    return scoped({ projectIds: [initial.project_id], discover: async tx => {
      if (!sameBinding(initial, await bindingScope(id, tx))) scopeChanged();
      return combine({ memberIds: [initial.member_id], groupIds: [initial.group_id], runtimeIds: [initial.runtime_id] }, await discover?.(tx));
    } }, async () => {
      if (!sameBinding(initial, await bindingScope(id))) scopeChanged();
      return fn();
    });
  }
  async function runtimeClosure(id: string, tx: Pick<RepoCtx, "query"> = repos.context): Promise<BindingScope[]> {
    const rows = await tx.query<BindingScope>("SELECT id, runtime_id, project_id, group_id, member_id FROM agent_runtime_bindings WHERE runtime_id = ? ORDER BY id LIMIT 2049", [id]);
    if (rows.length > 2048) scopeChanged();
    return rows;
  }
  async function prepareBinding(backend: RuntimeBackend, input: NewRuntimeBinding): Promise<NewRuntimeBinding & { overrides: RuntimeOverrides }> {
    if (typeof input?.projectId !== "string" || !input.projectId.trim() || typeof input?.groupId !== "string" || !input.groupId.trim()) {
      throw new InvalidArgumentError("runtime_binding_reference_invalid");
    }
    // 配置校验含文件系统读取，必须在任何数据库写锁之前完成。
    return { projectId: input.projectId, groupId: input.groupId, overrides: await validateRuntimeOverrides(backend, input.overrides ?? {}) };
  }
  async function validGroup(tx: Pick<RepoCtx, "one">, input: NewRuntimeBinding): Promise<void> {
    const group = await tx.one<{ project_id: string }>("SELECT project_id FROM groups WHERE id = ?", [input.groupId]);
    if (!group || group.project_id !== input.projectId) throw new InvalidReferenceError("runtime_group_project_mismatch");
  }

  async function getRuntime(id: string): Promise<AgentRuntime | null> {
    const row = await one("SELECT r.*, a.display_name, a.host_type FROM agent_runtimes r JOIN agents a ON a.id = r.agent_id WHERE r.id = ?", [id]);
    return row ? runtime(row) : null;
  }
  async function requiredBinding(id: string): Promise<RuntimeBindingView> {
    const view = await api.getBinding(id);
    if (!view) throw new NotFoundError("runtime_binding_not_found");
    return view;
  }
  async function memberRow(memberId: string): Promise<Row> {
    const row = await one("SELECT * FROM members WHERE id = ?", [memberId]);
    if (!row) throw new NotFoundError("runtime_member_not_found");
    return row;
  }
  async function assertNoExternalConnection(memberId: string): Promise<void> {
    if (await one("SELECT id FROM mcp_sessions WHERE member_id = ? AND state = 'connected' LIMIT 1", [memberId])) {
      throw new ConflictError("external_session_conflict");
    }
  }
  async function assertActive(view: RuntimeBindingView): Promise<void> {
    const lifecycle = await hasMemberLifecycleSchema(repos.context);
    const row = await one(`SELECT p.archived_at AS project_archived, g.archived_at AS group_archived, m.status,
      ${lifecycle ? "m.removed_at" : "NULL"} AS member_removed
      FROM projects p JOIN groups g ON g.project_id = p.id JOIN members m ON m.project_id = p.id
      WHERE p.id = ? AND g.id = ? AND m.id = ?`, [view.binding.projectId, view.binding.groupId, view.binding.memberId]);
    if (!row) throw new InvalidReferenceError("runtime_binding_reference_invalid");
    if (row.project_archived != null || row.group_archived != null) throw new ArchivedError("runtime_scope_archived");
    if (row.member_removed != null) throw new ConflictError("member_removed");
    if (row.status !== "active") throw new ConflictError("runtime_member_inactive");
  }
  function assertStopped(view: RuntimeBindingView): void {
    if (view.binding.desiredState !== "stopped" || view.runner.owner !== null || !view.runner.exitConfirmed
      || !["stopped", "failed"].includes(view.runner.state)) throw new ConflictError("runtime_must_stop_first");
  }
  async function insertBinding(r: AgentRuntime, input: NewRuntimeBinding & { overrides: RuntimeOverrides }, memberId: string): Promise<string> {
    const scope = repos.mutations.current(); if (!scope) scopeChanged();
    scope.assertCovers([input.projectId], [memberId]);
    await validGroup(repos.context, input);
    const project = await repos.projects.get(input.projectId);
    const group = await repos.groups.get(input.groupId);
    if (project?.archivedAt != null || group?.archivedAt != null) throw new ArchivedError("runtime_scope_archived");
    let member = await repos.members.getIncludingRemoved(memberId);
    if (!member) member = await repos.members.create({ id: memberId, projectId: input.projectId, agentId: r.agentId, kind: "agent", displayName: r.name });
    if (member.removedAt !== null) throw new ConflictError("member_removed");
    if (member.projectId !== input.projectId || member.agentId !== r.agentId) scopeChanged();
    const reservation = await one("SELECT * FROM agent_runtime_members WHERE member_id = ?", [memberId]);
    if (reservation && reservation.runtime_id !== r.id) throw new ConflictError("runtime_member_reserved");
    if (!reservation) await assertNoExternalConnection(memberId);
    const id = newId();
    const createdAt = at();
    await db.exec(`INSERT INTO agent_runtime_bindings
      (id, runtime_id, project_id, group_id, member_id, overrides_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id, r.id, input.projectId, input.groupId, memberId, JSON.stringify(input.overrides), createdAt, createdAt]);
    await db.exec("INSERT INTO agent_runner_states (binding_id, updated_at) VALUES (?, ?)", [id, createdAt]);
    if (!reservation) await db.exec(`INSERT INTO agent_runtime_members
      (member_id, runtime_id, project_id, updated_at) VALUES (?, ?, ?, ?)`, [memberId, r.id, input.projectId, createdAt]);
    await repos.groups.addParticipant(input.groupId, memberId);
    return id;
  }
  async function releaseBinding(id: string): Promise<void> {
    const view = await requiredBinding(id);
    assertStopped(view);
    await db.exec("DELETE FROM agent_runner_states WHERE binding_id = ?", [id]);
    await db.exec("DELETE FROM agent_runtime_bindings WHERE id = ?", [id]);
    await db.exec(`DELETE FROM agent_runtime_members WHERE member_id = ? AND binding_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM agent_runtime_bindings WHERE member_id = ?)`, [view.binding.memberId, view.binding.memberId]);
  }

  const api: RuntimeRepository = {
    async isScopeActive(id) {
      const view = await api.getBinding(id);
      if (!view) return false;
      try { await assertActive(view); return true; }
      catch (error) {
        if (error instanceof ArchivedError || error instanceof ConflictError && ["runtime_member_inactive", "member_removed"].includes(error.message)) return false;
        throw error;
      }
    },
    async create(input) {
      const backend = validateRuntimeBackend(input?.backend);
      const name = validateRuntimeName(input?.name);
      const defaults = await validateRuntimeConfig(backend, input?.defaults);
      if (!Array.isArray(input?.bindings) || input.bindings.length < 1 || input.bindings.length > 100) {
        throw new InvalidArgumentError("runtime_initial_binding_required");
      }
      const entries: (NewRuntimeBinding & { overrides: RuntimeOverrides })[] = [];
      for (const entry of input.bindings) entries.push(await prepareBinding(backend, entry));
      const memberByProject = new Map(entries.map(entry => [entry.projectId, newId()]));
      return scoped({ projectIds: [...memberByProject.keys()], discover: async tx => {
        for (const entry of entries) await validGroup(tx, entry);
        return { memberIds: [], newMemberIds: [...memberByProject.values()], groupIds: entries.map(entry => entry.groupId), runtimeIds: [] };
      } }, async () => {
        if (await repos.agents.findByIdentity(name, backend)) throw new ConflictError("runtime_identity_exists");
        const agent = await repos.agents.create({ displayName: name, hostType: backend });
        const id = newId();
        const createdAt = at();
        await db.exec(`INSERT INTO agent_runtimes
          (id, agent_id, config_version, defaults_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, agent.id, RUNTIME_CONFIG_VERSION, JSON.stringify(defaults), createdAt, createdAt]);
        const r = (await getRuntime(id))!;
        for (const entry of entries) await insertBinding(r, entry, memberByProject.get(entry.projectId)!);
        return (await api.get(id))!;
      });
    },
    async get(id) {
      const r = await getRuntime(id);
      if (!r) return null;
      const rows = await db.query("SELECT id FROM agent_runtime_bindings WHERE runtime_id = ? ORDER BY created_at, id", [id]);
      const views: RuntimeBindingView[] = [];
      for (const row of rows) { const v = await api.getBinding(String(row.id)); if (v) views.push(v); }
      return { runtime: r, bindings: views };
    },
    async list() {
      const rows = await db.query("SELECT id FROM agent_runtimes ORDER BY created_at, id");
      const result: RuntimeView[] = [];
      for (const row of rows) { const v = await api.get(String(row.id)); if (v) result.push(v); }
      return result;
    },
    async getBinding(id) {
      const b = await one("SELECT * FROM agent_runtime_bindings WHERE id = ?", [id]);
      if (!b) return null;
      const r = await getRuntime(String(b.runtime_id));
      const s = await one("SELECT * FROM agent_runner_states WHERE binding_id = ?", [id]);
      if (!r || !s) throw new WriteFailedError("runtime_state_incomplete");
      const bound = binding(b);
      const state = runner(s);
      const effective = resolveRuntimeConfig(r, bound);
      return {
        runtime: r, binding: bound, runner: state, effective,
        pendingChanges: state.applied === null || state.applied.digest !== effective.digest
          || state.applied.versions.runtimeRevision !== r.revision || state.applied.versions.bindingRevision !== bound.revision,
      };
    },
    async listBindings(filter = {}) {
      const clauses: string[] = [];
      const args: string[] = [];
      for (const [key, column] of [["projectId", "project_id"], ["groupId", "group_id"], ["memberId", "member_id"]] as const) {
        if (filter[key] !== undefined) { clauses.push(`${column} = ?`); args.push(filter[key]); }
      }
      const rows = await db.query(`SELECT id FROM agent_runtime_bindings ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at, id`, args);
      const views: RuntimeBindingView[] = [];
      for (const row of rows) { const v = await api.getBinding(String(row.id)); if (v) views.push(v); }
      return views;
    },
    async updateDefaults(id, expectedRevision, input) {
      revision(expectedRevision);
      const r = await getRuntime(id);
      if (!r) throw new NotFoundError("runtime_not_found");
      const defaults = await validateRuntimeConfig(r.backend, input);
      return scoped({ projectIds: [], discover: async () => ({ memberIds: [], groupIds: [], runtimeIds: [id] }) }, async () => {
        const changed = await db.exec(`UPDATE agent_runtimes SET defaults_json = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ?`, [JSON.stringify(defaults), at(), id, expectedRevision]);
        if (changed !== 1) throw new ConflictError("runtime_revision_conflict");
        return (await api.get(id))!;
      });
    },
    async addBinding(runtimeId, input, expectedRuntimeRevision) {
      const initial = await getRuntime(runtimeId); if (!initial) throw new NotFoundError("runtime_not_found");
      const prepared = await prepareBinding(initial.backend, input);
      const newMemberId = newId(); let memberId = newMemberId;
      return scoped({ projectIds: [prepared.projectId], discover: async tx => {
        await validGroup(tx, prepared);
        const member = await tx.one<{ id: string }>("SELECT id FROM members WHERE project_id = ? AND agent_id = ?", [prepared.projectId, initial.agentId]);
        memberId = member?.id ?? newMemberId;
        return { memberIds: member ? [memberId] : [], newMemberIds: member ? [] : [memberId], groupIds: [prepared.groupId], runtimeIds: [runtimeId] };
      } }, async () => {
        const r = await getRuntime(runtimeId); if (!r) throw new NotFoundError("runtime_not_found");
        if (expectedRuntimeRevision !== undefined && r.revision !== expectedRuntimeRevision) throw new ConflictError("runtime_revision_conflict");
        return (await api.getBinding(await insertBinding(r, prepared, memberId)))!;
      });
    },
    async updateBinding(id, input) {
      revision(input.runtimeRevision); revision(input.bindingRevision);
      const initial = await requiredBinding(id);
      const overrides = await validateRuntimeOverrides(initial.runtime.backend, input.overrides);
      const strategy = validateAdvancedStrategy(initial.runtime.backend, input.advancedStrategy);
      return withBindingScope(id, async () => {
        const r = (await getRuntime(initial.runtime.id))!;
        const current = await requiredBinding(id);
        if (r.revision !== input.runtimeRevision || current.binding.revision !== input.bindingRevision) {
          throw new ConflictError("runtime_revision_conflict");
        }
        const advanced = strategy === null ? null : { strategy, runtimeRevision: r.revision, bindingRevision: input.bindingRevision + 1 };
        await db.exec(`UPDATE agent_runtime_bindings SET overrides_json = ?, advanced_json = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ?`, [JSON.stringify(overrides), advanced === null ? null : JSON.stringify(advanced), at(), id, input.bindingRevision]);
        return (await api.getBinding(id))!;
      });
    },
    async intent(id, action, expectedIntentRevision, expectedConfig) {
      if (!["start", "retry", "stop", "apply", "new-session"].includes(action)) throw new InvalidArgumentError("runtime_intent_invalid");
      return withBindingScope(id, async () => {
        const view = await requiredBinding(id);
        if (expectedConfig !== undefined && (expectedConfig.runtimeRevision !== view.runtime.revision
          || expectedConfig.bindingRevision !== view.binding.revision)) throw new ConflictError("runtime_revision_conflict");
        if (expectedIntentRevision !== undefined && expectedIntentRevision !== view.binding.intentRevision) {
          throw new ConflictError("runtime_intent_conflict");
        }
        if (action !== "stop") await assertActive(view);
        if (action === "stop" && view.binding.desiredState === "stopped") return view;
        if (action === "start" && view.binding.desiredState === "running") return view;
        let requested = view.binding.requestedSnapshot;
        let reset = view.binding.resetSessionRequested;
        if (action === "apply") { requested = appliedSnapshot(view); reset = true; }
        if (action === "new-session") { requested = view.runner.applied ?? appliedSnapshot(view); reset = true; }
        if ((action === "start" || action === "retry") && view.runner.applied === null && requested === null) requested = appliedSnapshot(view);
        const desired = action === "stop" ? "stopped" : "running";
        const stamp = at();
        await db.exec(`UPDATE agent_runtime_bindings SET desired_state = ?, intent_revision = intent_revision + 1,
          requested_snapshot_json = ?, reset_session_requested = ?, updated_at = ? WHERE id = ?`,
        [desired, requested === null ? null : JSON.stringify(requested), reset ? 1 : 0, stamp, id]);
        if (view.runner.owner !== null && action !== "start" && action !== "retry") {
          await db.exec("UPDATE agent_runner_states SET state = 'stopping', updated_at = ? WHERE binding_id = ?", [stamp, id]);
        } else if (view.runner.owner === null && action !== "stop") {
          await db.exec("UPDATE agent_runner_states SET next_retry_at = NULL, last_error_code = NULL, updated_at = ? WHERE binding_id = ?", [stamp, id]);
          // resume 失败禁止自动重试；人的明确 retry 仍可重新尝试原 sid，不生成新会话。
          if (action === "retry" && view.runner.sessionState === "invalid" && view.runner.harnessSessionId !== null) {
            await db.exec("UPDATE agent_runner_states SET session_state = 'resumable' WHERE binding_id = ?", [id]);
          }
        }
        return (await api.getBinding(id))!;
      });
    },
    async claim(id, owner, claimOptions = {}) {
      if (typeof owner !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(owner)) throw new InvalidArgumentError("runtime_owner_invalid");
      const leaseMs = claimOptions.leaseMs ?? DEFAULT_LEASE_MS; leaseDuration(leaseMs);
      return withBindingScope(id, async () => {
        const view = await requiredBinding(id);
        await assertActive(view);
        if (claimOptions.expectedIntentRevision !== undefined && claimOptions.expectedIntentRevision !== view.binding.intentRevision) {
          throw new ConflictError("runtime_intent_conflict");
        }
        if (claimOptions.expectedConfigDigest !== undefined &&
          claimOptions.expectedConfigDigest !== (view.binding.requestedSnapshot ?? view.runner.applied)?.digest) {
          throw new ConflictError("runtime_launch_snapshot_changed");
        }
        if (view.binding.desiredState !== "running") throw new ConflictError("runtime_desired_stopped");
        const member = await one("SELECT * FROM agent_runtime_members WHERE member_id = ?", [view.binding.memberId]);
        if (!member || member.runtime_id !== view.runtime.id) throw new ConflictError("runtime_member_unreserved");
        if (member.lease_owner !== null || view.runner.owner !== null) throw new ConflictError("runtime_member_owned");
        if (!view.runner.exitConfirmed) throw new ConflictError("runtime_previous_exit_unknown");
        if (view.runner.nextRetryAt !== null && view.runner.nextRetryAt > at()) throw new ConflictError("runtime_retry_backoff");
        await assertNoExternalConnection(view.binding.memberId);
        const applied = view.binding.requestedSnapshot ?? view.runner.applied;
        if (applied === null) throw new ConflictError("runtime_configuration_unapplied");
        const generation = Number(member.generation) + 1;
        const stamp = at();
        const expires = new Date(now().getTime() + leaseMs).toISOString();
        const reset = view.binding.resetSessionRequested || view.runner.applied?.digest !== applied.digest;
        const claimed = await db.exec(`UPDATE agent_runtime_members SET binding_id = ?, generation = ?, lease_owner = ?, lease_expires_at = ?, updated_at = ?
          WHERE member_id = ? AND lease_owner IS NULL`, [id, generation, owner, expires, stamp, view.binding.memberId]);
        if (claimed !== 1) throw new ConflictError("runtime_member_owned");
        await db.exec(`UPDATE agent_runner_states SET state = 'starting', phase = 'unknown', generation = ?, lease_owner = ?, lease_expires_at = ?,
          applied_json = ?, exit_confirmed = 0, pid = NULL, process_identity_json = NULL, started_at = ?, observed_at = ?, attempt_count = attempt_count + 1,
          last_error_code = NULL, next_retry_at = NULL, permission_observed = 'unknown', updated_at = ? WHERE binding_id = ?`,
        [generation, owner, expires, JSON.stringify(applied), stamp, stamp, stamp, id]);
        if (reset) await db.exec(`UPDATE agent_runner_states SET harness_session_id = NULL, session_key = NULL, session_state = ? WHERE binding_id = ?`,
          [view.runner.applied === null ? "new" : "reset", id]);
        await db.exec("UPDATE agent_runtime_bindings SET requested_snapshot_json = NULL, reset_session_requested = 0 WHERE id = ?", [id]);
        return { bindingId: id, memberId: view.binding.memberId, owner, generation };
      });
    },
    async checkFence(fence, fenceOptions = {}) {
      const view = await requiredBinding(fence.bindingId);
      const row = await one("SELECT * FROM agent_runtime_members WHERE member_id = ?", [fence.memberId]);
      if (!row || view.binding.memberId !== fence.memberId || row.binding_id !== fence.bindingId
        || row.runtime_id !== view.runtime.id || row.project_id !== view.binding.projectId
        || row.lease_owner !== fence.owner || Number(row.generation) !== fence.generation
        || view.runner.owner !== fence.owner || view.runner.generation !== fence.generation || view.runner.exitConfirmed) {
        throw new ConflictError("runtime_fence_stale");
      }
      if (fenceOptions.requireLease !== false && (view.runner.leaseExpiresAt === null || view.runner.leaseExpiresAt <= at()
        || String(row.lease_expires_at) <= at())) throw new ConflictError("runtime_lease_expired");
      if (fenceOptions.requireRunningIntent && (view.binding.desiredState !== "running" || view.runner.state === "stopping")) {
        throw new ConflictError("runtime_desired_stopped");
      }
      if (fenceOptions.requireActiveScope !== false) await assertActive(view);
      return view;
    },
    async withFence<T>(fence: RunnerFence, fn: () => Promise<T>, fenceOptions: FenceOptions = {}, discover?: MutationDiscover): Promise<T> {
      return withBindingScope(fence.bindingId, async () => { await api.checkFence(fence, fenceOptions); return fn(); }, discover);
    },
    async renew(fence, leaseMs = DEFAULT_LEASE_MS) {
      leaseDuration(leaseMs);
      return api.withFence(fence, async () => {
        const expires = new Date(now().getTime() + leaseMs).toISOString(); const stamp = at();
        await db.exec("UPDATE agent_runner_states SET lease_expires_at = ?, observed_at = ?, updated_at = ? WHERE binding_id = ?", [expires, stamp, stamp, fence.bindingId]);
        await db.exec("UPDATE agent_runtime_members SET lease_expires_at = ?, updated_at = ? WHERE member_id = ?", [expires, stamp, fence.memberId]);
      }, { requireLease: false, requireActiveScope: false });
    },
    async resetFailures(fence) {
      await api.withFence(fence, async () => {
        await db.exec("UPDATE agent_runner_states SET attempt_count = 0, updated_at = ? WHERE binding_id = ?", [at(), fence.bindingId]);
      });
    },
    async patchRunner(fence, patch) {
      code(patch.lastErrorCode); timestamp(patch.nextRetryAt);
      if (patch.pid !== undefined && patch.pid !== null && (!Number.isInteger(patch.pid) || patch.pid <= 0)) throw new InvalidArgumentError("runtime_pid_invalid");
      if (patch.state !== undefined && !["starting", "running", "stopping", "failed"].includes(patch.state)) throw new InvalidArgumentError("runtime_runner_state_invalid");
      if (patch.phase !== undefined && !["idle", "working", "unknown"].includes(patch.phase)) throw new InvalidArgumentError("runtime_phase_invalid");
      if (patch.permissionObserved !== undefined && !["unknown", "auto", "manual", "workspace-write", "bypassPermissions"].includes(patch.permissionObserved)) throw new InvalidArgumentError("runtime_permission_observation_invalid");
      if (patch.sessionState !== undefined && !["new", "resumable", "invalid", "reset", "unknown"].includes(patch.sessionState)) throw new InvalidArgumentError("runtime_session_state_invalid");
      return api.withFence(fence, async () => {
        const current = await requiredBinding(fence.bindingId);
        if (current.runner.state === "stopping" && patch.state !== undefined && patch.state !== "stopping" && patch.state !== "failed") {
          throw new ConflictError("runtime_stop_in_progress");
        }
        const assignments: string[] = []; const values: unknown[] = [];
        for (const [key, column] of [["state", "state"], ["phase", "phase"], ["pid", "pid"], ["lastErrorCode", "last_error_code"],
          ["nextRetryAt", "next_retry_at"], ["permissionObserved", "permission_observed"], ["sessionState", "session_state"]] as const) {
          if (patch[key] !== undefined) { assignments.push(`${column} = ?`); values.push(patch[key]); }
        }
        const stamp = at(); assignments.push("observed_at = ?", "updated_at = ?"); values.push(stamp, stamp, fence.bindingId);
        await db.exec(`UPDATE agent_runner_states SET ${assignments.join(", ")} WHERE binding_id = ?`, values);
        return (await api.getBinding(fence.bindingId))!;
      }, { requireActiveScope: false });
    },
    async markReady(fence, pid) { return api.patchRunner(fence, { state: "running", ...(pid === undefined ? {} : { pid }) }); },
    async markStopping(fence) { return api.patchRunner(fence, { state: "stopping" }); },
    async setSession(fence, sessionId) {
      if (typeof sessionId !== "string" || sessionId.trim().length === 0 || sessionId.length > 512 || /[\r\n\0]/.test(sessionId)) {
        throw new InvalidArgumentError("runtime_session_id_invalid");
      }
      return api.withFence(fence, async () => {
        const view = await requiredBinding(fence.bindingId);
        if (view.runner.harnessSessionId !== null && view.runner.harnessSessionId !== sessionId) throw new ConflictError("runtime_session_changed");
        await db.exec("UPDATE agent_runner_states SET harness_session_id = ?, session_key = ?, session_state = 'resumable', updated_at = ? WHERE binding_id = ?",
          [sessionId, `${view.runtime.backend}:${sessionId}`, at(), fence.bindingId]);
        return (await api.getBinding(fence.bindingId))!;
      });
    },
    async setProcessIdentity(fence, identity) {
      const encoded = processIdentity(identity);
      return api.withFence(fence, async () => {
        const current = await requiredBinding(fence.bindingId);
        if (current.runner.processIdentity && processIdentity(current.runner.processIdentity) !== encoded) {
          throw new ConflictError("runtime_process_identity_changed");
        }
        await db.exec("UPDATE agent_runner_states SET pid = ?, process_identity_json = ?, updated_at = ? WHERE binding_id = ?",
          [identity.pid, encoded, at(), fence.bindingId]);
        return (await api.getBinding(fence.bindingId))!;
      }, { requireActiveScope: false });
    },
    async recoverExited(fence, expectedIdentity, exit) {
      const expected = processIdentity(expectedIdentity);
      return api.withFence(fence, async () => {
        const current = await requiredBinding(fence.bindingId);
        if (!current.runner.processIdentity || processIdentity(current.runner.processIdentity) !== expected) {
          throw new ConflictError("runtime_process_identity_changed");
        }
        if (current.runner.leaseExpiresAt !== null && current.runner.leaseExpiresAt > at()) {
          throw new ConflictError("runtime_owner_lease_active");
        }
        return api.markExit(fence, exit);
      }, { requireLease: false, requireActiveScope: false });
    },
    async markExit(fence, exit) {
      code(exit.errorCode); timestamp(exit.retryAt);
      if (exit.exitCode != null && !Number.isInteger(exit.exitCode)) throw new InvalidArgumentError("runtime_exit_code_invalid");
      if (exit.signal != null && !/^SIG[A-Z0-9]{1,16}$/.test(exit.signal)) throw new InvalidArgumentError("runtime_exit_signal_invalid");
      return api.withFence(fence, async () => {
        const stamp = at();
        const failed = exit.errorCode != null || (exit.exitCode != null && exit.exitCode !== 0);
        await db.exec(`UPDATE agent_runner_states SET state = ?, phase = 'unknown', lease_owner = NULL, lease_expires_at = NULL,
          pid = NULL, process_identity_json = NULL, exit_confirmed = 1, observed_at = ?, last_exit_code = ?, last_exit_signal = ?, last_error_code = ?, next_retry_at = ?, updated_at = ?
          WHERE binding_id = ?`, [failed ? "failed" : "stopped", stamp, exit.exitCode ?? null, exit.signal ?? null,
          exit.errorCode ?? null, exit.retryAt ?? null, stamp, fence.bindingId]);
        await db.exec(`UPDATE agent_runtime_members SET binding_id = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE member_id = ?`, [stamp, fence.memberId]);
        return (await api.getBinding(fence.bindingId))!;
      }, { requireLease: false, requireActiveScope: false });
    },
    async queued(id, reason, retryAt = null) {
      code(reason); timestamp(retryAt);
      return withBindingScope(id, async () => {
        const view = await requiredBinding(id);
        if (view.runner.owner !== null || !view.runner.exitConfirmed) throw new ConflictError("runtime_member_owned");
        await db.exec("UPDATE agent_runner_states SET last_error_code = ?, next_retry_at = ?, observed_at = ?, updated_at = ? WHERE binding_id = ?",
          [reason, retryAt, at(), at(), id]);
        return (await api.getBinding(id))!;
      });
    },
    async listWakeable() {
      const rows = await db.query(`SELECT b.id AS binding_id, b.member_id, b.project_id, b.group_id, m.id AS message_id, m.created_at
        FROM agent_runtime_bindings b JOIN message_deliveries d ON d.member_id = b.member_id AND d.project_id = b.project_id
        JOIN messages m ON m.id = d.message_id AND m.group_id = b.group_id
        JOIN projects p ON p.id = b.project_id JOIN groups g ON g.id = b.group_id JOIN members mb ON mb.id = b.member_id
        WHERE b.desired_state = 'running' AND d.wake_decision = 'allowed' AND d.status <> 'acked'
          AND p.archived_at IS NULL AND g.archived_at IS NULL AND mb.status = 'active'${await hasMemberLifecycleSchema(repos.context) ? " AND mb.removed_at IS NULL" : ""}
        ORDER BY m.created_at, m.id, b.id`);
      const results = new Map<string, { bindingId: string; memberId: string; projectId: string; groupId: string; firstMessageAt: string; messageIds: string[] }>();
      for (const row of rows) {
        const id = String(row.binding_id);
        let value = results.get(id);
        if (!value) {
          value = { bindingId: id, memberId: String(row.member_id), projectId: String(row.project_id), groupId: String(row.group_id), firstMessageAt: String(row.created_at), messageIds: [] };
          results.set(id, value);
        }
        value.messageIds.push(String(row.message_id));
      }
      return [...results.values()];
    },
    async withMemberLock<T>(memberId: string, fn: () => Promise<T>, discover?: MutationDiscover): Promise<T> {
      const initial = await memberRow(memberId); const projectId = String(initial.project_id);
      return scoped({ projectIds: [projectId], discover: async tx => combine({ memberIds: [memberId], groupIds: [], runtimeIds: [] }, await discover?.(tx)) }, async () => {
        if (String((await memberRow(memberId)).project_id) !== projectId) scopeChanged();
        return fn();
      });
    },
    async assertExternalJoinAllowed(memberId) {
      if ((await memberRow(memberId)).removed_at != null) throw new ConflictError("member_removed");
      if (await one("SELECT member_id FROM agent_runtime_members WHERE member_id = ?", [memberId])) throw new ConflictError("runtime_member_reserved");
    },
    async removeBinding(id) {
      await withBindingScope(id, () => releaseBinding(id));
    },
    async delete(id) {
      if (!await getRuntime(id)) throw new NotFoundError("runtime_not_found");
      const initial = await runtimeClosure(id); const projectIds = [...new Set(initial.map(row => row.project_id))];
      let planned: BindingScope[] = [];
      await scoped({ projectIds, discover: async tx => {
        planned = await runtimeClosure(id, tx);
        if (planned.some(row => !projectIds.includes(row.project_id))) scopeChanged();
        return { memberIds: planned.map(row => row.member_id), groupIds: planned.map(row => row.group_id), runtimeIds: [id] };
      } }, async () => {
        // 获得运行时锁后再次枚举；跨项目新增不能靠迟到追加锁解决。
        const current = await runtimeClosure(id);
        if (current.length !== planned.length || current.some((row, index) => !sameBinding(row, planned[index]!))) scopeChanged();
        for (const row of current) assertStopped(await requiredBinding(row.id));
        for (const row of current) await releaseBinding(row.id);
        await db.exec("DELETE FROM agent_runtimes WHERE id = ?", [id]);
      });
    },
  };
  return api;
}
