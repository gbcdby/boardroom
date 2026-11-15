import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { sqliteAuditFixture } from "./fixtures/maintenance-source-audit.ts";
import { controlSeedColumns, controlSqlVector } from "./fixtures/maintenance-control-sql.ts";
import { applyUntrustedControlSql, controlSqlOutcome } from "../src/server/storage/maintenance/control-sql.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import type { SourceLock } from "../src/server/storage/maintenance/types.ts";

async function fixture() {
  const f = await sqliteAuditFixture(false);
  try {
    const v = controlSqlVector(await f.adapter.observeSourceClients(), f.store.identity, f.mutex.identity);
    const db = new Database(f.file), expected = v.reconstruct(v.capture).expectedMaintenance;
    try {
      const names = Object.keys(controlSeedColumns) as (keyof typeof controlSeedColumns)[];
      // Exact private mechanism seed only; this does not qualify a capture, Fs or source facts.
      db.prepare(`UPDATE storage_maintenance SET ${names.map(key => `${controlSeedColumns[key]}=?`).join(",")} WHERE singleton=1`)
        .run(...names.map(key => expected[key]));
    } finally { db.close(); }
    return { ...f, v };
  } catch (error) { await f.close(); throw error; }
}

function independentlyRead(file: string) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { return { maintenance: db.prepare("SELECT * FROM storage_maintenance").all(), clients: db.prepare("SELECT * FROM storage_source_clients ORDER BY client_id").all() }; }
  finally { db.close(); }
}

test("#152 SQLite source-lock preserves callback first failure and both cleanup failures", async t => {
  const f = await fixture(), before = independentlyRead(f.file);
  const primary = new MaintenanceFailure("source_changed", "lifecycle-first");
  const rollbackFailure = new Error("lifecycle-rollback"), closeFailure = new Error("lifecycle-close");
  const exec = Database.prototype.exec, close = Database.prototype.close;
  let writer: Database.Database | undefined, captured: SourceLock | undefined;
  let rolledBack = false, closed = false, rejected = false, rejection: unknown;
  try {
    t.mock.method(Database.prototype, "exec", function (this: Database.Database, sql: string) {
      if (this.name === f.file && !this.readonly && sql === "BEGIN IMMEDIATE") writer = this;
      const result = exec.call(this, sql);
      if (this === writer && sql === "ROLLBACK") { rolledBack = true; throw rollbackFailure; }
      return result;
    });
    t.mock.method(Database.prototype, "close", function (this: Database.Database) {
      const result = close.call(this);
      if (this === writer) { closed = true; throw closeFailure; }
      return result;
    });
    try {
      await f.adapter.withSourceLock("control", async lock => {
        captured = lock; await applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef)); throw primary;
      });
    } catch (error) { rejected = true; rejection = error; }
    assert.equal(rolledBack, true); assert.equal(closed, true);
    assert.equal(rejected, true); assert.ok(captured);
    const outcome = controlSqlOutcome(captured);
    assert.equal(outcome.status, "unknown"); assert.equal(outcome.originalError, primary);
    assert.equal(outcome.rollbackError, rollbackFailure); assert.equal(outcome.closeError, closeFailure);
    assert.deepEqual(independentlyRead(f.file), before, "the separate connection observes no partial row or anchor commit");
    assert.equal(rejection, primary, "ROLLBACK and close failures must not replace the callback's first failure");
  } finally { t.mock.restoreAll(); await f.close(); }
});

async function ordinaryAnchor(f: Awaited<ReturnType<typeof fixture>>, lock: SourceLock) {
  const state = (await lock.observeSourceClients()).state;
  await lock.anchor({ expected: state, admission: state.admission, fenceEpoch: state.fenceEpoch,
    ownerGeneration: state.ownerGeneration + 1, activeMigrationId: state.activeMigrationId, planDigest: state.planDigest,
    controlRootIdentity: { ...f.store.identity }, mutexIdentity: f.mutex.identity, journal: f.v.zeroRef,
    journalSequence: state.journalSequence + 1 });
}

test("#152 SQLite ordinary anchor retains successful commits and rejects standalone close failures", async t => {
  for (const scenario of ["success", "close-error", "close-undefined"] as const) await t.test(scenario, async child => {
    const f = await fixture(), close = Database.prototype.close;
    const failure = scenario === "close-undefined" ? undefined : new Error("ordinary-close");
    let injected = false, rejected = false, rejection: unknown, value: unknown;
    try {
      if (scenario !== "success") child.mock.method(Database.prototype, "close", function (this: Database.Database) {
        const target = this.name === f.file && !this.readonly, result = close.call(this);
        if (target) { injected = true; throw failure; }
        return result;
      });
      try { value = await f.adapter.withSourceLock("control", async lock => { await ordinaryAnchor(f, lock); return "committed"; }); }
      catch (error) { rejected = true; rejection = error; }
      assert.equal(rejected, scenario !== "success");
      if (scenario === "success") assert.equal(value, "committed");
      else { assert.equal(injected, true); assert.equal(rejection, failure); }
      const actual = independentlyRead(f.file);
      assert.equal((actual.maintenance[0] as {journal_record_ref: string}).journal_record_ref, f.v.zeroRef.ref);
      assert.deepEqual(actual.clients, [], "a post-COMMIT close error does not undo or repeat an ordinary anchor");
    } finally { child.mock.restoreAll(); await f.close(); }
  });
});

