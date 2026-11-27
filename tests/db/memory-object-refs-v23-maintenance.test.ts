import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { DbDriver, DbTransaction } from "../../src/server/db/driver.ts";
import { BUSINESS_TABLES, clearTargetTables } from "../../src/server/db/migrate-data.ts";
import type { RepositorySet } from "../../src/server/db/repositories.ts";
import type { MemoryDocument, MemoryVersion } from "../../src/shared/memory.ts";
import { DECISION_MIGRATION_TABLES } from "../helpers/decisions-migration-fixture.ts";
import { identityEngines, identityFixture, identitySkip } from "../helpers/identity-fixture.ts";

const REF_VALUE_COLUMNS = [
  "document_id", "version", "scope", "project_id", "agent_id", "document_kind",
  "body_storage_id", "body_object_format", "body_content_sha256", "byte_length", "created_at",
] as const;

const EXPECTED_MEMORY_REVERSE = [
  "memory_message_receipts", "memory_scan_checkpoints", "memory_trigger_counters",
  "memory_summary_requests", "memory_object_refs", "memory_versions", "memory_documents",
] as const;

const V22_TABLES = [
  "agent_profiles", "agent_profile_versions", "group_bindings",
  "group_binding_config_versions", "config_compat_revisions", "config_mutation_receipts",
  "config_mutation_audit",
] as const;

const at = "2026-11-12T00:00:00.000Z";
const author = { kind: "human" as const, actorId: "owner", agentId: null, displayName: "人" };

