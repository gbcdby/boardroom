import type { DbDriver, DbRow, DbTransaction } from "../db/driver.ts";
import { isId, newId } from "../db/ids.ts";
import { OperationQueue } from "../db/operation-queue.ts";
import type { Logger } from "../logger.ts";
import {
  OBSERVABLE_CONFIG_FIELDS, RUNTIME_EVENT_NAMES, RUNTIME_REASON_CODES, USAGE_METRICS, USAGE_SOURCES,
  type NormalizedUsageObservation, type RuntimeObservability, type UsageSnapshot, type UsageEventSummary,
  type ObservationHealth, type ObservationPage, type ObservationRetention,
  type ObservationWriteResult, type RuntimeEventInput, type RuntimeObservationEvent,
} from "./observation-types.ts";

export interface RuntimeObservabilityOptions {
  readonly db: DbDriver;
  readonly logger: Logger;
  readonly now?: () => number;
  readonly retention?: ObservationRetention;
}

interface MetaRow extends DbRow {
  storage_failures: number;
  logger_failures: number;
  rejected_records: number;
  dropped_events: number;
  history_truncated: number;
}

const CONTEXT_IDS = [
  "projectId", "memberId", "runtimeId", "bindingId", "attemptId", "turnId", "triggerBatchId", "messageId",
] as const;
const NUMERIC_FIELDS = [
  "runnerGeneration", "exitCode", "durationMs", "retryAt", "configRevision", "attempt", "queuedCount", "droppedCount",
] as const;
const SIGNALS: readonly string[] = [
  "SIGABRT", "SIGALRM", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT",
  "SIGKILL", "SIGPIPE", "SIGQUIT", "SIGSEGV", "SIGSTOP", "SIGTERM", "SIGTRAP", "SIGTSTP", "SIGTTIN",
  "SIGTTOU", "SIGUSR1", "SIGUSR2", "SIGXCPU", "SIGXFSZ", "SIGSYS",
];

const DEFAULT_MAX_AGE = 7 * 24 * 60 * 60 * 1_000;

/**
 * 观测记录只反映已经提交的事实。调用方应在业务提交后调用，不将它放进消息 ACK 事务。
 * 单实例队列保护故障计数；meta 行写锁保证多个实例在 PG 上也不会突破全局保留上限。
 */
