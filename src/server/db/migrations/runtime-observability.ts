import type { Migration } from "../migrate.ts";

/** #74/#87：观测历史与消息、审计、CLI 文件及 runner 控制状态分开。 */
export const runtimeObservabilityMigration: Migration = {
  version: 9,
  name: "managed_runtime_observability",
  up: `
    CREATE TABLE agent_runtime_events (
      id           TEXT PRIMARY KEY NOT NULL,
      binding_id   TEXT,
      observed_at  TEXT NOT NULL,
      event_name   TEXT NOT NULL,
      payload      TEXT NOT NULL
    );
    CREATE INDEX ix_runtime_events_observed ON agent_runtime_events (observed_at, id);
    CREATE INDEX ix_runtime_events_binding ON agent_runtime_events (binding_id, observed_at, id);

    -- 单例行同时作为跨进程 append/清理的事务串行点。
    CREATE TABLE agent_runtime_observation_meta (
      id                  INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
      storage_failures    INTEGER NOT NULL DEFAULT 0 CHECK (storage_failures >= 0),
      logger_failures     INTEGER NOT NULL DEFAULT 0 CHECK (logger_failures >= 0),
      rejected_records    INTEGER NOT NULL DEFAULT 0 CHECK (rejected_records >= 0),
      dropped_events      INTEGER NOT NULL DEFAULT 0 CHECK (dropped_events >= 0),
      history_truncated   INTEGER NOT NULL DEFAULT 0 CHECK (history_truncated IN (0, 1))
    );
    -- 基线不随 events 的时间/条数轮转清除；只留每个指标作用域的最新快照。
    CREATE TABLE agent_runtime_usage_snapshots (
      id              TEXT PRIMARY KEY NOT NULL,
      binding_id      TEXT NOT NULL,
      source          TEXT NOT NULL CHECK (source IN ('claude-code', 'codex-cli', 'dsh')),
      harness_version TEXT NOT NULL,
      metric          TEXT NOT NULL CHECK (metric IN ('inputTokens', 'cachedInputTokens', 'outputTokens', 'costUsd')),
      scope           TEXT NOT NULL CHECK (scope IN ('turn', 'invocation', 'session')),
      scope_id        TEXT NOT NULL,
      epoch_id        TEXT NOT NULL,
      sequence        INTEGER NOT NULL CHECK (sequence >= 0),
      observed_at     TEXT NOT NULL,
      payload         TEXT NOT NULL,
      UNIQUE (binding_id, source, harness_version, metric, scope, scope_id, epoch_id)
    );
    CREATE INDEX ix_runtime_usage_binding ON agent_runtime_usage_snapshots (binding_id, observed_at, id);
  `,
};
