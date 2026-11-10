/** #74/#87：只接受平台归一化后的白名单元数据，不接受原始 CLI 输出。 */
export const RUNTIME_EVENT_NAMES = [
  "runtime.created", "runtime.updated", "binding.created", "binding.updated",
  "start_requested", "stop_requested", "retry_requested", "spawned", "ready",
  "exited", "retry_scheduled", "stopped", "wake.allowed", "wake.suppressed",
  "dispatch.scheduled", "dispatch.queued", "usage_observed", "usage_unavailable",
  "observation_warning",
] as const;
export type RuntimeEventName = (typeof RUNTIME_EVENT_NAMES)[number];

export const RUNTIME_REASON_CODES = [
  "unsupported_harness", "profile_unsupported", "executable_missing", "workdir_unavailable",
  "auth_required", "permission_required", "identity_conflict", "startup_timeout",
  "process_exit", "transport_lost", "resource_unavailable", "provider_rate_limited",
  "protocol_invalid", "unknown", "configuration_invalid", "busy", "backoff",
  "consecutive_limit", "rate_limited", "stopping", "awaiting_exit", "lease_conflict",
  "schema_unverified", "usage_missing", "baseline_unknown", "cumulative_reset",
  "partial_usage", "out_of_order", "observations_incomplete", "history_truncated",
] as const;
export type RuntimeReasonCode = (typeof RUNTIME_REASON_CODES)[number];

export const OBSERVABLE_CONFIG_FIELDS = [
  "harness", "harnessType", "model", "cwd", "workdir", "instructions", "additionalInstructions",
  "resumePolicy", "startupTimeoutMs", "permissionMode", "permissionPolicy", "skipPermissions",
  "profile", "desiredState", "overrides", "runtimeRevision", "bindingRevision",
] as const;
export type ObservableConfigField = (typeof OBSERVABLE_CONFIG_FIELDS)[number];

/** 均为平台内部 ID；CLI sid、原始路径和输出不得放入关联字段。 */
export interface ObservationContext {
  readonly projectId?: string;
  readonly memberId?: string;
  readonly runtimeId?: string;
  readonly bindingId?: string;
  readonly attemptId?: string;
  readonly turnId?: string;
  readonly triggerBatchId?: string;
  readonly messageId?: string;
  readonly runnerGeneration?: number;
}

export interface RuntimeEventInput extends ObservationContext {
  readonly event: RuntimeEventName;
  /** 重试记录沿用同一内部 ID；省略时由观测层创建。 */
  readonly eventId?: string;
  readonly reasonCode?: RuntimeReasonCode;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly durationMs?: number;
  readonly retryAt?: number;
  readonly configRevision?: number;
  readonly attempt?: number;
  readonly queuedCount?: number;
  readonly droppedCount?: number;
  readonly changedFields?: readonly ObservableConfigField[];
}

export interface RuntimeObservationEvent extends RuntimeEventInput {
  readonly eventId: string;
  readonly observedAt: string;
  readonly truncated: boolean;
  readonly usage?: UsageEventSummary;
}

export const USAGE_SOURCES = ["claude-code", "codex-cli", "dsh"] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];
export const USAGE_METRICS = ["inputTokens", "cachedInputTokens", "outputTokens", "costUsd"] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];
export type UsageScope = "turn" | "invocation" | "session";
export type UsageCoverage = "complete" | "partial" | "unavailable";

/**
 * 由具体版本的 adapter 生成，每种指标独立携带作用域。
 * schemaVerified 只表示已有实际样本证据，不可由 HTTP/CLI 自述字段设置。
 * scopeId / epochId 使用平台内部引用，不能传 CLI 的不透明 sid。
 */
export interface NormalizedUsageObservation extends ObservationContext {
  readonly bindingId: string;
  readonly source: UsageSource;
  readonly harnessVersion: string;
  readonly metric: UsageMetric;
  readonly scope: UsageScope;
  readonly scopeId: string;
  readonly epochId: string;
  /** 同一作用域内的来源顺序；重放沿用 sequence，不用接收时钟生成。 */
  readonly sequence: number;
  readonly reportedAt: string;
  readonly coverage: UsageCoverage;
  readonly value: number | null;
  readonly cumulative: boolean;
  readonly schemaVerified: boolean;
  readonly zeroMeaningful: boolean;
  readonly successful: boolean;
}

export interface UsageSnapshot extends ObservationContext {
  readonly id: string;
  readonly bindingId: string;
  readonly source: UsageSource;
  readonly harnessVersion: string;
  readonly metric: UsageMetric;
  readonly scope: UsageScope;
  readonly scopeId: string;
  readonly epochId: string;
  readonly sequence: number;
  readonly reportedAt: string;
  readonly observedAt: string;
  readonly coverage: UsageCoverage;
  readonly value: number | null;
  readonly cumulative: boolean;
  /** 仅同一版本、epoch 中连续可靠的累计快照可计算；首次或缺口为 null。 */
  readonly delta: number | null;
  readonly reasonCode: RuntimeReasonCode | null;
  readonly baselineReliable: boolean;
  /** 累计值回退/模式变化后保持 false，必须显式切换 epoch 才可重新计算差额。 */
  readonly epochReliable: boolean;
  /** 同 epoch 已见累计高水位；unavailable 不能抹掉此前已知值而掩盖回退。 */
  readonly cumulativeHighWatermark: number | null;
  /** 金额始终是 CLI 估算；本模块不生成跨来源总账。 */
  readonly estimated: boolean;
}

export type UsageEventSummary = Pick<UsageSnapshot,
  "id" | "source" | "harnessVersion" | "metric" | "scope" | "scopeId" | "epochId" |
  "sequence" | "coverage" | "value" | "cumulative" | "delta" | "estimated">;

export interface ObservationRetention {
  readonly maxAgeMs?: number;
  readonly maxEvents?: number;
  readonly maxEventBytes?: number;
}

export interface ObservationHealth {
  readonly incomplete: boolean;
  readonly storageFailures: number;
  readonly loggerWriteFailures: number;
  readonly rejectedRecords: number;
  readonly droppedEvents: number;
  readonly oldestObservedAt: string | null;
  readonly historyTruncated: boolean;
}

export interface ObservationWriteResult {
  readonly stored: boolean;
  readonly duplicate: boolean;
  readonly incomplete: boolean;
}

export interface ObservationPage {
  readonly events: readonly RuntimeObservationEvent[];
  readonly oldestObservedAt: string | null;
  readonly historyTruncated: boolean;
  readonly incomplete: boolean;
}

export interface RuntimeObservability {
  record(input: RuntimeEventInput): Promise<ObservationWriteResult>;
  observeUsage(input: NormalizedUsageObservation): Promise<ObservationWriteResult>;
  list(options?: { readonly bindingId?: string; readonly limit?: number }): Promise<ObservationPage>;
  listUsage(options: { readonly bindingId: string; readonly limit?: number }): Promise<readonly UsageSnapshot[]>;
  health(): Promise<ObservationHealth>;
  /** 即使没有新事件也可执行时间轮转，仅触碰观测历史。 */
  prune(): Promise<void>;
}
