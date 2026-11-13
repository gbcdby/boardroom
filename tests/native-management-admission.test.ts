import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { copyFileSync, existsSync, realpathSync, renameSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { ConfigError } from "../src/server/config-error.ts";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { migrateOtherToDsh } from "../src/server/db/migrate-host-type.ts";
import { openNativeManagementSource } from "../src/server/storage/native-management-admission.ts";
import { StorageMaintenanceError } from "../src/server/storage/admission.ts";
import type { SqliteDatabaseDescriptor } from "../src/server/environment.ts";

function source(dir: string): SqliteDatabaseDescriptor {
  const sourcePath = path.join(dir, "agent-studio.db");
  // tmpdir() may contain a directory alias; the descriptor keeps the original entry separately.
  const sqlitePath = realpathSync(sourcePath);
  const stat = statSync(sqlitePath, { bigint: true });
  return { kind: "sqlite", dataDir: realpathSync(dir), sqlitePath, sourcePath,
    identity: { device: String(stat.dev), inode: String(stat.ino) } };
}

const currentMigrationVersion = Math.max(...migrations.map(migration => migration.version));

async function fixture(body: (db: Database.Database, dir: string) => Promise<void>, version = currentMigrationVersion): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-native-management-"));
  const db = new Database(path.join(dir, "agent-studio.db"));
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db, migrations.filter(migration => migration.version <= version));
    db.prepare("INSERT INTO agents(id,display_name,host_type,created_at,updated_at) VALUES('old','legacy','other','t','t')").run();
    await body(db, dir);
  } finally {
    if (db.open) db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function beginMaintenance(db: Database.Database): void {
  // Test controller fixture only: product journal/publication is D's separate acceptance scope.
  db.prepare(`UPDATE storage_maintenance SET admission='draining',fence_epoch=fence_epoch+1,owner_generation=1,
    active_migration_id='fixture-maintenance',plan_digest=?,control_root_json='{}',mutex_identity_json='{}',
    journal_record_ref='fixture-record',journal_digest=?,journal_sequence=1 WHERE singleton=1`).run("a".repeat(64), "b".repeat(64));
}

function logicalSnapshot(db: Database.Database): Record<string, unknown> {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]));
}

function assertUnchangedBusiness(db: Database.Database): void {
  assert.deepEqual(db.prepare("SELECT host_type FROM agents WHERE id='old'").get(), { host_type: "other" });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM agent_legacy_aliases").get() as { n: number }).n, 0);
}

test("#152 native helper：raw Database / forged lease 在业务 SQL 之前拒绝", async () => fixture(async db => {
  for (const input of [db, {}, { mode: "write" }, null]) {
    assert.throws(() => migrateOtherToDsh(input as unknown as Parameters<typeof migrateOtherToDsh>[0]),
      (error: unknown) => error instanceof ConfigError && error.code === "storage_maintenance");
  }
  assert.deepEqual(db.prepare("SELECT host_type FROM agents WHERE id='old'").get(), { host_type: "other" });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM agent_legacy_aliases").get() as { n: number }).n, 0);
}));

test("#152 native：注册后 draining 不得新写；关闭真实连接后才发布本 client 回执", async () => fixture(async (db, dir) => {
  const lease = await openNativeManagementSource({ source: source(dir), mode: "write" });
  beginMaintenance(db);
  assert.throws(() => migrateOtherToDsh(lease), (error: unknown) => error instanceof StorageMaintenanceError && error.reason === "active");
  assertUnchangedBusiness(db);
  const beforeClose = db.prepare("SELECT ended_at,drain_receipt_digest FROM storage_source_clients").get();
  assert.deepEqual(beforeClose, { ended_at: null, drain_receipt_digest: null });
  await lease.close();
  const client = db.prepare("SELECT * FROM storage_source_clients").get() as Record<string, unknown>;
  assert.equal(client.drain_state, "drained");
  assert.equal(client.drain_epoch, 1);
  assert.equal(client.registered_epoch, 0);
  assert.equal(client.observed_epoch, 1);
  assert.equal(typeof client.ended_at, "string");
  const envelope = JSON.parse(String(client.db_sessions_json));
  assert.equal(envelope.formatVersion, 1);
  assert.equal(envelope.sessions[0].state, "closed");
  assert.deepEqual(envelope.drainReceipt.nativeTransactions, { committed: 0, rolledBack: 0, notAdmitted: 1 });
  assert.deepEqual(envelope.drainReceipt.quiescence, { activeTransactions: 0, activeJobs: 0, openFileWriters: 0, businessConnectionsClosed: true });
  assert.equal(envelope.drainReceipt.migrationId, "fixture-maintenance");
  // Independently sort plain JSON with a replacer over the complete key set, then hash the actual body.
  const keys = new Set<string>();
  JSON.stringify(envelope.drainReceipt, (key, value) => { if (key) keys.add(key); return value; });
  const hash = createHash("sha256").update(JSON.stringify(envelope.drainReceipt, [...keys].sort())).digest("hex");
  assert.equal(client.drain_receipt_digest, hash);
  assertUnchangedBusiness(db);
}));

