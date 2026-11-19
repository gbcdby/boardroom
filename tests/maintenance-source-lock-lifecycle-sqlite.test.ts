import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { protocolSqliteAuditFixture as sqliteAuditFixture } from "./fixtures/maintenance-source-audit.ts";
import { controlSeedColumns, controlSqlVector } from "./fixtures/maintenance-control-sql.ts";
import { applyUntrustedControlSql, controlSqlOutcome, noteControlSql } from "../src/server/storage/maintenance/control-sql.ts";
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

function assertOrdinaryOutcome(lock: SourceLock, expected: {
  commitStarted: boolean; commitReturned: boolean; failureObserved: boolean;
  rollbackFailureObserved: boolean; closeFailureObserved: boolean;
  originalError?: unknown; rollbackError?: unknown; closeError?: unknown;
  cleanupEvents?: readonly { stage: "rollback-failure" | "close-failure"; error: unknown }[];
}, sourceClosed = true) {
  const outcome = controlSqlOutcome(lock);
  assert.deepEqual(outcome, { kind: "untrusted-control-outcome", status: "unknown",
    localSourceHandleClosed: sourceClosed, localMutexHandleClosed: false,
    originalError: undefined, rollbackError: undefined, closeError: undefined, cleanupEvents: [], ...expected });
  // AC41 keeps raw occurrences in this private lifecycle record, including undefined.
  assert.equal(outcome.originalError, expected.originalError);
  assert.equal(outcome.rollbackError, expected.rollbackError); assert.equal(outcome.closeError, expected.closeError);
  assert.equal(Object.isFrozen(outcome), true);
  assert.equal(Object.isFrozen(outcome.cleanupEvents), true);
  for (const [index, event] of (expected.cleanupEvents ?? []).entries()) {
    assert.equal(outcome.cleanupEvents![index]!.error, event.error);
    assert.equal(Object.isFrozen(outcome.cleanupEvents![index]), true);
  }
  return outcome;
}

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
    const failure = scenario === "close-undefined" ? undefined : Object.assign(new Error("ordinary-sensitive-close"), { privateDetail: "ordinary-sensitive-value" });
    let captured: SourceLock | undefined, injected = false, rejected = false, rejection: unknown, value: unknown;
    try {
      if (scenario !== "success") child.mock.method(Database.prototype, "close", function (this: Database.Database) {
        const target = this.name === f.file && !this.readonly, result = close.call(this);
        if (target) { injected = true; throw failure; }
        return result;
      });
      try { value = await f.adapter.withSourceLock("control", async lock => { captured = lock; await ordinaryAnchor(f, lock); return "committed"; }); }
      catch (error) { rejected = true; rejection = error; }
      assert.equal(rejected, scenario !== "success");
      if (scenario === "success") assert.equal(value, "committed");
      else { assert.equal(injected, true); assert.equal(rejection, failure); }
      assert.ok(captured);
      assertOrdinaryOutcome(captured, { commitStarted: true, commitReturned: true, failureObserved: false,
        rollbackFailureObserved: false, closeFailureObserved: scenario !== "success",
        closeError: scenario === "success" ? undefined : failure,
        cleanupEvents: scenario === "success" ? [] : [{ stage: "close-failure", error: failure }] });
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
    const secondary = Object.assign(new Error("ordinary-sensitive-cleanup"), { privateDetail: "ordinary-sensitive-value" });
    let writer: Database.Database | undefined, captured: SourceLock | undefined, rollbacks = 0, closes = 0, rejected = false, rejection: unknown;
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
      try { await f.adapter.withSourceLock("control", async lock => { captured = lock; await ordinaryAnchor(f, lock); throw primary; }); }
      catch (error) { rejected = true; rejection = error; }
      assert.equal(rejected, true); assert.equal(rollbacks, 1); assert.equal(closes, 1);
      if (scenario === "busy") {
        assert.ok(rejection instanceof MaintenanceFailure); assert.equal(rejection.code, "maintenance_busy");
        assert.doesNotMatch(JSON.stringify(rejection), /ordinary-sensitive/);
      }
      else assert.equal(rejection, primary);
      assert.ok(captured);
      assertOrdinaryOutcome(captured, { commitStarted: false, commitReturned: false, failureObserved: true,
        rollbackFailureObserved: scenario !== "close", closeFailureObserved: scenario !== "rollback",
        originalError: primary, rollbackError: scenario === "close" ? undefined : secondary,
        closeError: scenario === "rollback" ? undefined : secondary,
        cleanupEvents: [
          ...(scenario === "close" ? [] : [{ stage: "rollback-failure" as const, error: secondary }]),
          ...(scenario === "rollback" ? [] : [{ stage: "close-failure" as const, error: secondary }]),
        ] });
      assert.deepEqual(independentlyRead(f.file), before);
    } finally { child.mock.restoreAll(); await f.close(); }
  });
});

test("#152 SQLite COMMIT first failure survives cleanup and independent reads distinguish actual commit", async t => {
  for (const mode of ["ordinary", "mechanism"] as const) for (const phase of ["before", "after"] as const) await t.test(mode + "-" + phase, async child => {
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
        captured = lock;
        if (mode === "mechanism") await applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef)); else await ordinaryAnchor(f, lock);
      }), error => error === primary);
      assert.equal(commits, 1); assert.equal(rollbacks, phase === "before" ? 1 : 0);
      const outcome = controlSqlOutcome(captured!);
      if (mode === "mechanism") {
        assert.equal(outcome.status, "unknown"); assert.equal(outcome.originalError, primary); assert.equal(outcome.closeError, closeFailure);
        assert.equal(outcome.rollbackFailureObserved, phase === "before");
        if (phase === "before") assert.equal(outcome.rollbackError, rollbackFailure);
      } else assertOrdinaryOutcome(captured!, { commitStarted: true, commitReturned: false, failureObserved: true,
        rollbackFailureObserved: phase === "before", closeFailureObserved: true,
        originalError: primary, rollbackError: phase === "before" ? rollbackFailure : undefined, closeError: closeFailure,
        cleanupEvents: [
          ...(phase === "before" ? [{ stage: "rollback-failure" as const, error: rollbackFailure }] : []),
          { stage: "close-failure", error: closeFailure },
        ] });
      if (phase === "before") assert.deepEqual(independentlyRead(f.file), before);
      else {
        const actual = independentlyRead(f.file);
        assert.equal((actual.maintenance[0] as {journal_record_ref: string}).journal_record_ref, mode === "mechanism" ? f.v.insertedRef.ref : f.v.zeroRef.ref);
        assert.equal(actual.clients.length, mode === "mechanism" ? 1 : 0, "an ambiguous COMMIT response is not evidence of rollback");
      }
    } finally { child.mock.restoreAll(); await f.close(); }
  });
});


test("#152 lifecycle notes on unbound values cannot create ordinary or control authority", () => {
  const unbound = Object.freeze({}) as SourceLock;
  for (const stage of ["committing", "committed", "failure", "rollback-failure", "close-failure"] as const) {
    noteControlSql(undefined, stage, new Error("ordinary-sensitive"));
    noteControlSql(unbound, stage, new Error("ordinary-sensitive"));
  }
  assert.deepEqual(controlSqlOutcome(unbound), { kind: "untrusted-control-outcome", status: "unknown" });
});
