import { randomUUID } from "node:crypto";
import { newId } from "../db/ids.ts";
import type { DbDriver } from "../db/driver.ts";
import type { Logger } from "../logger.ts";
import { McpToolError } from "../mcp/errors.ts";
import type { ManagedCoreAuthority, SessionBinding } from "../mcp/core.ts";
import type { Actor } from "../authz/authorize.ts";
import { createRuntimeRepository } from "./repository.ts";
import type { RunnerFence, RuntimeBindingView, RuntimeRepository } from "./types.ts";
import type { RuntimeObservability, RuntimeReasonCode } from "./observation-types.ts";
import type { HostEvent, HostLaunchSnapshot, HostLauncher, HostPreflight, OwnedHostProcess } from "./hosts/types.ts";
import { createRuntimeGateway, type RuntimeGateway } from "./gateway.ts";
import { onMessageCommit } from "./dispatch-events.ts";

export interface RuntimeSupervisor {
  notify(): void;
  tick(): Promise<void>;
  capability(bindingId: string): HostPreflight | null;
  /** 保留 desired_state；服务停止只在安全点回收自有进程。 */
  close(): Promise<void>;
}

interface ActiveRunner {
  readonly fence: RunnerFence;
  readonly attemptId: string;
  readonly epochId: string;
  readonly startedAt: number;
  readonly snapshot: HostLaunchSnapshot;
  readonly preflight: HostPreflight;
  gateway: RuntimeGateway | null;
  child: OwnedHostProcess | null;
  joined: boolean;
  ready: boolean;
  readyAt: number | null;
  safe: boolean;
  /** 本轮 owner 至少获得一次投递机会，避免旧未 ACK 投递使两群在首批前反复互让。 */
  delivered: boolean;
  stopping: boolean;
  yielded: boolean;
  permission: string;
  failure: RuntimeReasonCode | null;
  eventChain: Promise<void>;
  completion: Promise<void> | null;
}

/** 独立于消息 anti-loop：只决定何时重新检查运行资格。 */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(60_000, 1000 * 2 ** Math.min(16, Math.max(0, attempt - 1)));
  return Math.min(60_000, Math.round(base * (0.8 + Math.max(0, Math.min(1, random())) * 0.2)));
}

export function hostReason(reason: string): RuntimeReasonCode {
  switch (reason) {
    case "host_not_installed": return "executable_missing";
    case "login_required": return "auth_required";
    case "workdir_invalid": return "workdir_unavailable";
    case "protected_path_overlap": case "config_invalid": return "configuration_invalid";
    case "permission_mode_unknown": case "permission_mode_fallback": return "permission_required";
    case "resume_failed": return "protocol_invalid";
    case "launch_failed": return "resource_unavailable";
    case "protocol_invalid": return "protocol_invalid";
    case "profile_unsupported": case "host_version_unknown": case "host_version_unsupported":
    case "isolation_unavailable": return "profile_unsupported";
    default: return "unknown";
  }
}

export function launchSnapshot(view: RuntimeBindingView, owner: string, socketPath: string): HostLaunchSnapshot {
  const applied = view.binding.requestedSnapshot ?? view.runner.applied ?? view.effective;
  const config = applied.config;
  return {
    bindingId: view.binding.id, ownerId: owner, generation: view.runner.generation,
    revision: applied.versions.bindingRevision, backend: view.runtime.backend,
    config: { workdir: config.workdir, permissionMode: config.permissionMode,
      bypass: applied.advancedStrategy !== null,
      ...(config.model === null ? {} : { model: config.model }),
      ...(config.tools === null ? {} : { tools: config.tools }),
      systemPrompt: config.systemPrompt },
    ...(!view.binding.resetSessionRequested && view.runner.harnessSessionId
      ? { sessionId: view.runner.harnessSessionId } : {}),
    mcpSocketPath: socketPath,
    identity: { displayName: view.runtime.name, projectId: view.binding.projectId, groupId: view.binding.groupId },
  };
}