export function createRuntimeObservability(options: RuntimeObservabilityOptions): RuntimeObservability {
  const { db } = options;
  const logger = options.logger.child({ component: "runtime-observability" });
  const now = options.now ?? Date.now;
  const maxAgeMs = boundedOption(options.retention?.maxAgeMs, DEFAULT_MAX_AGE, 1, Number.MAX_SAFE_INTEGER);
  const maxEvents = boundedOption(options.retention?.maxEvents, 10_000, 1, 1_000_000);
  const maxEventBytes = boundedOption(options.retention?.maxEventBytes, 2_048, 256, 65_536);
  const queue = new OperationQueue();
  let storageFailures = 0;
  let rejectedRecords = 0;
  let persistedStorageFailures = 0;
  let persistedRejectedRecords = 0;
  let persistedLoggerFailures = 0;
  let healthStorageAtRead = 0;
  let healthRejectedAtRead = 0;
  let healthLoggerAtRead = 0;
  let lastHealth: ObservationHealth = {
    incomplete: false, storageFailures: 0, loggerWriteFailures: 0, rejectedRecords: 0,
    droppedEvents: 0, oldestObservedAt: null, historyTruncated: false,
  };

  function cacheHealth(health: ObservationHealth): void {
    lastHealth = health;
    healthStorageAtRead = storageFailures;
    healthRejectedAtRead = rejectedRecords;
    healthLoggerAtRead = logger.health().writeFailures;
  }

  function failStorage(): void {
    storageFailures += 1;
    logger.warn("runtime_observation_write_failed", { reasonCode: "observations_incomplete" });
  }

  function incomplete(): boolean {
    return lastHealth.incomplete || storageFailures > 0 || rejectedRecords > 0 || logger.health().writeFailures > 0;
  }

  async function transaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    const storageAtStart = storageFailures;
    const rejectedAtStart = rejectedRecords;
    const loggerAtStart = logger.health().writeFailures;
    const result = await db.transaction(async (tx) => {
      // 离线数据迁移要求目标领域表为空；meta 在首次观测事务内惰性建立。
      await tx.exec("INSERT INTO agent_runtime_observation_meta (id) VALUES (?) ON CONFLICT (id) DO NOTHING", [1]);
      const locked = await tx.exec(
        `UPDATE agent_runtime_observation_meta SET
           storage_failures = storage_failures + ?, logger_failures = logger_failures + ?,
           rejected_records = rejected_records + ? WHERE id = ?`,
        [storageAtStart - persistedStorageFailures, loggerAtStart - persistedLoggerFailures,
          rejectedAtStart - persistedRejectedRecords, 1],
      );
      if (locked !== 1) throw new Error("runtime observation metadata unavailable");
      return fn(tx);
    });
    persistedStorageFailures = storageAtStart;
    persistedRejectedRecords = rejectedAtStart;
    persistedLoggerFailures = loggerAtStart;
    return result;
  }

  async function pruneInTransaction(tx: DbTransaction): Promise<void> {
    const cutoff = new Date(Math.max(0, now() - maxAgeMs)).toISOString();
    let dropped = await tx.exec("DELETE FROM agent_runtime_events WHERE observed_at < ?", [cutoff]);
    const counts = await tx.query<{ count: number | string }>("SELECT COUNT(*) AS count FROM agent_runtime_events");
    const excess = Number(counts[0]?.count ?? 0) - maxEvents;
    if (excess > 0) {
      dropped += await tx.exec(
        `DELETE FROM agent_runtime_events WHERE id IN
         (SELECT id FROM agent_runtime_events ORDER BY observed_at, id LIMIT ?)`, [excess],
      );
    }
    if (dropped > 0) {
      await tx.exec(`UPDATE agent_runtime_observation_meta SET dropped_events = dropped_events + ?,
        history_truncated = 1 WHERE id = ?`, [dropped, 1]);
    }
  }

  async function append(tx: DbTransaction, event: RuntimeObservationEvent): Promise<boolean> {
    const changes = await tx.exec(
      `INSERT INTO agent_runtime_events (id, binding_id, observed_at, event_name, payload)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      [event.eventId, event.bindingId ?? null, event.observedAt, event.event, JSON.stringify(event)],
    );
    await pruneInTransaction(tx);
    return changes === 1;
  }

  async function readHealth(tx: DbTransaction): Promise<ObservationHealth> {
    const [meta] = await tx.query<MetaRow>("SELECT * FROM agent_runtime_observation_meta WHERE id = ?", [1]);
    if (!meta) throw new Error("runtime observation metadata unavailable");
    const [oldest] = await tx.query<{ oldest: string | null }>("SELECT MIN(observed_at) AS oldest FROM agent_runtime_events");
    const storage = Number(meta.storage_failures);
    const logFailures = Number(meta.logger_failures);
    const rejected = Number(meta.rejected_records);
    return {
      incomplete: storage > 0 || logFailures > 0 || rejected > 0,
      storageFailures: storage, loggerWriteFailures: logFailures, rejectedRecords: rejected,
      droppedEvents: Number(meta.dropped_events), oldestObservedAt: oldest?.oldest ?? null,
      historyTruncated: Number(meta.history_truncated) === 1,
    };
  }

  function record(input: RuntimeEventInput): Promise<ObservationWriteResult> {
    return queue.run(async () => {
      const event = sanitizeEvent(input, now, maxEventBytes);
      if (event === null) {
        rejectedRecords += 1;
        logger.warn("runtime_observation_rejected", { reasonCode: "protocol_invalid" });
        return { stored: false, duplicate: false, incomplete: true };
      }
      try {
        const stored = await transaction((tx) => append(tx, event));
        if (stored) logger.info("runtime_observation", { ...event });
        return { stored, duplicate: !stored, incomplete: incomplete() };
      } catch {
        failStorage();
        return { stored: false, duplicate: false, incomplete: true };
      }
    });
  }

  function list(filter: { readonly bindingId?: string; readonly limit?: number } = {}): Promise<ObservationPage> {
    if (filter.bindingId !== undefined && !isId(filter.bindingId)) throw new Error("invalid observation binding ID");
    const limit = boundedOption(filter.limit, 50, 1, 1_000);
    return queue.run(async () => {
      try {
        const page = await transaction(async (tx) => {
          await pruneInTransaction(tx);
          const where = filter.bindingId === undefined ? "" : "WHERE binding_id = ?";
          const params = filter.bindingId === undefined ? [limit] : [filter.bindingId, limit];
          const rows = await tx.query<{ payload: string }>(
            `SELECT payload FROM agent_runtime_events ${where} ORDER BY observed_at DESC, id DESC LIMIT ?`, params,
          );
          const health = await readHealth(tx);
          return { events: rows.map((r) => JSON.parse(r.payload) as RuntimeObservationEvent), health };
        });
        cacheHealth(page.health);
        return { events: page.events, oldestObservedAt: page.health.oldestObservedAt,
          historyTruncated: page.health.historyTruncated, incomplete: page.health.incomplete };
      } catch {
        failStorage();
        return { events: [], oldestObservedAt: lastHealth.oldestObservedAt,
          historyTruncated: lastHealth.historyTruncated, incomplete: true };
      }
    });
  }

  function health(): Promise<ObservationHealth> {
    return queue.run(async () => {
      try {
        cacheHealth(await transaction(async (tx) => {
          await pruneInTransaction(tx);
          return readHealth(tx);
        }));
      } catch { failStorage(); }
      return {
        ...lastHealth, incomplete: incomplete(),
        storageFailures: lastHealth.storageFailures + storageFailures - healthStorageAtRead,
        loggerWriteFailures: lastHealth.loggerWriteFailures + logger.health().writeFailures - healthLoggerAtRead,
        rejectedRecords: lastHealth.rejectedRecords + rejectedRecords - healthRejectedAtRead,
      };
    });
  }

  function prune(): Promise<void> {
    return queue.run(async () => {
      try { await transaction(pruneInTransaction); } catch { failStorage(); }
    });
  }

  function observeUsage(input: NormalizedUsageObservation): Promise<ObservationWriteResult> {
    return queue.run(async () => {
      if (!validUsageInput(input)) {
        rejectedRecords += 1;
        logger.warn("runtime_usage_rejected", { reasonCode: "protocol_invalid" });
        return { stored: false, duplicate: false, incomplete: true };
      }
      try {
        const result = await transaction(async (tx) => {
          const params = [input.bindingId, input.source, input.harnessVersion, input.metric,
            input.scope, input.scopeId, input.epochId];
          const [row] = await tx.query<{ payload: string }>(
            `SELECT payload FROM agent_runtime_usage_snapshots WHERE binding_id = ? AND source = ?
             AND harness_version = ? AND metric = ? AND scope = ? AND scope_id = ? AND epoch_id = ?`, params,
          );
          let previous = row ? JSON.parse(row.payload) as UsageSnapshot : null;
          if (previous) {
            if (input.scope === "session") {
              const priorGeneration = previous.runnerGeneration;
              if (Number.isSafeInteger(priorGeneration) && priorGeneration! >= 1) {
                if (input.runnerGeneration! < priorGeneration! || (input.runnerGeneration === priorGeneration && input.sequence <= previous.sequence)) {
                  return { stored: false, duplicate: true, incomplete: incomplete() };
                }
              } else {
                // 旧记录没有源代次，不能拿它推导差额；仍保留高水位检测累计回退。
                previous = { ...previous, baselineReliable: false };
              }
            } else if (input.sequence <= previous.sequence || input.reportedAt < previous.reportedAt) {
              return { stored: false, duplicate: true, incomplete: incomplete() };
            }
          }
          const snapshot = normalizeUsage(input, previous, now);
          await tx.exec(
            `INSERT INTO agent_runtime_usage_snapshots
             (id, binding_id, source, harness_version, metric, scope, scope_id, epoch_id, sequence, observed_at, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (binding_id, source, harness_version, metric, scope, scope_id, epoch_id)
             DO UPDATE SET sequence = excluded.sequence, observed_at = excluded.observed_at, payload = excluded.payload`,
            [snapshot.id, ...params, snapshot.sequence, snapshot.observedAt, JSON.stringify(snapshot)],
          );
          const summary: UsageEventSummary = {
            id: snapshot.id, source: snapshot.source, harnessVersion: snapshot.harnessVersion,
            metric: snapshot.metric, scope: snapshot.scope, scopeId: snapshot.scopeId, epochId: snapshot.epochId,
            sequence: snapshot.sequence, coverage: snapshot.coverage, value: snapshot.value,
            cumulative: snapshot.cumulative, delta: snapshot.delta, estimated: snapshot.estimated,
          };
          const event = sanitizeEvent({
            ...contextFrom(input), event: snapshot.value === null ? "usage_unavailable" : "usage_observed",
            ...(snapshot.reasonCode === null ? {} : { reasonCode: snapshot.reasonCode }),
          }, now, maxEventBytes)!;
          const withUsage = { ...event, usage: summary };
          await append(tx, Buffer.byteLength(JSON.stringify(withUsage)) <= maxEventBytes
            ? withUsage : { ...event, truncated: true });
          return { stored: true, duplicate: false, incomplete: incomplete() };
        });
        if (result.stored) logger.info("runtime_usage_snapshot", {
          bindingId: input.bindingId, source: input.source, metric: input.metric,
        });
        return { ...result, incomplete: incomplete() };
      } catch {
        failStorage();
        return { stored: false, duplicate: false, incomplete: true };
      }
    });
  }

  function listUsage(filter: { readonly bindingId: string; readonly limit?: number }): Promise<readonly UsageSnapshot[]> {
    if (!isId(filter.bindingId)) throw new Error("invalid observation binding ID");
    const limit = boundedOption(filter.limit, 100, 1, 1_000);
    return queue.run(async () => {
      try {
        return await transaction(async (tx) => {
          const rows = await tx.query<{ payload: string }>(
            `SELECT payload FROM agent_runtime_usage_snapshots WHERE binding_id = ? ORDER BY observed_at DESC, id DESC LIMIT ?`,
            [filter.bindingId, limit],
          );
          return rows.map((row) => JSON.parse(row.payload) as UsageSnapshot);
        });
      } catch { failStorage(); return []; }
    });
  }

  return { record, list, health, prune, observeUsage, listUsage };
}

function boundedOption(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("invalid observation limit");
  return value;
}

function sanitizeEvent(input: RuntimeEventInput, now: () => number, maxBytes: number): RuntimeObservationEvent | null {
  if (!input || !RUNTIME_EVENT_NAMES.includes(input.event)) return null;
  if (input.eventId !== undefined && !isId(input.eventId)) return null;
  const result: Record<string, unknown> = {
    event: input.event, eventId: input.eventId ?? newId(now), observedAt: new Date(now()).toISOString(), truncated: false,
  };
  for (const key of CONTEXT_IDS) {
    const value = input[key];
    if (value === undefined) continue;
    if (isId(value)) result[key] = value;
    else result["truncated"] = true;
  }
  for (const key of NUMERIC_FIELDS) {
    const value = input[key];
    if (value === undefined) continue;
    if (Number.isSafeInteger(value) && value >= 0) result[key] = value;
    else result["truncated"] = true;
  }
  if (input.reasonCode !== undefined) {
    result["reasonCode"] = RUNTIME_REASON_CODES.includes(input.reasonCode) ? input.reasonCode : "unknown";
  }
  if (input.signal !== undefined && SIGNALS.includes(input.signal)) result["signal"] = input.signal;
  if (input.changedFields !== undefined) {
    if (Array.isArray(input.changedFields)) {
      result["changedFields"] = [...new Set(input.changedFields.slice(0, 64).filter((f) => OBSERVABLE_CONFIG_FIELDS.includes(f)))];
      if (input.changedFields.length > 64) result["truncated"] = true;
    } else result["truncated"] = true;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) {
    result["truncated"] = true;
    // 首先保留关联字段；最低上限下逐步减少可选字段，event/id/time 始终存在。
    for (const key of ["changedFields", ...NUMERIC_FIELDS, "signal", ...CONTEXT_IDS.slice().reverse(), "reasonCode"]) {
      delete result[key];
      if (Buffer.byteLength(JSON.stringify(result)) <= maxBytes) break;
    }
  }
  return result as unknown as RuntimeObservationEvent;
}

/** 没有任何字段允许自由文本；未知来源/版本/作用域不能被默认为已知用量。 */
function validUsageInput(input: NormalizedUsageObservation): boolean {
  if (!input || !isId(input.bindingId) || !isId(input.scopeId) || !isId(input.epochId)) return false;
  if (!USAGE_SOURCES.includes(input.source) || !USAGE_METRICS.includes(input.metric)) return false;
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/.test(input.harnessVersion)) return false;
  if (!["turn", "invocation", "session"].includes(input.scope) || !["complete", "partial", "unavailable"].includes(input.coverage)) return false;
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) return false;
  if (input.scope === "session" && (!Number.isSafeInteger(input.runnerGeneration) || input.runnerGeneration! < 1)) return false;
  if (typeof input.reportedAt !== "string" || input.reportedAt.length !== 24 || !Number.isFinite(Date.parse(input.reportedAt))) return false;
  if (new Date(input.reportedAt).toISOString() !== input.reportedAt) return false;
  return [input.cumulative, input.schemaVerified, input.zeroMeaningful, input.successful].every((v) => typeof v === "boolean");
}

function contextFrom(input: NormalizedUsageObservation): Record<string, string | number> & { bindingId: string } {
  const context: Record<string, string | number> & { bindingId: string } = { bindingId: input.bindingId };
  for (const key of CONTEXT_IDS) if (isId(input[key])) context[key] = input[key]!;
  if (input.runnerGeneration !== undefined && Number.isSafeInteger(input.runnerGeneration) && input.runnerGeneration >= 0) {
    context["runnerGeneration"] = input.runnerGeneration;
  }
  return context;
}

function normalizeUsage(input: NormalizedUsageObservation, previous: UsageSnapshot | null, now: () => number): UsageSnapshot {
  let coverage = input.coverage;
  let value = input.value;
  let reasonCode: UsageSnapshot["reasonCode"] = null;
  const validValue = typeof value === "number" && Number.isFinite(value) && value >= 0 &&
    (input.metric === "costUsd" ? value <= Number.MAX_SAFE_INTEGER : Number.isSafeInteger(value));
  if (!input.schemaVerified) {
    value = null; coverage = "unavailable"; reasonCode = "schema_unverified";
  } else if (!validValue || coverage === "unavailable") {
    value = null; coverage = "unavailable"; reasonCode = "usage_missing";
  } else if (value === 0 && (!input.zeroMeaningful || !input.successful || coverage !== "complete")) {
    value = null; coverage = "partial"; reasonCode = "partial_usage";
  } else if (!input.successful || coverage === "partial") {
    coverage = "partial"; reasonCode = "partial_usage";
  }
  let epochReliable = previous?.epochReliable ?? true;
  const previousHigh = previous?.cumulativeHighWatermark ?? (previous?.cumulative ? previous.value : null);
  let delta: number | null = null;
  if (previous && (previous.cumulative !== input.cumulative ||
    (input.cumulative && value !== null && previousHigh !== null && value < previousHigh))) {
    epochReliable = false;
  }
  if (!epochReliable) {
    coverage = value === null ? "unavailable" : "partial";
    reasonCode = "cumulative_reset";
  } else if (input.cumulative && value !== null && coverage === "complete") {
    if (previous?.baselineReliable && previous.value !== null) delta = value - previous.value;
    else reasonCode = "baseline_unknown";
  }
  return {
    ...contextFrom(input), id: previous?.id ?? newId(now), source: input.source,
    harnessVersion: input.harnessVersion, metric: input.metric, scope: input.scope,
    scopeId: input.scopeId, epochId: input.epochId, sequence: input.sequence,
    reportedAt: input.reportedAt, observedAt: new Date(now()).toISOString(),
    coverage, value, cumulative: input.cumulative, delta, reasonCode, epochReliable,
    cumulativeHighWatermark: input.cumulative
      ? value === null ? previousHigh : Math.max(previousHigh ?? value, value) : null,
    baselineReliable: epochReliable && value !== null && coverage === "complete",
    estimated: input.metric === "costUsd",
  };
}
