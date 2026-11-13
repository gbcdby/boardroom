import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createDbDriver } from "../src/server/db/driver.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { registerStorageSourceClient, verifyStorageDrainReceipt } from "../src/server/storage/source-client.ts";

const pgUrl = process.env.AGENT_STUDIO_PG_TEST_URL;
test("#152 PostgreSQL client登记实际backend，事务锁约束draining，关闭全部普通pool后发布回执", {
  skip: pgUrl ? false : "未配置真实 PostgreSQL；本机 NOT_RUN，保留真实 CI 门控", timeout: 20000,
}, async () => {
  const schema = `drain_${randomUUID().replaceAll("-", "")}`;
  const clientId = randomUUID();
  const url = new URL(pgUrl!); url.searchParams.set("application_name", `boardroom-source:${clientId}`);
  const db = createDbDriver({ dbDriver: "postgres", pgConnectionString: url.toString(), pgSchema: schema });
  const control = new Client({ connectionString: pgUrl }); await control.connect();
  let source: Awaited<ReturnType<typeof registerStorageSourceClient>> | undefined;
  try {
    await db.connect(); await db.migrate(migrations);
    await control.query(`SET search_path="${schema}"`);
    source = await registerStorageSourceClient({ db, clientId, entrypoint: "owned-background",
      database: { kind: "postgres", connectionString: pgUrl!, schema } });
    await source.bind({ stopNewWork() {}, async disconnectSessions() {},
      async stopOwnedRuntime() { return { ownedExits: [], unknownOwners: [] }; }, async observeOwnedExit() {}, async closeMemory() {} });
    const registration = (await control.query("SELECT * FROM storage_source_clients WHERE client_id=$1", [clientId])).rows[0];
    const envelope = JSON.parse(registration.db_sessions_json);
    const backends = envelope.sessions.find((s: any) => s.owner === "local-driver").observedBackends;
    assert.ok(backends.length > 0); assert.ok(backends.every((b: any) => Number.isInteger(b.pid) && typeof b.backend_start === "string"));
    await db.transaction(async tx => {
      await control.query("BEGIN"); await control.query("SET LOCAL lock_timeout='25ms'");
      await assert.rejects(control.query("UPDATE storage_maintenance SET owner_generation=owner_generation"), { code: "55P03" });
      await control.query("ROLLBACK");
      await tx.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES('p','actual-commit','t','t')");
    });
    await control.query(`UPDATE storage_maintenance SET admission='draining',fence_epoch=1,owner_generation=1,
      active_migration_id='pg-fixture',plan_digest=$1,control_root_json='{}',mutex_identity_json='{}',
      journal_record_ref='fixture',journal_digest=$2,journal_sequence=1`, ["a".repeat(64), "b".repeat(64)]);
    await source.refresh(); await assert.rejects(source.run(async () => {}), /storage_maintenance/);
    const receipt = await source.waitForDrain();
    const row = (await control.query("SELECT * FROM storage_source_clients WHERE client_id=$1", [clientId])).rows[0];
    assert.deepEqual(verifyStorageDrainReceipt(row, { databaseInstanceId: receipt.databaseInstanceId, fenceEpoch: 1,
      ownerGeneration: 1, migrationId: "pg-fixture", planDigest: "a".repeat(64) }), receipt);
    const remaining = await control.query("SELECT pid FROM pg_stat_activity WHERE application_name IN ($1,$2)",
      [`boardroom-source:${clientId}`, `boardroom-control:${clientId}`]);
    assert.equal(remaining.rows.length, 0, "不能把pool.end调用或关闭元数据冒充backend已消失");
    assert.equal((await control.query("SELECT name FROM projects WHERE id='p'")).rows[0].name, "actual-commit");
  } finally {
    await source?.close().catch(() => {}); await db.close();
    await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await control.end();
  }
});