export function createRuntimeSupervisor(options: {
  db: DbDriver;
  logger: Logger;
  launcher: HostLauncher;
  observations: RuntimeObservability;
  stateRoot: string;
  repository?: RuntimeRepository;
  now?: () => number;
  random?: () => number;
  pollMs?: number;
  startupTimeoutMs?: number;
  gatewayFactory?: typeof createRuntimeGateway;
  actorFor?: (binding: SessionBinding) => Promise<Actor>;
  /** 测试用显式 tick，不自动开启时钟；不能改变生产宿主支持判定。 */
  manual?: boolean;
}): RuntimeSupervisor {
  const repo = options.repository ?? createRuntimeRepository(options.db);
  const now = options.now ?? Date.now;
  const owner = randomUUID();
  const log = options.logger.child({ component: "runtime-supervisor" });
  const active = new Map<string, ActiveRunner>();
  const capabilities = new Map<string, { key: string; value: HostPreflight }>();
  const yielded = new Map<string, string>();
  let closing = false;
  let closed: Promise<void> | null = null;
  let currentTick: Promise<void> | null = null;
  let tickAgain = false;
  let notificationScheduled = false;
  const observationsInFlight = new Set<Promise<void>>();

  const record = async (view: RuntimeBindingView, event: Parameters<RuntimeObservability["record"]>[0]["event"],
    extra: Partial<Parameters<RuntimeObservability["record"]>[0]> = {}) => {
    await options.observations.record({ event, runtimeId: view.runtime.id, bindingId: view.binding.id,
      projectId: view.binding.projectId, memberId: view.binding.memberId,
      runnerGeneration: view.runner.generation, ...extra });
  };

  async function maybeReady(item: ActiveRunner): Promise<void> {
    if (item.ready || item.stopping || !item.joined || item.permission !== item.preflight.expectedPermissionMode) return;
    const view = await repo.markReady(item.fence, item.child?.pid);
    item.ready = true;
    item.readyAt = now();
    await record(view, "ready", { attemptId: item.attemptId });
  }

  async function requestSafeStop(item: ActiveRunner, isYield = false): Promise<void> {
    if (item.stopping || !item.safe) return;
    item.stopping = true;
    item.yielded = isYield;
    if (isYield) yielded.set(item.fence.memberId, item.fence.bindingId);
    try { await repo.markStopping(item.fence); } catch { /* 陈旧 owner 仍只能回收本地自有句柄。 */ }
    // MCP 与停止指令复用父进程管道。先让 CLI 优雅落盘；真实退出后统一关闭通道。
    // 提前 close transport 会截断 stop 控制帧并把正常停止变成启动失败。
    item.child?.stopAtSafePoint();
  }

  async function beforeWait(item: ActiveRunner): Promise<boolean> {
    // 到达 wait 是自有进程的安全点事实，不授予已归档/停用范围的新业务权限。
    const view = await repo.checkFence(item.fence, { requireActiveScope: false });
    item.safe = true;
    await repo.patchRunner(item.fence, { phase: "idle" });
    if (!await repo.isScopeActive(item.fence.bindingId)) {
      item.readyAt = null;
      if (view.runner.lastErrorCode === null) await repo.patchRunner(item.fence, { lastErrorCode: "scope_inactive" });
      setImmediate(() => { void requestSafeStop(item).catch(() => log.warn("runtime_safe_stop_failed")); });
      return false;
    }
    const wakeable = await repo.listWakeable();
    const others = wakeable.some(w => w.memberId === item.fence.memberId && w.bindingId !== item.fence.bindingId)
      && (item.delivered || !wakeable.some(w => w.bindingId === item.fence.bindingId));
    const changed = (view.binding.requestedSnapshot !== null &&
      view.binding.requestedSnapshot.digest !== view.runner.applied?.digest) || view.binding.resetSessionRequested;
    if (closing || item.stopping || view.binding.desiredState === "stopped" || changed || others ||
      item.permission !== item.preflight.expectedPermissionMode || item.failure !== null) {
      // 不在当前工具/事务中等待自身 gateway 关闭，避免等待自己的死锁。
      setImmediate(() => { void requestSafeStop(item, others).catch(() => log.warn("runtime_safe_stop_failed")); });
      return false;
    }
    return true;
  }

  function authorityFor(item: ActiveRunner, view: RuntimeBindingView): ManagedCoreAuthority {
    return {
      identity: { displayName: view.runtime.name, hostType: view.runtime.backend,
        projectId: view.binding.projectId, groupId: view.binding.groupId, memberId: view.binding.memberId },
      async run(operation, fn) {
        if (item.stopping && operation !== "observe" && operation !== "disconnect") throw new McpToolError("CONFLICT", "托管运行正在停止");
        if ((operation === "consume" || operation === "write") && !item.joined) {
          throw new McpToolError("CONFLICT", "托管 MCP 通道尚未就绪或已断开");
        }
        if ((operation === "consume" || operation === "write") &&
          item.permission !== item.preflight.expectedPermissionMode) {
          throw new McpToolError("FORBIDDEN", "实际权限模式尚未确认，不能处理新业务");
        }
        return await repo.withFence(item.fence, fn, { requireRunningIntent: operation === "consume",
          requireActiveScope: operation !== "disconnect" });
      },
      beforeWait: () => beforeWait(item),
      async onDelivery() {
        item.safe = false;
        item.delivered = true;
        await repo.patchRunner(item.fence, { phase: "working" });
      },
    };
  }

  async function onHostEvent(item: ActiveRunner, event: HostEvent): Promise<void> {
    if (!active.has(item.fence.bindingId)) return;
    const view = await repo.checkFence(item.fence);
    switch (event.type) {
      case "ready": case "permission": {
        const mode = event.type === "ready" ? event.permissionMode : event.mode;
        item.permission = mode;
        const known = ["auto", "manual", "workspace-write", "bypassPermissions"].includes(mode) ? mode : "unknown";
        await repo.patchRunner(item.fence, { permissionObserved: known as RuntimeBindingView["runner"]["permissionObserved"] });
        if (mode !== item.preflight.expectedPermissionMode) {
          item.failure = "permission_required";
          await repo.patchRunner(item.fence, { lastErrorCode: item.failure });
        }
        await maybeReady(item);
        break;
      }
      case "session": await repo.setSession(item.fence, event.sessionId); break;
      case "permission_denied":
        // 一次操作拒绝不是整轮结束，不 ACK、不杀进程、不清空队列。
        await record(view, "observation_warning", { reasonCode: "permission_required", attemptId: item.attemptId });
        break;
      case "failure":
        if (item.stopping) break; // 已请求退出后的宿主输出不覆盖停止/启动超时的因果原因。
        item.failure = hostReason(event.reason);
        await repo.patchRunner(item.fence, { lastErrorCode: item.failure,
          ...(event.reason === "resume_failed" ? { sessionState: "invalid" } : {}) });
        break;
      case "protocol_invalid":
        await record(view, "observation_warning", { reasonCode: "protocol_invalid", attemptId: item.attemptId });
        break;
      case "usage_unavailable":
        await record(view, "usage_unavailable", { reasonCode: "usage_missing", attemptId: item.attemptId }); break;
      case "usage":
        await options.observations.observeUsage({ bindingId: view.binding.id, runtimeId: view.runtime.id,
          projectId: view.binding.projectId, memberId: view.binding.memberId,
          runnerGeneration: item.fence.generation, attemptId: item.attemptId,
          source: event.source, harnessVersion: event.harnessVersion, metric: event.metric,
          scope: event.scope, scopeId: item.attemptId, epochId: item.epochId,
          sequence: event.sequence, reportedAt: new Date(now()).toISOString(), coverage: event.coverage,
          value: event.value, cumulative: event.cumulative, schemaVerified: event.schemaVerified,
          zeroMeaningful: event.zeroMeaningful, successful: event.successful });
        break;
      case "exit": break; // 只由 ownedChild.exited 确认进程退出，输出文本不能释放所有权。
    }
  }

  async function exited(item: ActiveRunner, result: { code: number | null; signal: string | null }): Promise<void> {
    await item.eventChain;
    await item.gateway?.close();
    const view = await repo.getBinding(item.fence.bindingId);
    if (!view) { active.delete(item.fence.bindingId); return; }
    const deliberate = item.stopping && item.failure === null;
    const retryable = !deliberate && !["auth_required", "permission_required", "configuration_invalid", "profile_unsupported", "protocol_invalid"].includes(item.failure ?? "");
    const retryAt = retryable && !closing && view.binding.desiredState === "running"
      ? new Date(now() + retryDelay(view.runner.attemptCount, options.random)).toISOString() : null;
    const reason = deliberate ? null : item.failure ?? "process_exit";
    try {
      const final = await repo.markExit(item.fence, { exitCode: result.code, signal: result.signal, errorCode: reason, retryAt });
      await record(final, final.binding.desiredState === "stopped" ? "stopped" : "exited", {
        attemptId: item.attemptId, ...(reason ? { reasonCode: reason } : {}),
        ...(result.code === null ? {} : { exitCode: result.code }), durationMs: Math.max(0, now() - item.startedAt) });
      if (retryAt) await record(final, "retry_scheduled", { attemptId: item.attemptId,
        reasonCode: "backoff", retryAt: Date.parse(retryAt), attempt: final.runner.attemptCount });
    } finally { active.delete(item.fence.bindingId); }
    supervisor.notify();
  }

  async function start(view: RuntimeBindingView): Promise<void> {
    const b = view.binding;
    if (b.desiredState !== "running" || !view.runner.exitConfirmed || view.runner.owner) return;
    if (!await repo.isScopeActive(b.id)) {
      // 暂停只影响资格；保留原失败原因、退避、已应用快照和显式会话。
      if (view.runner.lastErrorCode === null) {
        const queued = await repo.queued(b.id, "scope_inactive", view.runner.nextRetryAt);
        await record(queued, "dispatch.queued", { reasonCode: "scope_inactive" });
      }
      return;
    }
    if (view.runner.lastErrorCode === "scope_inactive") {
      await repo.queued(b.id, null, view.runner.nextRetryAt);
    }
    if (view.runner.nextRetryAt && Date.parse(view.runner.nextRetryAt) > now()) return;
    if (view.runner.sessionState === "invalid" && !view.binding.resetSessionRequested) return;
    // preflight 校验下一次将取得的 generation；初始数据库行的 generation 是 0。
    const snapshot = { ...launchSnapshot(view, owner, ""), generation: view.runner.generation + 1 };
    const key = `${b.intentRevision}:${b.requestedSnapshot?.digest ?? view.runner.applied?.digest ?? view.effective.digest}`;
    const old = capabilities.get(b.id);
    const preflight = old?.key === key ? old.value : await options.launcher.preflight(snapshot);
    capabilities.set(b.id, { key, value: preflight });
    if (!preflight.supported) {
      const reason = hostReason(preflight.reason);
      if (view.runner.lastErrorCode !== reason) {
        const queued = await repo.queued(b.id, reason);
        await record(queued, "dispatch.queued", { reasonCode: reason });
      }
      return;
    }
    // 非重试失败只等明确 retry/apply，不通过每秒 tick 热循环。
    if (view.runner.lastErrorCode && !view.runner.nextRetryAt &&
      ["auth_required", "permission_required", "protocol_invalid", "configuration_invalid"].includes(view.runner.lastErrorCode)) return;
    let fence: RunnerFence;
    try { fence = await repo.claim(b.id, owner, { expectedIntentRevision: b.intentRevision,
      expectedConfigDigest: (b.requestedSnapshot ?? view.runner.applied ?? view.effective).digest }); }
    catch (error) {
      if (error instanceof Error && ["runtime_intent_conflict", "runtime_launch_snapshot_changed"].includes(error.message)) {
        supervisor.notify(); return;
      }
      if (!view.runner.owner && view.runner.lastErrorCode !== "busy") {
        try { await repo.queued(b.id, "busy"); } catch { /* 另一所有者已取得原子 reservation。 */ }
      }
      return;
    }
    const claimed = await repo.getBinding(b.id);
    if (!claimed) return;
    const item: ActiveRunner = { fence, attemptId: newId(), epochId: newId(), startedAt: now(),
      snapshot: launchSnapshot(claimed, owner, ""), preflight, gateway: null, child: null,
      joined: false, ready: false, readyAt: null, safe: false, delivered: false, stopping: false, yielded: false,
      permission: "unknown", failure: null, eventChain: Promise.resolve(), completion: null };
    active.set(b.id, item);
    try {
      item.gateway = await (options.gatewayFactory ?? createRuntimeGateway)({ db: options.db, logger: options.logger,
        authority: authorityFor(item, claimed),
        ...(options.actorFor ? { actorFor: options.actorFor } : {}),
        onJoined: async () => { item.joined = true; await maybeReady(item); },
        onDisconnected: async () => {
          item.joined = false;
          if (!item.stopping && active.get(b.id) === item) {
            item.failure ??= "transport_lost";
            const disconnected = await repo.patchRunner(item.fence, { lastErrorCode: item.failure });
            await record(disconnected, "observation_warning", { reasonCode: item.failure, attemptId: item.attemptId });
          }
          supervisor.notify();
        } });
      const launch = item.snapshot;
      item.child = await options.launcher.launch(launch, {
        onMcpTransport: channel => item.gateway!.attach(channel),
        onEvent(event) {
        item.eventChain = item.eventChain.then(() => onHostEvent(item, event)).catch(() => {
          log.warn("runtime_observation_failed");
        });
      } });
      // 先订阅真正的退出句柄，再做任何可能失败的数据库/观测写入。
      item.completion = item.child.exited.then(result => exited(item, result)).catch(() => {
        log.warn("runtime_exit_unconfirmed");
      });
      if (item.child.processIdentity) await repo.setProcessIdentity(fence, item.child.processIdentity);
      else if (item.child.pid) await repo.patchRunner(fence, { pid: item.child.pid });
      if (item.stopping) item.child.stopAtSafePoint();
      await record(claimed, "spawned", { attemptId: item.attemptId, attempt: claimed.runner.attemptCount });
      await record(claimed, "dispatch.scheduled", { attemptId: item.attemptId });
    } catch {
      await item.gateway?.close();
      if (item.child) { item.failure = "resource_unavailable"; item.child.forceStopOwned(); return; }
      active.delete(b.id);
      const retryAt = new Date(now() + retryDelay(claimed.runner.attemptCount, options.random)).toISOString();
      await repo.markExit(fence, { errorCode: "resource_unavailable", retryAt });
      await record(claimed, "retry_scheduled", { reasonCode: "resource_unavailable", retryAt: Date.parse(retryAt), attemptId: item.attemptId });
    }
  }

  async function cycle(): Promise<void> {
    const views = await repo.listBindings();
    const wakeable = await repo.listWakeable();
    for (const view of views) {
      const runner = view.runner;
      if (active.has(view.binding.id) || runner.exitConfirmed || !runner.owner || !runner.processIdentity
        || (runner.leaseExpiresAt !== null && Date.parse(runner.leaseExpiresAt) > now())
        || !options.launcher.inspectPrevious) continue;
      try {
        // 只读内核身份检查发生在数据库锁外；清理时再次以完整 fence + identity + 过期租约 CAS。
        const inspection = await options.launcher.inspectPrevious(runner.processIdentity);
        if (inspection.status !== "wrapper_exited") continue;
        const fence = { bindingId: view.binding.id, memberId: view.binding.memberId, owner: runner.owner, generation: runner.generation };
        const nonRetry = ["auth_required", "permission_required", "configuration_invalid", "profile_unsupported", "protocol_invalid"].includes(runner.lastErrorCode ?? "")
          || runner.sessionState === "invalid";
        const reason = view.binding.desiredState === "stopped" ? null
          : nonRetry ? runner.lastErrorCode ?? "protocol_invalid" : "process_exit";
        const retryAt = view.binding.desiredState === "running" && !nonRetry
          ? new Date(now() + retryDelay(runner.attemptCount, options.random)).toISOString() : null;
        const recovered = await repo.recoverExited(fence, runner.processIdentity, { errorCode: reason, retryAt });
        await record(recovered, view.binding.desiredState === "stopped" ? "stopped" : "exited",
          reason === null ? {} : { reasonCode: reason as RuntimeReasonCode });
        if (retryAt) await record(recovered, "retry_scheduled", { reasonCode: "backoff", retryAt: Date.parse(retryAt), attempt: runner.attemptCount });
        supervisor.notify();
      } catch { /* 读取失败、其他 owner 续租或 generation 已变：继续保留所有权，不能猜测退出。 */ }
    }
    for (const item of [...active.values()]) {
      const view = views.find(v => v.binding.id === item.fence.bindingId);
      if (!view) continue;
      try {
        try { await repo.renew(item.fence); }
        catch { if (item.safe) await requestSafeStop(item); continue; }
        if (!item.ready && now() - item.startedAt >= (options.startupTimeoutMs ?? 30_000) && !item.stopping) {
          item.failure = "startup_timeout";
          item.stopping = true;
          await item.gateway?.close();
          item.child?.forceStopOwned();
          continue;
        }
        if (!await repo.isScopeActive(item.fence.bindingId)) {
          item.readyAt = null;
          if (view.runner.lastErrorCode === null) await repo.patchRunner(item.fence, { lastErrorCode: "scope_inactive" });
          if (item.safe) await requestSafeStop(item);
          continue;
        }
        if (view.runner.lastErrorCode === "scope_inactive" && item.failure === null) {
          await repo.patchRunner(item.fence, { lastErrorCode: null });
        }
        if (item.ready && item.joined && item.gateway?.joined && item.failure === null && item.readyAt === null) {
          item.readyAt = now();
        }
        if (item.ready && item.joined && item.gateway?.joined && item.failure === null && item.readyAt !== null
          && now() - item.readyAt >= 5 * 60_000 && view.runner.attemptCount > 0) {
          await repo.resetFailures(item.fence);
        }
        const others = wakeable.some(w => w.memberId === item.fence.memberId && w.bindingId !== item.fence.bindingId)
          && (item.delivered || !wakeable.some(w => w.bindingId === item.fence.bindingId));
        const changed = (view.binding.requestedSnapshot !== null &&
          view.binding.requestedSnapshot.digest !== view.runner.applied?.digest) || view.binding.resetSessionRequested;
        if (item.safe && (closing || view.binding.desiredState === "stopped" || changed || others || item.failure !== null)) {
          await requestSafeStop(item, others);
        } else if (item.ready && item.safe && wakeable.some(w => w.bindingId === item.fence.bindingId)) {
          await item.gateway?.wake();
        }
      } catch {
        // 资格可在任意 await 间改变；某个绑定失败不能饿死其他 Member 的调度。
        log.warn("runtime_binding_reconcile_failed", { bindingId: item.fence.bindingId });
      }
    }
    if (closing) return;
    const rank = new Map(wakeable.map(w => [w.bindingId, w.firstMessageAt]));
    const candidates = views.filter(v => v.binding.desiredState === "running" && !active.has(v.binding.id));
    candidates.sort((a, b) => {
      const ay = yielded.get(a.binding.memberId) === a.binding.id && wakeable.some(w => w.memberId === a.binding.memberId && w.bindingId !== a.binding.id);
      const by = yielded.get(b.binding.memberId) === b.binding.id && wakeable.some(w => w.memberId === b.binding.memberId && w.bindingId !== b.binding.id);
      return Number(ay) - Number(by) || (rank.get(a.binding.id) ?? "~").localeCompare(rank.get(b.binding.id) ?? "~") || a.binding.id.localeCompare(b.binding.id);
    });
    for (const view of candidates) {
      try { await start(view); }
      catch { log.warn("runtime_binding_start_failed", { bindingId: view.binding.id }); }
    }
  }

  const supervisor: RuntimeSupervisor = {
    capability(id) { return capabilities.get(id)?.value ?? null; },
    notify() {
      if (closing || notificationScheduled) return;
      notificationScheduled = true;
      queueMicrotask(() => { notificationScheduled = false; void supervisor.tick().catch(() => log.warn("runtime_tick_failed")); });
    },
    tick() {
      if (currentTick) { tickAgain = true; return currentTick; }
      currentTick = (async () => {
        do { tickAgain = false; await cycle(); } while (tickAgain && !closing);
      })().finally(() => { currentTick = null; });
      return currentTick;
    },
    close() {
      if (closed) return closed;
      closing = true;
      clearInterval(timer);
      unsubscribe();
      closed = (async () => {
        await currentTick;
        await Promise.allSettled([...observationsInFlight]);
        for (const item of active.values()) if (item.safe) await requestSafeStop(item);
        // 忙碌进程在下一 wait 安全点退出，不能因停服务暗中强杀执行轮次。
        await Promise.all([...active.values()].map(item => item.completion));
      })();
      return closed;
    },
  };
  const unsubscribe = onMessageCommit(options.db, messageId => {
    supervisor.notify();
    if (!messageId || closing) return;
    // 只读取已提交的唤醒决定，不从正文、mentions 或当前路由重新推算。
    const pending = (async () => {
      const rows = await options.db.query(`SELECT b.id AS binding_id, b.runtime_id, b.project_id, b.member_id,
        d.wake_decision, d.wake_suppressed_reason FROM message_deliveries d
        JOIN messages m ON m.id = d.message_id
        JOIN agent_runtime_bindings b ON b.member_id = d.member_id AND b.group_id = m.group_id
        WHERE d.message_id = ? AND d.wake_decision IS NOT NULL`, [messageId]);
      for (const row of rows) await options.observations.record({
        event: row.wake_decision === "allowed" ? "wake.allowed" : "wake.suppressed",
        runtimeId: String(row.runtime_id), bindingId: String(row.binding_id), projectId: String(row.project_id),
        memberId: String(row.member_id), messageId,
        ...(["consecutive_limit", "rate_limited"].includes(String(row.wake_suppressed_reason))
          ? { reasonCode: String(row.wake_suppressed_reason) as RuntimeReasonCode } : {}),
      });
    })().catch(() => { log.warn("runtime_wake_observation_failed"); });
    observationsInFlight.add(pending);
    void pending.finally(() => observationsInFlight.delete(pending));
    return pending;
  });
  const timer = options.manual ? undefined : setInterval(() => supervisor.notify(), options.pollMs ?? 1000);
  timer?.unref();
  if (!options.manual) supervisor.notify();
  return supervisor;
}
