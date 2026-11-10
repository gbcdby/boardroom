import type { DbDriver, DbRow } from "../db/driver.ts";
import type { OwnedProcessIdentity } from "./hosts/types.ts";
import { createRepositories } from "../db/repositories.ts";
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
  RunnerFence, RuntimeAppliedConfig, RuntimeBindingView, RuntimeRepository, RuntimeView,
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
 * 独立仓储仍使用同一个 DbDriver；驱动的 AsyncLocalStorage 使外层 MCP 事务、
 * 基础仓储和这里的嵌套事务复用真正的事务连接。所有锁内回调仅允许短数据库操作。
 */
export function createRuntimeRepository(db: DbDriver, options: { now?: () => Date } = {}): RuntimeRepository {
  const repos = createRepositories(db);
  const now = options.now ?? (() => new Date());
  const at = (): string => now().toISOString();
  const one = async (sql: string, args: readonly unknown[] = []): Promise<Row | undefined> => (await db.query(sql, args))[0];
  const transaction = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await db.transaction(fn); } catch (error) { return normalize(error); }
  };

  async function lockRuntime(id: string): Promise<AgentRuntime> {
    if (await db.exec("UPDATE agent_runtimes SET revision = revision WHERE id = ?", [id]) !== 1) {
      throw new NotFoundError("runtime_not_found");
    }
    return (await getRuntime(id))!;
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
    const row = await one(`SELECT p.archived_at AS project_archived, g.archived_at AS group_archived, m.status
      FROM projects p JOIN groups g ON g.project_id = p.id JOIN members m ON m.project_id = p.id
      WHERE p.id = ? AND g.id = ? AND m.id = ?`, [view.binding.projectId, view.binding.groupId, view.binding.memberId]);
    if (!row) throw new InvalidReferenceError("runtime_binding_reference_invalid");
    if (row.project_archived != null || row.group_archived != null) throw new ArchivedError("runtime_scope_archived");
    if (row.status !== "active") throw new ConflictError("runtime_member_inactive");
  }
  function assertStopped(view: RuntimeBindingView): void {
    if (view.binding.desiredState !== "stopped" || view.runner.owner !== null || !view.runner.exitConfirmed
      || !["stopped", "failed"].includes(view.runner.state)) throw new ConflictError("runtime_must_stop_first");
  }
  async function insertBinding(r: AgentRuntime, input: NewRuntimeBinding): Promise<string> {
    if (typeof input?.projectId !== "string" || typeof input?.groupId !== "string") {
      throw new InvalidArgumentError("runtime_binding_reference_invalid");
    }
    const overrides = await validateRuntimeOverrides(r.backend, input.overrides ?? {});
    // 与永久删除使用相同父级锁，避免确认停机后又插入新的可启动绑定。
    if (await db.exec("UPDATE projects SET updated_at = updated_at WHERE id = ?", [input.projectId]) !== 1) {
      throw new InvalidReferenceError("runtime_project_not_found");
    }
    if (await db.exec("UPDATE groups SET updated_at = updated_at WHERE id = ? AND project_id = ?", [input.groupId, input.projectId]) !== 1) {
      throw new InvalidReferenceError("runtime_group_project_mismatch");
    }
    const project = await repos.projects.get(input.projectId);
    const group = await repos.groups.get(input.groupId);
    if (project?.archivedAt != null || group?.archivedAt != null) throw new ArchivedError("runtime_scope_archived");
    let member = await repos.members.findByAgent(input.projectId, r.agentId);
    if (!member) member = await repos.members.create({ projectId: input.projectId, agentId: r.agentId, kind: "agent", displayName: r.name });
    const memberId = member.id;
    return api.withMemberLock(memberId, async () => {
      const reservation = await one("SELECT * FROM agent_runtime_members WHERE member_id = ?", [memberId]);
      if (reservation && reservation.runtime_id !== r.id) throw new ConflictError("runtime_member_reserved");
      if (!reservation) await assertNoExternalConnection(memberId);
      const id = newId();
      const createdAt = at();
      await db.exec(`INSERT INTO agent_runtime_bindings
        (id, runtime_id, project_id, group_id, member_id, overrides_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id, r.id, input.projectId, input.groupId, memberId, JSON.stringify(overrides), createdAt, createdAt]);
      await db.exec("INSERT INTO agent_runner_states (binding_id, updated_at) VALUES (?, ?)", [id, createdAt]);
      if (!reservation) await db.exec(`INSERT INTO agent_runtime_members
        (member_id, runtime_id, project_id, updated_at) VALUES (?, ?, ?, ?)`, [memberId, r.id, input.projectId, createdAt]);
      await repos.groups.addParticipant(input.groupId, memberId);
      return id;
    });
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
        if (error instanceof ArchivedError || error instanceof ConflictError && error.message === "runtime_member_inactive") return false;
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
      return transaction(async () => {
        if (await repos.agents.findByIdentity(name, backend)) throw new ConflictError("runtime_identity_exists");
        const agent = await repos.agents.create({ displayName: name, hostType: backend });
        const id = newId();
        const createdAt = at();
        await db.exec(`INSERT INTO agent_runtimes
          (id, agent_id, config_version, defaults_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, agent.id, RUNTIME_CONFIG_VERSION, JSON.stringify(defaults), createdAt, createdAt]);
        const r = (await getRuntime(id))!;
        for (const entry of input.bindings) await insertBinding(r, entry);
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
      return transaction(async () => {
        await lockRuntime(id);
        const changed = await db.exec(`UPDATE agent_runtimes SET defaults_json = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ?`, [JSON.stringify(defaults), at(), id, expectedRevision]);
        if (changed !== 1) throw new ConflictError("runtime_revision_conflict");
        return (await api.get(id))!;
      });
    },
    async addBinding(runtimeId, input, expectedRuntimeRevision) {
      return transaction(async () => {
        const r = await lockRuntime(runtimeId);
        if (expectedRuntimeRevision !== undefined && r.revision !== expectedRuntimeRevision) throw new ConflictError("runtime_revision_conflict");
        return (await api.getBinding(await insertBinding(r, input)))!;
      });
    },
    async updateBinding(id, input) {
      revision(input.runtimeRevision); revision(input.bindingRevision);
      const initial = await requiredBinding(id);
      const overrides = await validateRuntimeOverrides(initial.runtime.backend, input.overrides);
      const strategy = validateAdvancedStrategy(initial.runtime.backend, input.advancedStrategy);
      return transaction(async () => {
        const r = await lockRuntime(initial.runtime.id);
        return api.withMemberLock(initial.binding.memberId, async () => {
          const current = await requiredBinding(id);
          if (r.revision !== input.runtimeRevision || current.binding.revision !== input.bindingRevision) {
            throw new ConflictError("runtime_revision_conflict");
          }
          const advanced = strategy === null ? null : { strategy, runtimeRevision: r.revision, bindingRevision: input.bindingRevision + 1 };
          await db.exec(`UPDATE agent_runtime_bindings SET overrides_json = ?, advanced_json = ?, revision = revision + 1, updated_at = ?
            WHERE id = ? AND revision = ?`, [JSON.stringify(overrides), advanced === null ? null : JSON.stringify(advanced), at(), id, input.bindingRevision]);
          return (await api.getBinding(id))!;
        });
      });
    },
    async intent(id, action, expectedIntentRevision, expectedConfig) {
      if (!["start", "retry", "stop", "apply", "new-session"].includes(action)) throw new InvalidArgumentError("runtime_intent_invalid");
      const initial = await requiredBinding(id);
      return transaction(async () => {
        await lockRuntime(initial.runtime.id);
        return api.withMemberLock(initial.binding.memberId, async () => {
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
      });
    },
    async claim(id, owner, claimOptions = {}) {
      if (typeof owner !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(owner)) throw new InvalidArgumentError("runtime_owner_invalid");
      const leaseMs = claimOptions.leaseMs ?? DEFAULT_LEASE_MS; leaseDuration(leaseMs);
      const initial = await requiredBinding(id);
      return api.withMemberLock(initial.binding.memberId, async () => {
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
    async withFence<T>(fence: RunnerFence, fn: () => Promise<T>, fenceOptions: FenceOptions = {}): Promise<T> {
      return api.withMemberLock(fence.memberId, async () => { await api.checkFence(fence, fenceOptions); return fn(); });
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
      const initial = await requiredBinding(id);
      return api.withMemberLock(initial.binding.memberId, async () => {
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
          AND p.archived_at IS NULL AND g.archived_at IS NULL AND mb.status = 'active'
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
    async withMemberLock<T>(memberId: string, fn: () => Promise<T>): Promise<T> {
      return transaction(async () => {
        // 无值变化的 UPDATE 在两种数据库上都取得成员写锁；PG 独立连接同样互斥。
        if (await db.exec("UPDATE members SET updated_at = updated_at WHERE id = ?", [memberId]) !== 1) throw new NotFoundError("runtime_member_not_found");
        return fn();
      });
    },
    async assertExternalJoinAllowed(memberId) {
      await memberRow(memberId);
      if (await one("SELECT member_id FROM agent_runtime_members WHERE member_id = ?", [memberId])) throw new ConflictError("runtime_member_reserved");
    },
    async removeBinding(id) {
      const initial = await requiredBinding(id);
      await transaction(async () => {
        await lockRuntime(initial.runtime.id);
        await api.withMemberLock(initial.binding.memberId, () => releaseBinding(id));
      });
    },
    async delete(id) {
      await transaction(async () => {
        await lockRuntime(id);
        const bindings = await db.query("SELECT id, member_id FROM agent_runtime_bindings WHERE runtime_id = ? ORDER BY member_id, id", [id]);
        for (const row of bindings) await db.exec("UPDATE members SET updated_at = updated_at WHERE id = ?", [row.member_id]);
        for (const row of bindings) assertStopped(await requiredBinding(String(row.id)));
        for (const row of bindings) await releaseBinding(String(row.id));
        await db.exec("DELETE FROM agent_runtimes WHERE id = ?", [id]);
      });
    },
  };
  return api;
}