test("#152 native：draining/sealed readonly dry-run 全表逻辑快照不变、零 client 登记", async () => fixture(async (db, dir) => {
  beginMaintenance(db);
  for (const admission of ["draining", "sealed"]) {
    db.prepare("UPDATE storage_maintenance SET admission=?").run(admission);
    const before = logicalSnapshot(db);
    await assert.rejects(openNativeManagementSource({ source: source(dir), mode: "write" }),
      (error: unknown) => error instanceof StorageMaintenanceError && error.reason === "active");
    const lease = await openNativeManagementSource({ source: source(dir), mode: "readonly-dry-run" });
    try {
      assert.equal(lease.registeredEpoch, null);
      const report = migrateOtherToDsh(lease);
      assert.equal(report.dryRun, true);
      assert.equal(report.changedAgents, 1);
      assert.equal(report.changedSessions, 0);
    } finally { await lease.close(); }
    assert.deepEqual(logicalSnapshot(db), before);
  }
}));

test("#152 native：cancel 开新 epoch 后旧 lease 仍拒绝，新登记与不同源可正常执行", async () => fixture(async (db, dir) => {
  const old = await openNativeManagementSource({ source: source(dir), mode: "write" });
  beginMaintenance(db);
  db.prepare("UPDATE storage_maintenance SET admission='open',fence_epoch=fence_epoch+1,active_migration_id=NULL,plan_digest=NULL").run();
  assert.throws(() => migrateOtherToDsh(old), (error: unknown) => error instanceof StorageMaintenanceError && error.reason === "epoch_changed");
  assertUnchangedBusiness(db);
  await old.close();
  await assert.rejects(openNativeManagementSource({ source: source(dir), mode: "write", expectedOpenEpoch: 0 }),
    (error: unknown) => error instanceof StorageMaintenanceError && error.reason === "epoch_changed");
  const fresh = await openNativeManagementSource({ source: source(dir), mode: "write", expectedOpenEpoch: 2 });
  try { assert.equal(migrateOtherToDsh(fresh).changedAgents, 1); } finally { await fresh.close(); }
  beginMaintenance(db);
  await fixture(async (otherDb, otherDir) => {
    const other = await openNativeManagementSource({ source: source(otherDir), mode: "write" });
    try { assert.equal(migrateOtherToDsh(other).changedAgents, 1); } finally { await other.close(); }
    assert.equal((otherDb.prepare("SELECT admission FROM storage_maintenance").get() as { admission: string }).admission, "open");
  });
}));

test("#152 native：client 身份/进程/代际/ended 变化不能沿用登记能力", async () => fixture(async (db, dir) => {
  const lease = await openNativeManagementSource({ source: source(dir), mode: "write" });
  const initial = db.prepare("SELECT * FROM storage_source_clients").get() as Record<string, unknown>;
  try {
    for (const [field, changed] of [["client_id", "replaced"], ["process_identity_json", "{}"], ["registered_epoch", 9],
      ["ended_at", "already-ended"], ["build_id", "unknown"], ["db_sessions_json", "{}"]] as const) {
      db.prepare(`UPDATE storage_source_clients SET ${field}=?`).run(changed);
      assert.throws(() => migrateOtherToDsh(lease), (error: unknown) => error instanceof StorageMaintenanceError && error.reason === "metadata_invalid");
      assertUnchangedBusiness(db);
      db.prepare(`UPDATE storage_source_clients SET ${field}=?`).run(initial[field]);
    }
  } finally { await lease.close(); }
}));

