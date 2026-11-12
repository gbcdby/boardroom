import type { Migration } from "../migrate.ts";

/** #159：总控于2026-11-12分配v19。全局目录留在当前活动数据库；所有新表均为受维护guards保护的业务表。 */
export const mcpConnectionsMigration: Migration = {
  version: 19,
  name: "mcp_connections_and_catalog_snapshots",
  up: `
    CREATE TABLE mcp_connections (
      id TEXT PRIMARY KEY NOT NULL,
      revision BIGINT NOT NULL CHECK (revision >= 1 AND revision <= 9007199254740991),
      discovery_sequence BIGINT NOT NULL DEFAULT 0 CHECK (discovery_sequence >= 0 AND discovery_sequence <= 9007199254740991),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE mcp_connection_versions (
      connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
      revision BIGINT NOT NULL CHECK (revision >= 1 AND revision <= 9007199254740991),
      name TEXT NOT NULL,
      configuration_json TEXT NOT NULL,
      configuration_digest TEXT NOT NULL CHECK (length(configuration_digest) = 64),
      created_at TEXT NOT NULL,
      PRIMARY KEY (connection_id, revision)
    );
    CREATE TABLE mcp_catalog_snapshots (
      id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 64),
      connection_id TEXT NOT NULL,
      connection_revision BIGINT NOT NULL CHECK (connection_revision >= 1 AND connection_revision <= 9007199254740991),
      snapshot_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      UNIQUE (connection_id, connection_revision, id),
      FOREIGN KEY (connection_id, connection_revision) REFERENCES mcp_connection_versions(connection_id, revision) ON DELETE CASCADE
    );
    CREATE TABLE mcp_catalog_heads (
      connection_id TEXT NOT NULL,
      connection_revision BIGINT NOT NULL CHECK (connection_revision >= 1 AND connection_revision <= 9007199254740991),
      snapshot_id TEXT NOT NULL,
      PRIMARY KEY (connection_id, connection_revision),
      FOREIGN KEY (connection_id, connection_revision, snapshot_id)
        REFERENCES mcp_catalog_snapshots(connection_id, connection_revision, id) ON DELETE CASCADE
    );
    CREATE TABLE mcp_connection_mutations (
      request_id TEXT PRIMARY KEY NOT NULL,
      input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
      connection_id TEXT REFERENCES mcp_connections(id) ON DELETE CASCADE,
      result_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE mcp_discovery_attempts (
      id TEXT PRIMARY KEY NOT NULL,
      request_id TEXT NOT NULL UNIQUE,
      input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
      connection_id TEXT NOT NULL,
      connection_revision BIGINT NOT NULL CHECK (connection_revision >= 1 AND connection_revision <= 9007199254740991),
      sequence BIGINT NOT NULL CHECK (sequence >= 1 AND sequence <= 9007199254740991),
      owner_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running','cancel_requested','succeeded','blocked','connection_failed',
        'discovery_failed','cancelled','timed_out','superseded')),
      error_code TEXT,
      snapshot_id TEXT REFERENCES mcp_catalog_snapshots(id) ON DELETE RESTRICT,
      cleanup TEXT NOT NULL CHECK (cleanup IN ('pending','not_opened','closed','remote_unsupported','remote_unknown')),
      protocol_version TEXT,
      page_count INTEGER CHECK (page_count IS NULL OR page_count >= 0),
      created_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE (connection_id, sequence),
      FOREIGN KEY (connection_id, connection_revision) REFERENCES mcp_connection_versions(connection_id, revision) ON DELETE CASCADE
    );
    CREATE INDEX ix_mcp_discovery_connection ON mcp_discovery_attempts(connection_id, sequence);
    CREATE INDEX ix_mcp_snapshots_connection ON mcp_catalog_snapshots(connection_id, observed_at, id);
  `,
};
