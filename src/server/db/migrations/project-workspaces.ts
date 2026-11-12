import type { Migration } from "../migrate.ts";

/** #135：2026-11-11 总控核对活动序列后分配 v15；旧迁移及 checksum 不变。 */
export const projectWorkspacesMigration: Migration = {
  version: 15,
  name: "project_workspace_configuration_versions",
  up: `
    ALTER TABLE projects ADD COLUMN project_revision INTEGER NOT NULL DEFAULT 1 CHECK (project_revision >= 1);
    ALTER TABLE projects ADD COLUMN workspace_revision INTEGER NOT NULL DEFAULT 0 CHECK (workspace_revision >= 0);
    CREATE TABLE project_workspace_versions (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      workspace_revision INTEGER NOT NULL CHECK (workspace_revision >= 1),
      project_revision INTEGER NOT NULL CHECK (project_revision >= 1),
      root_path TEXT,
      canonical_root TEXT,
      mode TEXT NOT NULL CHECK (mode IN ('isolated', 'serialized')),
      root_identity_json TEXT,
      physical_resource_key TEXT,
      repository_info_json TEXT,
      observed_at TEXT NOT NULL,
      mutation_id TEXT NOT NULL CHECK (length(mutation_id) > 0),
      input_digest TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, workspace_revision),
      UNIQUE (project_id, mutation_id),
      CHECK ((root_path IS NULL AND canonical_root IS NULL AND root_identity_json IS NULL
        AND physical_resource_key IS NULL AND repository_info_json IS NULL)
        OR (root_path IS NOT NULL AND canonical_root IS NOT NULL AND root_identity_json IS NOT NULL
        AND physical_resource_key IS NOT NULL AND repository_info_json IS NOT NULL))
    );
  `,
};
