import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { ownerActor } from "../src/server/authz/actors.ts";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { BUSINESS_TABLES, copyAllTables, clearTargetTables, compareData } from "../src/server/db/migrate-data.ts";
import { createMcpConnections } from "../src/server/mcp/connections/service.ts";
import { createToolCatalogSnapshot, inspectMcpConnection } from "../src/server/mcp/capabilities/catalog.ts";
import { canonicalJson } from "../src/server/mcp/capabilities/json.ts";
import type { DbDriver } from "../src/server/db/driver.ts";
import { identityEngines, identityFixture, identityPgUrl, identitySkip } from "./helpers/identity-fixture.ts";
import { discoveryTestServer, discoveryTool } from "./helpers/mcp-discovery-server.ts";

const user = { actor: ownerActor() };
const catalogTableNames = ["mcp_connections", "mcp_connection_versions", "mcp_catalog_snapshots", "mcp_catalog_heads", "mcp_connection_mutations", "mcp_discovery_attempts"];
const catalogTables = catalogTableNames.map(name => { const spec = BUSINESS_TABLES.find(table => table.name === name); assert.ok(spec, `M1 缺少 ${name}`); return spec; });
async function seed(f: Awaited<ReturnType<typeof identityFixture>>) {
  const service = createMcpConnections({ db: f.db });
  let bad = false;
  const upstream = await discoveryTestServer({ page: () => bad ? { tools: "bad" } : { tools: [discoveryTool("copy", "number")] } });
  try {
    const configuration = { name: "复制 Unicode 🧪", enabled: true, transport: { type: "streamable-http", endpoint: upstream.endpoint } };
    const first = await service.create(user, { ...configuration, requestId: "create" });
    await service.update(user, first.connectionId, { ...configuration, name: "完整版本二", expectedRevision: 1, requestId: "update" });
    const succeeded = await service.discover(user, first.connectionId, { expectedRevision: 2, requestId: "good" });
    assert.equal(succeeded.status, "succeeded");
    bad = true;
    const failed = await service.discover(user, first.connectionId, { expectedRevision: 2, requestId: "bad" });
    assert.equal(failed.status, "discovery_failed");
    return first.connectionId;
  } finally { await service.close(); await upstream.close(); }
}

async function insertCatalog(db: DbDriver, id: string, revision: number) {
  const at = "2026-11-12T10:00:00.000Z";
  const connection = { connectionId: id, revision, enabled: true, transport: { type: "streamable-http", endpoint: "http://127.0.0.1:9000/mcp" } };
  const snapshot = createToolCatalogSnapshot({ connection, observedAt: at, discovery: { status: "available", tools: [discoveryTool("fixture")] } });
  await db.transaction(async () => {
    await db.exec("INSERT INTO mcp_connections(id,revision,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING", [id, revision, at, at]);
    await db.exec("INSERT INTO mcp_connection_versions(connection_id,revision,name,configuration_json,configuration_digest,created_at) VALUES(?,?,?,?,?,?)",
      [id, revision, "fixture", canonicalJson(connection), inspectMcpConnection(connection).configurationDigest, at]);
    await db.exec("INSERT INTO mcp_catalog_snapshots(id,connection_id,connection_revision,snapshot_json,observed_at) VALUES(?,?,?,?,?)",
      [snapshot.snapshotDigest, id, revision, canonicalJson(snapshot), at]);
    await db.exec("INSERT INTO mcp_catalog_heads(connection_id,connection_revision,snapshot_id) VALUES(?,?,?)", [id, revision, snapshot.snapshotDigest]);
  });
}