async function count(db: DbDriver, table: string): Promise<number> {
  return Number((await db.query<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${table}`))[0]!.n);
}

async function seedMemory(repos: RepositorySet, db: DbDriver, engine: string) {
  const project = await repos.projects.create({ name: `v23维护项目-${engine}` });
  const agent = await repos.agents.create({ displayName: `v23维护Agent-${engine}`, hostType: "fixture" });
  const group = await repos.groups.create({ projectId: project.id, name: `v23维护群-${engine}` });
  const keys = [
    { scope: "project" as const, projectId: project.id, agentId: null },
    { scope: "project-agent" as const, projectId: project.id, agentId: agent.id },
    { scope: "global" as const, projectId: null, agentId: agent.id },
  ];
  let globalDocId = "";
  let globalRefId = "";
  let globalSha256 = "";
  let projectRefId = "";
  for (const key of keys) {
    const markdown = `# v23 维护 ${key.scope} 🧠`;
    const contentSha256 = createHash("sha256").update(markdown).digest("hex");
    const doc: MemoryDocument = { id: `doc-${engine}-${key.scope}`, key, version: 1, markdown,
      byteLength: Buffer.byteLength(markdown), updatedAt: at, updatedBy: author, source: "human" };
    const version: MemoryVersion = { id: `ver-${engine}-${key.scope}`, documentId: doc.id, version: 1,
      parentVersion: 0, markdown, byteLength: doc.byteLength, contentSha256, author, source: "human",
      clientMutationId: `cm-${engine}-${key.scope}`, summaryRequestId: null, createdAt: at };
    await repos.memory.insertHead(doc);
    await repos.memory.insertVersion(version);
    const refId = `ref-${engine}-${key.scope}`;
    await db.exec(`INSERT INTO memory_object_refs
      (id, document_id, version, scope, project_id, agent_id, document_kind,
       body_storage_id, body_object_format, body_content_sha256, byte_length, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [refId, doc.id, doc.version, key.scope, key.projectId, key.agentId,
      "note", `body-${key.scope}`, "raw", contentSha256, doc.byteLength, at]);
    if (key.scope === "global") {
      globalDocId = doc.id;
      globalRefId = refId;
      globalSha256 = contentSha256;
    } else if (key.scope === "project") projectRefId = refId;
  }
  return { projectId: project.id, agentId: agent.id, groupId: group.id,
    globalDocId, globalRefId, globalSha256, projectRefId };
}

test("v23 维护清单：memory_object_refs 精确列、反向顺序与 v22 七表边界", () => {
  const names = BUSINESS_TABLES.map(table => table.name);
  assert.equal(names.length, 59);
  const spec = BUSINESS_TABLES.find(table => table.name === "memory_object_refs")!;
  const position = names.indexOf("memory_object_refs");
  assert.equal(position, names.indexOf("memory_versions") + 1);
  assert.deepEqual(spec.keyColumns, ["id"]);
  assert.deepEqual(spec.valueColumns, [...REF_VALUE_COLUMNS]);
  assert.equal(spec.integerKeyColumns, undefined);
  assert.equal(spec.readSql, undefined);
  assert.deepEqual(names.filter(name => name.startsWith("memory_")).reverse(), EXPECTED_MEMORY_REVERSE);

  const fixtureTables: readonly string[] = DECISION_MIGRATION_TABLES;
  assert.equal(fixtureTables.length, 59);
  assert.equal(fixtureTables.indexOf("memory_object_refs"), fixtureTables.indexOf("memory_versions") + 1);
  for (const table of V22_TABLES) {
    assert.ok(!names.includes(table), `M1 清单不得并入 v22 表 ${table}`);
    assert.ok(!fixtureTables.includes(table), `迁移夹具不得并入 v22 表 ${table}`);
  }
});

for (const engine of identityEngines) {
  test(`${engine} v23 新表列与 clearTargetTables 反向顺序`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      await seedMemory(f.repos, f.db, engine);
      const columns = engine === "sqlite"
        ? (await f.db.query<{ name: string }>("PRAGMA table_info(memory_object_refs)")).map(row => row.name)
        : (await f.db.query<{ name: string }>("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position", ["memory_object_refs"])).map(row => row.name);
      assert.deepEqual(columns, ["id", ...REF_VALUE_COLUMNS]);

      const deleted: string[] = [];
      const captureDriver = Object.create(f.db) as DbDriver;
      captureDriver.transaction = <T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> =>
        f.db.transaction(async tx => {
          const capturedTx: DbTransaction = {
            query: (sql, params) => tx.query(sql, params),
            exec: async (sql, params) => { deleted.push(sql); return tx.exec(sql, params); },
          };
          return fn(capturedTx);
        });
      await clearTargetTables(captureDriver);
      assert.equal(deleted.length, BUSINESS_TABLES.length);
      assert.deepEqual(deleted.filter(sql => sql.startsWith("DELETE FROM memory_")),
        EXPECTED_MEMORY_REVERSE.map(name => `DELETE FROM ${name}`));
      for (const table of BUSINESS_TABLES) assert.equal(await count(f.db, table.name), 0, table.name);
    } finally { await f.close(); }
  });

  test(`${engine} v23 项目 purge 计数、显式顺序、陈旧 digest 与 global ref 保留`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      const seeded = await seedMemory(f.repos, f.db, engine);
      const preview = await f.repos.projects.capturePurge(seeded.projectId);
      assert.equal(preview.cascade.memoryDocuments, 2);
      assert.equal(preview.cascade.memoryVersions, 2);
      assert.equal(preview.cascade.memoryObjectRefs, 2);
      const groupPreview = await f.repos.groups.capturePurge(seeded.groupId);
      assert.ok(!("memoryObjectRefs" in groupPreview.cascade));

      await f.db.exec("UPDATE memory_object_refs SET body_content_sha256 = ? WHERE id = ?",
        ["c".repeat(64), seeded.projectRefId]);
      assert.equal(await count(f.db, "memory_object_refs"), 3);
      assert.equal((await f.repos.groups.capturePurge(seeded.groupId)).digest, groupPreview.digest,
        "群 purge 摘要不捕获 memory_object_refs");
      await assert.rejects(f.repos.projects.purge(seeded.projectId, preview.digest),
        error => (error as { code?: string }).code === "confirmation_changed");
      assert.equal(await count(f.db, "memory_object_refs"), 3);

      const fresh = await f.repos.projects.capturePurge(seeded.projectId);
      assert.notEqual(fresh.digest, preview.digest);
      const commands: string[] = [];
      const originalExec = f.repos.context.exec;
      f.repos.context.exec = async (sql, params) => { commands.push(sql); return originalExec(sql, params); };
      let removed: Awaited<ReturnType<typeof f.repos.projects.purge>>;
      try { removed = await f.repos.projects.purge(seeded.projectId, fresh.digest); }
      finally { f.repos.context.exec = originalExec; }

      const refsIndex = commands.findIndex(sql => sql.startsWith("DELETE FROM memory_object_refs "));
      const versionsIndex = commands.findIndex(sql => sql.startsWith("DELETE FROM memory_versions "));
      const documentsIndex = commands.findIndex(sql => sql.startsWith("DELETE FROM memory_documents "));
      assert.ok(refsIndex >= 0 && versionsIndex >= 0 && documentsIndex >= 0);
      assert.ok(refsIndex < versionsIndex && versionsIndex < documentsIndex);
      assert.equal(removed.memoryObjectRefs, 2);
      assert.equal(removed.memoryDocuments, 2);
      assert.equal(removed.memoryVersions, 2);
      assert.equal(await count(f.db, "memory_object_refs"), 1);
      assert.deepEqual(await f.db.query(
        "SELECT document_id, project_id, agent_id, body_content_sha256 FROM memory_object_refs WHERE id = ?",
        [seeded.globalRefId],
      ), [{ document_id: seeded.globalDocId, project_id: null, agent_id: seeded.agentId,
        body_content_sha256: seeded.globalSha256 }]);
    } finally { await f.close(); }
  });
}
