import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { createDbDriver, type DbDriver } from "../../src/server/db/driver.ts";
import { SqliteDriver } from "../../src/server/db/drivers/sqlite.ts";
import { checksumOf, migrationSql } from "../../src/server/db/migrate.ts";
import { migrations } from "../../src/server/db/migrations/index.ts";
import { assertPostgresGuardCoverage, assertSqliteGuardCoverage } from "../../src/server/storage/schema-guards.ts";

const pgUrl = process.env["AGENT_STUDIO_PG_TEST_URL"] ?? process.env["AGENT_STUDIO_PG_CONNECTION_STRING"];
const skip = (engine: "sqlite" | "postgres") => engine === "postgres" && !pgUrl
  ? "未配置真实 PostgreSQL；由数据库 CI 门控执行" : false;

async function tableExists(db: DbDriver, engine: "sqlite" | "postgres", name: string): Promise<boolean> {
  const rows = engine === "sqlite"
    ? await db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name])
    : await db.query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?", [name]);
  return rows.length > 0;
}

function count(rows: readonly Record<string, unknown>[]): number {
  return Number(rows[0]?.["n"] ?? -1);
}

for (const engine of ["sqlite", "postgres"] as const) {
  test(`${engine} v23 惰性只加表：连续 1–23、空表、旧 markdown 权威、checksum 不变、guard 扩展与幂等`, { skip: skip(engine) }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "memory-object-refs-v23-"));
    const schema = `mor_v23_${randomUUID().replaceAll("-", "")}`;
    const db = createDbDriver(engine === "sqlite" ? { dbDriver: "sqlite", dataDir: dir }
      : { dbDriver: "postgres", pgConnectionString: pgUrl!, pgSchema: schema });
    try {
      await db.connect();
      await db.migrate(migrations.filter(m => m.version <= 22));
      assert.equal(await tableExists(db, engine, "memory_object_refs"), false);

      const at = new Date().toISOString();
      const projectId = "p-v23", documentId = "d-v23", versionId = "v-v23", refId = "r-v23";
      await db.exec("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", [projectId, "旧项目", at, at]);
      await db.exec(`INSERT INTO memory_documents
        (id, scope, project_id, agent_id, version, markdown, byte_length, updated_at, updated_by, source)
        VALUES (?, 'project', ?, NULL, 1, ?, ?, ?, ?, 'agent')`, [documentId, projectId, "旧正文", 9, at, "actor"]);
      await db.exec(`INSERT INTO memory_versions
        (id, document_id, version, parent_version, markdown, byte_length, content_sha256, author, actor_id, source, client_mutation_id, created_at)
        VALUES (?, ?, 1, 0, ?, ?, ?, 'actor', 'actor', 'agent', 'cm-v23', ?)`,
      [versionId, documentId, "旧正文", 9, "a".repeat(64), at]);

      const beforeMarkdown = await db.query("SELECT markdown, byte_length FROM memory_documents WHERE id = ?", [documentId]);
      const beforeVersions = await db.query("SELECT markdown, content_sha256 FROM memory_versions WHERE id = ?", [versionId]);
      const beforeMigrations = (await db.migrationState()).applied;
      const guardBefore = (await db.query("SELECT guard_manifest_digest FROM storage_maintenance WHERE singleton = ?", [1]))[0]!["guard_manifest_digest"];

      const result = await db.migrate(migrations);
      assert.equal(result.version, 23);
      assert.deepEqual(result.applied.map(m => m.version), [23]);
      const after = (await db.migrationState()).applied;
      assert.deepEqual(after.map(m => m.version), Array.from({ length: 23 }, (_, index) => index + 1));
      assert.equal(after.length, beforeMigrations.length + 1);
      assert.deepEqual(after.slice(0, 22), beforeMigrations, "v1–v22 的 checksum 与 applied_at 不变");
      const v23 = migrations.find(m => m.version === 23)!;
      assert.equal(after[22]!.checksum, checksumOf(migrationSql(v23, engine)));

      assert.equal(await tableExists(db, engine, "memory_object_refs"), true);
      assert.equal(count(await db.query("SELECT COUNT(*) AS n FROM memory_object_refs")), 0, "惰性创建后新表为空");
      assert.deepEqual(await db.query("SELECT markdown, byte_length FROM memory_documents WHERE id = ?", [documentId]), beforeMarkdown);
      assert.deepEqual(await db.query("SELECT markdown, content_sha256 FROM memory_versions WHERE id = ?", [versionId]), beforeVersions);

      const guardAfter = (await db.query("SELECT guard_manifest_digest FROM storage_maintenance WHERE singleton = ?", [1]))[0]!["guard_manifest_digest"];
      assert.notEqual(guardAfter, guardBefore, "迁移事务内自动扩展 guard manifest");
      if (engine === "sqlite") {
        assert.equal(assertSqliteGuardCoverage((db as SqliteDriver).handle), guardAfter);
        const sqliteTriggers = await db.query(
          "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ? AND name LIKE 'br_storage_%'",
          ["memory_object_refs"],
        );
        assert.equal(sqliteTriggers.length, 3, "SQLite 新表获得 insert/update/delete 三个 row trigger");
        assert.deepEqual(
          sqliteTriggers.map(row => /BEFORE (INSERT|UPDATE|DELETE)/.exec(String(row["sql"]))?.[1]).sort(),
          ["DELETE", "INSERT", "UPDATE"],
        );
      } else {
        // 与 tests/storage-maintenance-postgres.test.ts 一致：guard coverage 断言接收
        // PoolClient.query() 的 QueryResult（.rows），不能用 DbDriver.query() 的行数组适配器。
        const guardPool = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}` });
        try {
          const controller = await guardPool.connect();
          try {
            assert.equal(await assertPostgresGuardCoverage(controller), guardAfter);
          } finally { controller.release(); }
        } finally { await guardPool.end(); }
        // PG 每表只有一个 statement-level trigger（tgtype=62：BEFORE + INSERT/UPDATE/DELETE/TRUNCATE，
        // 非 ROW 级），函数 boardroom_storage_write_guard；与 schema-guards.ts 的 pgVerify 一致。
        const triggers = await db.query(`SELECT t.tgname, t.tgtype, t.tgenabled, t.tgisinternal,
          t.tgconstraint::text AS tgconstraint, p.proname, n.nspname AS function_schema, current_schema() AS schema
          FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace s ON s.oid = c.relnamespace
          JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE s.nspname = current_schema() AND c.relname = ? AND t.tgname LIKE 'br_storage_%'`, ["memory_object_refs"]);
        assert.equal(triggers.length, 1, "PG 新表获得 1 个 statement-level guard trigger");
        const trigger = triggers[0]!;
        assert.match(String(trigger["tgname"]), /^br_storage_.*_write$/);
        assert.equal(Number(trigger["tgtype"]), 62, "BEFORE INSERT/UPDATE/DELETE/TRUNCATE，非 ROW 级");
        assert.equal(trigger["tgenabled"], "O");
        assert.equal(trigger["tgisinternal"], false);
        assert.equal(trigger["tgconstraint"], "0");
        assert.equal(trigger["proname"], "boardroom_storage_write_guard");
        assert.equal(trigger["function_schema"], trigger["schema"]);
      }

      const insertRef = (overrides: Record<string, unknown> = {}) => {
        const values = {
          id: refId, document_id: documentId, version: 1, scope: "project", project_id: projectId, agent_id: null,
          document_kind: "note", body_storage_id: "store-v23", body_object_format: "raw",
          body_content_sha256: "b".repeat(64), byte_length: 9, created_at: at, ...overrides,
        };
        return db.exec(`INSERT INTO memory_object_refs
          (id, document_id, version, scope, project_id, agent_id, document_kind,
           body_storage_id, body_object_format, body_content_sha256, byte_length, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, Object.values(values));
      };
      await insertRef();
      assert.equal(count(await db.query("SELECT COUNT(*) AS n FROM memory_object_refs")), 1);
      await assert.rejects(insertRef({ id: "r-bad-kind", document_kind: "summary" }), /violat|CHECK|constraint/i);
      await assert.rejects(insertRef({ id: "r-bad-version", version: 0 }), /violat|CHECK|constraint/i);
      await assert.rejects(insertRef({ id: "r-bad-scope", scope: "global" }), /violat|CHECK|constraint/i);
      await assert.rejects(insertRef({ id: "r-bad-doc", document_id: "missing" }), /foreign key|FOREIGN KEY|constraint/i);
      await assert.rejects(insertRef({ id: "r-bad-version-fk", version: 2 }), /foreign key|FOREIGN KEY|constraint/i);
      await assert.rejects(insertRef({ id: "r-duplicate" }), /UNIQUE|unique|duplicate/i);
      await db.exec("DELETE FROM memory_object_refs WHERE id = ?", [refId]);
      assert.equal(count(await db.query("SELECT COUNT(*) AS n FROM memory_object_refs")), 0);

      const second = await db.migrate(migrations);
      assert.deepEqual(second.applied, []);
      assert.equal(second.version, 23);
      assert.deepEqual((await db.migrationState()).applied, after, "重复迁移幂等");
    } finally {
      await db.close();
      if (engine === "postgres") {
        const admin = new Client({ connectionString: pgUrl });
        await admin.connect();
        try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
}