test("S7 真实 PG↔SQLite BIGINT 复合键无损相等，近安全整数邻值和数字样式文本 ID 仍可区分", { skip: identitySkip("postgres") }, async () => {
  const source = await identityFixture(), target = await identityFixture("postgres");
  const max = Number.MAX_SAFE_INTEGER;
  try {
    await insertCatalog(source.db, "01", 1);
    await insertCatalog(source.db, "1", max);
    await insertCatalog(source.db, "1", max - 1);
    await insertCatalog(source.db, "1", 1);
    await clearTargetTables(target.db); await copyAllTables(source.db, target.db);
    const query = "SELECT revision FROM mcp_connection_versions WHERE connection_id='1' AND revision=?";
    assert.equal((await source.db.query(query, [max]))[0]!.revision, max);
    assert.equal((await target.db.query(query, [max]))[0]!.revision, String(max));
    assert.equal((await compareData(source.db, target.db)).ok, true);
    assert.equal((await compareData(target.db, source.db)).ok, true);
    const replacement = (await target.db.query("SELECT * FROM mcp_connection_versions WHERE connection_id='1' AND revision=?", [max - 1]))[0]!;
    await target.db.exec("DELETE FROM mcp_connection_versions WHERE connection_id='1' AND revision=?", [max - 1]);
    await insertCatalog(target.db, "1", max - 2);
    let report = await compareData(source.db, target.db);
    assert.equal(report.tables.find(table => table.table === "mcp_connection_versions")!.countMatch, true);
    assert.equal(report.tables.find(table => table.table === "mcp_connection_versions")!.keysMatch, false, "邻接的大整数修订必须检测差异");
    assert.equal(report.tables.find(table => table.table === "mcp_catalog_heads")!.keysMatch, false);
    assert.equal(replacement.revision, String(max - 1));
    await clearTargetTables(target.db); await copyAllTables(source.db, target.db);
    await target.db.exec("DELETE FROM mcp_connections WHERE id='01'");
    await insertCatalog(target.db, "001", 1);
    report = await compareData(source.db, target.db);
    assert.equal(report.tables.find(table => table.table === "mcp_connection_versions")!.countMatch, true);
    assert.equal(report.tables.find(table => table.table === "mcp_connection_versions")!.keysMatch, false, "文本01/001/1不能转数字合并");
    assert.equal(report.tables.find(table => table.table === "mcp_catalog_heads")!.keysMatch, false);
  } finally { await source.close(); await target.close(); }
});

test("S7 声明整数键遇到 SQLite 非整数值必须 fail closed，不能把损坏的两份数据判相等", async () => {
  const source = await identityFixture(), target = await identityFixture();
  try {
    for (const f of [source, target]) {
      await insertCatalog(f.db, "text-id", 1);
      // SQLite 的 BIGINT affinity 仍可持有 REAL；此处构造实际损坏值，不弱化生产约束。
      await f.db.exec("INSERT INTO mcp_connection_versions(connection_id,revision,name,configuration_json,configuration_digest,created_at) VALUES('text-id',1.5,'bad','{}',?, 'fixture')", ["a".repeat(64)]);
    }
    await assert.rejects(compareData(source.db, target.db), /migration_integer_key_invalid/);
  } finally { await source.close(); await target.close(); }
});

