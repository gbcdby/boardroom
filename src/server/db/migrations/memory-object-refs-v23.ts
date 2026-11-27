import type { Migration } from "../migrate.ts";

/**
 * #161 切片 A：惰性新建记忆对象引用表。
 *
 * 本迁移只创建结构：不改 memory_documents / memory_versions 的列与索引，不回填，
 * 不切换默认读写，不激活 v2；旧 markdown 仍是唯一正文权威。两方言使用同一份
 * 可移植 DDL，checksum 由运行器按方言分别计算，旧迁移 checksum 不变。
 * 表级 CHECK 置于所有列定义之后：SQLite 不允许在表约束后继续声明列。
 */
const ddl = `
  CREATE TABLE memory_object_refs (
    id TEXT PRIMARY KEY NOT NULL,
    document_id TEXT NOT NULL REFERENCES memory_documents(id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK (version >= 1),
    scope TEXT NOT NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    agent_id TEXT REFERENCES agents(id) ON DELETE RESTRICT,
    document_kind TEXT NOT NULL CHECK (document_kind = 'note'),
    body_storage_id TEXT NOT NULL,
    body_object_format TEXT NOT NULL,
    body_content_sha256 TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    CHECK ((scope = 'global' AND project_id IS NULL AND agent_id IS NOT NULL)
      OR (scope = 'project' AND project_id IS NOT NULL AND agent_id IS NULL)
      OR (scope = 'project-agent' AND project_id IS NOT NULL AND agent_id IS NOT NULL)),
    FOREIGN KEY (document_id, version) REFERENCES memory_versions(document_id, version) ON DELETE CASCADE,
    UNIQUE (document_id, version, document_kind)
  );
  CREATE INDEX ix_memory_object_refs_scope
    ON memory_object_refs (scope, project_id, agent_id, document_kind);
`;

export const memoryObjectRefsV23Migration: Migration = {
  version: 23,
  name: "memory_object_refs",
  up: ddl,
  upPostgres: ddl,
};