test("#152 native factory：缺 v18/未知 schema/checksum/guard 明确拒绝且不登记或迁移", async () => {
  await fixture(async (db, dir) => {
    const before = logicalSnapshot(db);
    for (const mode of ["write", "readonly-dry-run"] as const)
      await assert.rejects(openNativeManagementSource({ source: source(dir), mode }), StorageMaintenanceError);
    assert.deepEqual(logicalSnapshot(db), before);
    assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='storage_maintenance'").get(), undefined);
  }, 17);
  await fixture(async (db, dir) => {
    const before = logicalSnapshot(db);
    assert.equal(db.prepare("SELECT version FROM schema_migrations WHERE version=?").get(currentMigrationVersion), undefined);
    for (const mode of ["write", "readonly-dry-run"] as const)
      await assert.rejects(openNativeManagementSource({ source: source(dir), mode }),
        (error: unknown) => error instanceof StorageMaintenanceError && error.reason === "metadata_invalid");
    assert.deepEqual(logicalSnapshot(db), before);
    assert.deepEqual(db.prepare("SELECT * FROM storage_source_clients").all(), []);
  }, currentMigrationVersion - 1);
  for (const alter of [
    `INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES(${currentMigrationVersion + 1},'unknown','invalid','t')`,
    "UPDATE schema_migrations SET checksum='changed' WHERE version=18",
    "DROP TABLE storage_source_clients",
  ]) await fixture(async (db, dir) => {
    db.exec(alter);
    const before = logicalSnapshot(db);
    for (const mode of ["write", "readonly-dry-run"] as const)
      await assert.rejects(openNativeManagementSource({ source: source(dir), mode }), StorageMaintenanceError);
    assert.deepEqual(logicalSnapshot(db), before);
  });
  await fixture(async (db, dir) => {
    const trigger = db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'br_storage_%' LIMIT 1").get() as { name: string };
    db.exec(`DROP TRIGGER "${trigger.name}"`);
    await assert.rejects(openNativeManagementSource({ source: source(dir), mode: "write" }),
      (error: unknown) => error instanceof StorageMaintenanceError && error.reason === "guard_incomplete");
    assert.deepEqual(db.prepare("SELECT * FROM storage_source_clients").all(), []);
  });
});

test("#152 native：sealed 后 close 关闭连接但不刷新 client 或伪造 drained", async () => fixture(async (db, dir) => {
  const lease = await openNativeManagementSource({ source: source(dir), mode: "write" });
  beginMaintenance(db);
  db.prepare("UPDATE storage_maintenance SET admission='sealed'").run();
  const before = logicalSnapshot(db);
  await assert.rejects(lease.close(), StorageMaintenanceError);
  assert.throws(() => migrateOtherToDsh(lease), ConfigError);
  assert.deepEqual(logicalSnapshot(db), before);
}));

test("#152 native：外部已有事务拒绝，不嵌套保存点或提交调用者事务", async () => fixture(async (db, dir) => {
  const original = Database.prototype.transaction;
  let captured: Database.Database | undefined;
  Database.prototype.transaction = function (fn) { captured = this; return original.call(this, fn); };
  let lease;
  try { lease = await openNativeManagementSource({ source: source(dir), mode: "write" }); }
  finally { Database.prototype.transaction = original; }
  assert.ok(captured);
  captured.exec("BEGIN");
  try {
    assert.throws(() => migrateOtherToDsh(lease), ConfigError);
    assert.equal(captured.inTransaction, true);
    assertUnchangedBusiness(db);
  } finally { captured.exec("ROLLBACK"); await lease.close(); }
}));

test("#152 native：已解析/已连接源消失或 inode 替换均拒绝，不建空库或重连目标", async () => {
  for (const mode of ["write", "readonly-dry-run"] as const) for (const replace of [false, true]) await fixture(async (db, dir) => {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.pragma("journal_mode = DELETE");
    const selected = source(dir);
    const replacement = path.join(dir, "replacement.db");
    if (replace) copyFileSync(selected.sqlitePath, replacement);
    const lease = await openNativeManagementSource({ source: selected, mode });
    const moved = path.join(dir, "original.db");
    renameSync(selected.sqlitePath, moved);
    if (replace) renameSync(replacement, selected.sqlitePath);
    const isChanged = (error: unknown) => error instanceof ConfigError && error.code === "storage_source_changed";
    assert.throws(() => migrateOtherToDsh(lease), isChanged);
    await assert.rejects(openNativeManagementSource({ source: selected, mode }), isChanged);
    if (mode === "write") await assert.rejects(lease.close(), isChanged);
    else await lease.close();
    assert.equal(existsSync(selected.sqlitePath), replace);
    assertUnchangedBusiness(db);
    if (replace) {
      const check = new Database(selected.sqlitePath, { readonly: true, fileMustExist: true });
      try { assertUnchangedBusiness(check); assert.deepEqual(check.prepare("SELECT * FROM storage_source_clients").all(), []); }
      finally { check.close(); }
    }
  });
});