for (const engine of identityEngines) {
  const skip = identitySkip(engine);
  test(`${engine} S7 非空 v18→v19 保留历史；全局连接/目录不被 project/group purge 删除`, { skip }, async () => {
    const f = await identityFixture(engine, 18);
    try {
      const p = await f.repos.projects.create({ name: "升级前项目" });
      const g = await f.repos.groups.create({ projectId: p.id, name: "升级前群组" });
      const history = await f.db.query("SELECT * FROM schema_migrations ORDER BY version");
      await f.db.migrate(migrations);
      assert.deepEqual(await f.db.query("SELECT * FROM schema_migrations WHERE version <= 18 ORDER BY version"), history);
      assert.equal((await f.repos.projects.get(p.id))!.name, "升级前项目");
      const id = await seed(f);
      const capture = () => Promise.all(catalogTables.map(table => f.db.query(`SELECT * FROM ${table.name} ORDER BY ${table.keyColumns.join(",")}`)));
      const before = await capture(); assert.equal(before.length, 6); assert.ok(before.every(rows => rows.length > 0));
      await f.repos.groups.archive(g.id); await f.repos.groups.purge(g.id);
      assert.deepEqual(await capture(), before);
      await f.repos.projects.archive(p.id); await f.repos.projects.purge(p.id);
      assert.deepEqual(await capture(), before);
      const service = createMcpConnections({ db: f.db });
      assert.equal((await service.get(user, id)).currentSnapshot!.tools.length, 1); await service.close();
      for (const table of catalogTables) {
        const rows = await f.db.query(`SELECT * FROM ${table.name} LIMIT 1`);
        assert.deepEqual(Object.keys(rows[0]!).sort(), [...table.keyColumns, ...table.valueColumns!].sort(), `${table.name} 的全部业务值必须参与 M1 比较`);
      }
    } finally { await f.close(); }
  });

  test(`${engine} S7 六张新业务表 sealed 时拒绝真实写入；失败事务不遗留幂等/目录半成品`, { skip }, async () => {
    const f = await identityFixture(engine);
    let control: Client | undefined;
    try {
      await seed(f);
      const before = await f.db.query("SELECT * FROM mcp_connection_mutations ORDER BY request_id");
      const service = createMcpConnections({ db: f.db });
      await assert.rejects(f.db.transaction(async () => {
        await service.create(user, { name: "不应提交", enabled: false, requestId: "rollback", transport: { type: "stdio", command: "cmd", args: [] } });
        throw new Error("rollback");
      }), /rollback/);
      assert.deepEqual(await f.db.query("SELECT * FROM mcp_connection_mutations ORDER BY request_id"), before);
      await service.close();
      const seal = `UPDATE storage_maintenance SET admission='sealed',fence_epoch=1,active_migration_id='s7-fixture',
        plan_digest='${"a".repeat(64)}',control_root_json='{}',mutex_identity_json='{}',journal_record_ref='fixture',
        journal_digest='${"b".repeat(64)}',journal_sequence=1 WHERE singleton=1`;
      if (engine === "sqlite") {
        const handle = (f.db as SqliteDriver).handle; handle.exec(seal);
        for (const table of catalogTables) assert.throws(() => handle.exec(`UPDATE ${table.name} SET ${table.keyColumns[0]}=${table.keyColumns[0]}`), /BOARDROOM_STORAGE_MAINTENANCE/, table.name);
      } else {
        const row = (await f.db.query<{ schema: string }>("SELECT current_schema() AS schema"))[0]!;
        const schema = row.schema;
        control = new Client({ connectionString: identityPgUrl, options: `-c search_path=${schema}` }); await control.connect();
        await control.query(seal);
        for (const table of catalogTables) await assert.rejects(control.query(`UPDATE ${table.name} SET ${table.keyColumns[0]}=${table.keyColumns[0]}`), /BOARDROOM_STORAGE_MAINTENANCE/, table.name);
      }
      await assert.rejects(f.db.exec("UPDATE mcp_connections SET revision=revision"), /storage_maintenance/);
    } finally { await control?.end(); await f.close(); }
  });

  test(`${engine} S7 全值跨库 copy/compare/clear 与回滚覆盖六张非空目录表`, { skip }, async () => {
    const source = await identityFixture(), target = await identityFixture(engine);
    try {
      await seed(source); await clearTargetTables(target.db);
      await assert.rejects(target.db.transaction(async () => {
        await copyAllTables(source.db, target.db); throw new Error("rollback-copy");
      }), /rollback-copy/);
      for (const table of catalogTables) assert.equal((await target.db.query(`SELECT * FROM ${table.name}`)).length, 0);
      const counts = await copyAllTables(source.db, target.db);
      for (const table of catalogTables) assert.ok(counts[table.name]! > 0, table.name);
      assert.equal((await compareData(source.db, target.db)).ok, true);
      // 主键/行数仍相同但真实业务值丢失时，验证必须失败。
      await target.db.exec("UPDATE mcp_discovery_attempts SET cleanup='remote_unknown' WHERE status='succeeded'");
      assert.equal((await compareData(source.db, target.db)).tables.find(table => table.table === "mcp_discovery_attempts")!.valuesMatch, false);
      await clearTargetTables(target.db); await copyAllTables(source.db, target.db);
      assert.equal((await compareData(source.db, target.db)).ok, true);
      // PG→SQLite 反向也验证完整外键顺序和不可变 JSON。
      const roundtrip = await identityFixture();
      try { await clearTargetTables(roundtrip.db); await copyAllTables(target.db, roundtrip.db); assert.equal((await compareData(source.db, roundtrip.db)).ok, true); }
      finally { await roundtrip.close(); }
      await clearTargetTables(target.db);
      for (const table of catalogTables) assert.equal((await target.db.query(`SELECT * FROM ${table.name}`)).length, 0);
    } finally { await source.close(); await target.close(); }
  });
}