test("#152 SQLite callback error priority applies without a mechanism and does not use truthiness", async t => {
  for (const scenario of ["rollback", "close", "both", "undefined", "busy"] as const) await t.test(scenario, async child => {
    const f = await fixture(), before = independentlyRead(f.file), exec = Database.prototype.exec, close = Database.prototype.close;
    const primary = scenario === "undefined" ? undefined : scenario === "busy" ? Object.assign(new Error("native-busy"), { code: "SQLITE_BUSY" })
      : new MaintenanceFailure("phase_conflict", "ordinary-first");
    const secondary = new Error("ordinary-cleanup");
    let writer: Database.Database | undefined, rollbacks = 0, closes = 0, rejected = false, rejection: unknown;
    try {
      child.mock.method(Database.prototype, "exec", function (this: Database.Database, sql: string) {
        if (this.name === f.file && !this.readonly && sql === "BEGIN IMMEDIATE") writer = this;
        const result = exec.call(this, sql);
        if (this === writer && sql === "ROLLBACK") { rollbacks++; if (scenario !== "close") throw secondary; }
        return result;
      });
      child.mock.method(Database.prototype, "close", function (this: Database.Database) {
        const result = close.call(this);
        if (this === writer) { closes++; if (scenario !== "rollback") throw secondary; }
        return result;
      });
      try { await f.adapter.withSourceLock("control", async lock => { await ordinaryAnchor(f, lock); throw primary; }); }
      catch (error) { rejected = true; rejection = error; }
      assert.equal(rejected, true); assert.equal(rollbacks, 1); assert.equal(closes, 1);
      if (scenario === "busy") { assert.ok(rejection instanceof MaintenanceFailure); assert.equal(rejection.code, "maintenance_busy"); }
      else assert.equal(rejection, primary);
      assert.deepEqual(independentlyRead(f.file), before);
    } finally { child.mock.restoreAll(); await f.close(); }
  });
});

test("#152 SQLite COMMIT first failure survives cleanup and independent reads distinguish actual commit", async t => {
  for (const phase of ["before", "after"] as const) await t.test(phase, async child => {
    const f = await fixture(), before = independentlyRead(f.file), exec = Database.prototype.exec, close = Database.prototype.close;
    const primary = new MaintenanceFailure("snapshot_invalid", `commit-${phase}`);
    const rollbackFailure = new Error("commit-rollback"), closeFailure = new Error("commit-close");
    let writer: Database.Database | undefined, captured: SourceLock | undefined, commits = 0, rollbacks = 0;
    try {
      child.mock.method(Database.prototype, "exec", function (this: Database.Database, sql: string) {
        if (this.name === f.file && !this.readonly && sql === "BEGIN IMMEDIATE") writer = this;
        if (this === writer && sql === "COMMIT") { commits++; if (phase === "before") throw primary; }
        const result = exec.call(this, sql);
        if (this === writer && sql === "COMMIT") throw primary;
        if (this === writer && sql === "ROLLBACK") { rollbacks++; throw rollbackFailure; }
        return result;
      });
      child.mock.method(Database.prototype, "close", function (this: Database.Database) {
        const result = close.call(this); if (this === writer) throw closeFailure; return result;
      });
      await assert.rejects(f.adapter.withSourceLock("control", async lock => {
        captured = lock; await applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef));
      }), error => error === primary);
      assert.equal(commits, 1); assert.equal(rollbacks, phase === "before" ? 1 : 0);
      const outcome = controlSqlOutcome(captured!);
      assert.equal(outcome.status, "unknown"); assert.equal(outcome.originalError, primary); assert.equal(outcome.closeError, closeFailure);
      assert.equal(outcome.rollbackFailureObserved, phase === "before");
      if (phase === "before") { assert.equal(outcome.rollbackError, rollbackFailure); assert.deepEqual(independentlyRead(f.file), before); }
      else {
        const actual = independentlyRead(f.file);
        assert.equal((actual.maintenance[0] as {journal_record_ref: string}).journal_record_ref, f.v.insertedRef.ref);
        assert.equal(actual.clients.length, 1, "an ambiguous COMMIT response is not evidence of rollback");
      }
    } finally { child.mock.restoreAll(); await f.close(); }
  });
});