test("#152 native：事务内源替换在提交前拒绝，已执行 agents/alias 写整体回滚", async () => fixture(async (db, dir) => {
  db.pragma("wal_checkpoint(TRUNCATE)"); db.pragma("journal_mode = DELETE");
  const selected = source(dir);
  const replacement = path.join(dir, "replacement.db");
  const originalPath = path.join(dir, "original.db");
  copyFileSync(selected.sqlitePath, replacement);
  const lease = await openNativeManagementSource({ source: selected, mode: "write" });
  const prepare = Database.prototype.prepare;
  let swapped = false;
  Database.prototype.prepare = (function (this: Database.Database, sql: string) {
    const statement = prepare.call(this, sql) as Database.Statement<unknown[]>;
    if (/UPDATE agents SET host_type/.test(sql)) {
      const run = statement.run;
      statement.run = function (...args: unknown[]) {
        const result = run.apply(this, args);
        renameSync(selected.sqlitePath, originalPath);
        renameSync(replacement, selected.sqlitePath);
        swapped = true;
        return result;
      };
    }
    return statement;
  }) as typeof prepare;
  try {
    assert.throws(() => migrateOtherToDsh(lease), (error: unknown) => error instanceof ConfigError && error.code === "storage_source_changed");
  } finally { Database.prototype.prepare = prepare; }
  assert.equal(swapped, true);
  assertUnchangedBusiness(db);
  await assert.rejects(lease.close(), (error: unknown) => error instanceof ConfigError && error.code === "storage_source_changed");
  const check = new Database(selected.sqlitePath, { readonly: true, fileMustExist: true });
  try { assertUnchangedBusiness(check); assert.deepEqual(check.prepare("SELECT * FROM storage_source_clients").all(), []); }
  finally { check.close(); }
}));

test("#152 native dry-run：只读事务结束到返回前仍核对源 pathname/inode", async () => fixture(async (db, dir) => {
  db.pragma("wal_checkpoint(TRUNCATE)"); db.pragma("journal_mode = DELETE");
  const selected = source(dir);
  const lease = await openNativeManagementSource({ source: selected, mode: "readonly-dry-run" });
  const transaction = Database.prototype.transaction;
  Database.prototype.transaction = function (fn) {
    const wrapper = transaction.call(this, fn);
    const deferred = wrapper.deferred;
    return Object.assign((...args: unknown[]) => wrapper(...args), { ...wrapper,
      deferred: (...args: unknown[]) => {
        const result = deferred(...args);
        renameSync(selected.sqlitePath, path.join(dir, "original.db"));
        return result;
      }, immediate: wrapper.immediate, exclusive: wrapper.exclusive }) as typeof wrapper;
  };
  try {
    assert.throws(() => migrateOtherToDsh(lease), (error: unknown) => error instanceof ConfigError && error.code === "storage_source_changed");
  } finally { Database.prototype.transaction = transaction; await lease.close(); }
  assert.equal(existsSync(selected.sqlitePath), false);
  assertUnchangedBusiness(db);
}));

test("#152 native factory：同源写登记、真实 helper 成功与 close 后拒绝", async () => fixture(async (db, dir) => {
  const lease = await openNativeManagementSource({ source: source(dir), mode: "write" });
  try {
    const rows = db.prepare("SELECT * FROM storage_source_clients").all() as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.entrypoint, "local-management");
    assert.equal(rows[0]?.registered_epoch, 0);
    assert.equal(rows[0]?.ended_at, null);
    assert.equal(lease.registeredEpoch, 0);
    assert.equal(Object.values(lease).some(value => value instanceof Database), false);
    assert.equal(migrateOtherToDsh(lease).changedAgents, 1);
    assert.deepEqual(db.prepare("SELECT host_type FROM agents WHERE id='old'").get(), { host_type: "dsh" });
  } finally { await lease.close(); }
  const row = db.prepare("SELECT ended_at, drain_epoch, drain_state FROM storage_source_clients").get() as Record<string, unknown>;
  assert.equal(typeof row.ended_at, "string");
  assert.equal(row.drain_epoch, null);
  assert.equal(row.drain_state, "none");
  assert.throws(() => migrateOtherToDsh(lease), (error: unknown) => error instanceof ConfigError && error.code === "storage_maintenance");
  await lease.close();
}));
