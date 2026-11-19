import test from "node:test";
import assert from "node:assert/strict";
import { Client, type QueryResult } from "pg";
import { protocolPostgresAuditFixture as postgresAuditFixture } from "./fixtures/maintenance-source-audit-postgres.ts";
import { controlSeedColumns, controlSqlVector } from "./fixtures/maintenance-control-sql.ts";
import { applyUntrustedControlSql, controlSqlOutcome } from "../src/server/storage/maintenance/control-sql.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import type { SourceLock } from "../src/server/storage/maintenance/types.ts";

// Missing local PostgreSQL is NOT_RUN, never evidence that this backend passed. CI supplies its private test URL.
const pgTest = process.env.AGENT_STUDIO_PG_TEST_URL ? test : test.skip;
const invokeQuery = (query: typeof Client.prototype.query, client: Client, args: unknown[]) => Reflect.apply(query, client, args) as Promise<QueryResult>;
const invokeEnd = (end: typeof Client.prototype.end, client: Client) => Reflect.apply(end, client, []) as Promise<void>;
const sqlText = (value: unknown) => typeof value === "string" ? value : typeof value === "object" && value !== null && "text" in value ? String(value.text) : "";
const database = (client: Client) => (client as unknown as { connectionParameters: { database: string } }).connectionParameters.database;

async function fixture() {
  const f = await postgresAuditFixture();
  try {
    const v = controlSqlVector(await f.adapter.observeSourceClients(), f.store.identity, f.mutex.identity);
    const db = await f.connect(), expected = v.reconstruct(v.capture).expectedMaintenance;
    try {
      // This is only an owned mechanism seed, not capture/Fs/provider qualification.
      await db.query("DELETE FROM storage_source_clients");
      const names = Object.keys(controlSeedColumns) as (keyof typeof controlSeedColumns)[];
      await db.query(`UPDATE storage_maintenance SET ${names.map((key, index) => `${controlSeedColumns[key]}=$${index + 1}`).join(",")} WHERE singleton=1`, names.map(key => expected[key]));
    } finally { await f.closeClient(db); }
    return { ...f, v };
  } catch (error) { await f.close(); throw error; }
}
async function independentlyRead(f: Awaited<ReturnType<typeof fixture>>) {
  const client = await f.connect("source-lock-lifecycle-independent-reader");
  try { return { maintenance: (await client.query("SELECT * FROM storage_maintenance")).rows,
    clients: (await client.query("SELECT * FROM storage_source_clients ORDER BY client_id")).rows }; }
  finally { await f.closeClient(client); }
}
function assertOrdinaryOutcome(lock: SourceLock, expected: {
  commitStarted: boolean; commitReturned: boolean; failureObserved: boolean;
  rollbackFailureObserved: boolean; closeFailureObserved: boolean;
  originalError?: unknown; rollbackError?: unknown; closeError?: unknown;
}, sourceClosed = true) {
  const outcome = controlSqlOutcome(lock);
  const cleanupEvents = [
    ...(expected.rollbackFailureObserved ? [{ stage: "rollback-failure", error: expected.rollbackError }] : []),
    ...(expected.closeFailureObserved ? [{ stage: "close-failure", error: expected.closeError }] : []),
  ];
  assert.deepEqual(outcome, { kind: "untrusted-control-outcome", status: "unknown",
    localSourceHandleClosed: sourceClosed, localMutexHandleClosed: false,
    originalError: undefined, rollbackError: undefined, closeError: undefined, ...expected, cleanupEvents });
  // This private untrusted observation retains raw occurrence identities for owner cleanup.
  // Safe mapping is checked on the actual public rejection, not by deleting private evidence.
  assert.equal(outcome.originalError, expected.originalError);
  assert.equal(outcome.rollbackError, expected.rollbackError); assert.equal(outcome.closeError, expected.closeError);
  outcome.cleanupEvents!.forEach((event, index) => {
    assert.equal(event.error, cleanupEvents[index]!.error); assert.equal(Object.isFrozen(event), true);
  });
  assert.equal(Object.isFrozen(outcome), true);
  assert.equal(Object.isFrozen(outcome.cleanupEvents), true);
  return outcome;
}

async function ordinaryAnchor(f: Awaited<ReturnType<typeof fixture>>, lock: SourceLock) {
  const state = (await lock.observeSourceClients()).state;
  await lock.anchor({ expected: state, admission: state.admission, fenceEpoch: state.fenceEpoch,
    ownerGeneration: state.ownerGeneration + 1, activeMigrationId: state.activeMigrationId, planDigest: state.planDigest,
    controlRootIdentity: { ...f.store.identity }, mutexIdentity: f.mutex.identity, journal: f.v.zeroRef,
    journalSequence: state.journalSequence + 1 });
}

pgTest("#152 PostgreSQL ordinary anchor requires confirmed end after its single real COMMIT", async t => {
  for (const phase of ["success", "end-before", "end-after", "end-undefined"] as const) await t.test(phase, async child => {
    const f = await fixture(), query = Client.prototype.query, end = Client.prototype.end;
    const failure = phase === "end-undefined" ? undefined : Object.assign(new Error("ordinary-sensitive-end"), { privateDetail: "ordinary-sensitive-value" });
    let writer: Client | undefined, captured: SourceLock | undefined, injected = false, cleanupReachedOwnedSession = false, commits = 0, rollbacks = 0;
    let rejected = false, rejection: unknown, value: unknown;
    try {
      child.mock.method(Client.prototype, "query", (async function (this: Client, ...args: unknown[]) {
        const sql = sqlText(args[0]);
        if (database(this) === f.database && sql.startsWith("UPDATE storage_maintenance SET admission=")) writer = this;
        if (this === writer && sql === "COMMIT") commits++;
        if (this === writer && sql === "ROLLBACK") rollbacks++;
        return invokeQuery(query, this, args);
      }) as typeof query);
      child.mock.method(Client.prototype, "end", (async function (this: Client) {
        if (this === writer && phase !== "success" && !injected) {
          injected = true;
          if (phase !== "end-before") await invokeEnd(end, this);
          throw failure;
        }
        if (this === writer && injected) cleanupReachedOwnedSession = true;
        return invokeEnd(end, this);
      }) as typeof end);
      try { value = await f.adapter.withSourceLock("control", async lock => { captured = lock; await ordinaryAnchor(f, lock); return "committed"; }); }
      catch (error) { rejected = true; rejection = error; }
      assert.ok(writer); assert.equal(commits, 1); assert.equal(rollbacks, 0, "an end failure after COMMIT must not trigger rollback or a retry");
      assert.equal(rejected, phase !== "success");
      if (phase === "success") assert.equal(value, "committed");
      else { assert.equal(injected, true); assert.equal(rejection, failure); }
      assert.ok(captured);
      assertOrdinaryOutcome(captured, { commitStarted: true, commitReturned: true, failureObserved: false,
        rollbackFailureObserved: false, closeFailureObserved: phase !== "success",
        closeError: phase === "success" ? undefined : failure }, phase !== "end-before");
      const actual = await independentlyRead(f);
      assert.equal(actual.maintenance[0].journal_record_ref, f.v.zeroRef.ref); assert.deepEqual(actual.clients, []);
      if (phase === "end-before") {
        await f.mutex.release(); await f.adapter.close();
        assert.equal(cleanupReachedOwnedSession, true, "adapter teardown must still own the session whose end was never confirmed");
      }
    } finally {
      child.mock.restoreAll();
      // Release only the exact client this fixture intercepted, never retry business SQL.
      if (writer) await invokeEnd(end, writer);
      await f.close();
    }
  });
});

pgTest("#152 PostgreSQL first callback failure survives rollback/end errors and keeps safe mapping", async t => {
  for (const scenario of ["ordinary", "ordinary-rollback", "ordinary-close", "ordinary-undefined", "mechanism", "undefined", "busy", "rollback-dispatch"] as const) await t.test(scenario, async child => {
    const f = await fixture(), before = await independentlyRead(f), query = Client.prototype.query, end = Client.prototype.end;
    const mechanism = scenario === "mechanism" || scenario === "undefined" || scenario === "rollback-dispatch";
    const primary = scenario === "undefined" || scenario === "ordinary-undefined" ? undefined : scenario === "busy" ? Object.assign(new Error("native-lock-not-available"), { code: "55P03" })
      : new MaintenanceFailure("phase_conflict", "callback-first");
    const rollbackFailure = Object.assign(new Error("ordinary-sensitive-rollback"), { privateDetail: "ordinary-sensitive-rollback" }),
      closeFailure = Object.assign(new Error("ordinary-sensitive-end"), { privateDetail: "ordinary-sensitive-end" });
    let writer: Client | undefined, captured: SourceLock | undefined, rollbackAttempted = false, rolledBack = false, ended = false;
    let rejected = false, rejection: unknown;
    try {
      child.mock.method(Client.prototype, "query", (function (this: Client, ...args: unknown[]) {
        const sql = sqlText(args[0]);
        if (database(this) === f.database && sql.startsWith(mechanism ? "UPDATE storage_maintenance SET owner_generation=" : "UPDATE storage_maintenance SET admission=")) writer = this;
        if (this === writer && sql === "ROLLBACK") {
          rollbackAttempted = true;
          // A dispatch failure occurs before a promise exists. The confirmed real
          // connection close below must release this still-open transaction.
          if (scenario === "rollback-dispatch") throw rollbackFailure;
        }
        return invokeQuery(query, this, args).then(result => {
          if (this === writer && sql === "ROLLBACK") { rolledBack = true; if (scenario !== "ordinary-close") throw rollbackFailure; }
          return result;
        });
      }) as typeof query);
      child.mock.method(Client.prototype, "end", (async function (this: Client) {
        await invokeEnd(end, this);
        if (this === writer) { ended = true; if (scenario !== "ordinary-rollback") throw closeFailure; }
      }) as typeof end);
      try {
        await f.adapter.withSourceLock("control", async lock => {
          captured = lock;
          if (mechanism) await applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef)); else await ordinaryAnchor(f, lock);
          throw primary;
        });
      } catch (error) { rejected = true; rejection = error; }
      assert.equal(rejected, true); assert.equal(rollbackAttempted, true);
      assert.equal(rolledBack, scenario !== "rollback-dispatch"); assert.equal(ended, true);
      if (scenario === "undefined" || scenario === "ordinary-undefined" || scenario === "busy") {
        assert.ok(rejection instanceof MaintenanceFailure); assert.equal(rejection.code, scenario === "busy" ? "maintenance_busy" : "snapshot_invalid");
      } else assert.equal(rejection, primary);
      assert.doesNotMatch(JSON.stringify(rejection), /ordinary-sensitive/);
      if (mechanism) {
        const outcome = controlSqlOutcome(captured!);
        assert.equal(outcome.status, "unknown"); assert.equal(outcome.failureObserved, true); assert.equal(outcome.originalError, primary);
        assert.equal(outcome.rollbackError, rollbackFailure); assert.equal(outcome.closeError, closeFailure);
      } else assertOrdinaryOutcome(captured!, { commitStarted: false, commitReturned: false, failureObserved: true,
        rollbackFailureObserved: scenario !== "ordinary-close", closeFailureObserved: scenario !== "ordinary-rollback",
        originalError: primary, rollbackError: scenario === "ordinary-close" ? undefined : rollbackFailure,
        closeError: scenario === "ordinary-rollback" ? undefined : closeFailure });
      assert.deepEqual(await independentlyRead(f), before, "another connection sees neither the rolled-back row nor anchor");
    } finally { child.mock.restoreAll(); if (writer) await invokeEnd(end, writer); await f.close(); }
  });
});

pgTest("#152 PostgreSQL COMMIT first failure is retained while an independent connection determines what committed", async t => {
  for (const mode of ["ordinary", "mechanism"] as const) for (const phase of ["before", "after"] as const) await t.test(mode + "-" + phase, async child => {
    const f = await fixture(), before = await independentlyRead(f), query = Client.prototype.query, end = Client.prototype.end;
    const primary = new MaintenanceFailure("snapshot_invalid", `commit-${phase}`), rollbackFailure = new Error("commit-rollback"), closeFailure = new Error("commit-end");
    let writer: Client | undefined, captured: SourceLock | undefined, commits = 0;
    try {
      child.mock.method(Client.prototype, "query", (async function (this: Client, ...args: unknown[]) {
        const sql = sqlText(args[0]);
        if (database(this) === f.database && sql.startsWith(mode === "mechanism" ? "UPDATE storage_maintenance SET owner_generation=" : "UPDATE storage_maintenance SET admission=")) writer = this;
        if (this === writer && sql === "COMMIT") { commits++; if (phase === "before") throw primary; }
        const result = await invokeQuery(query, this, args);
        if (this === writer && sql === "COMMIT") throw primary;
        if (this === writer && sql === "ROLLBACK") throw rollbackFailure;
        return result;
      }) as typeof query);
      child.mock.method(Client.prototype, "end", (async function (this: Client) {
        await invokeEnd(end, this); if (this === writer) throw closeFailure;
      }) as typeof end);
      await assert.rejects(f.adapter.withSourceLock("control", async lock => {
        captured = lock;
        if (mode === "mechanism") await applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef)); else await ordinaryAnchor(f, lock);
      }), error => error === primary);
      assert.equal(commits, 1);
      const outcome = controlSqlOutcome(captured!);
      if (mode === "mechanism") {
        assert.equal(outcome.status, "unknown"); assert.equal(outcome.originalError, primary);
        assert.equal(outcome.rollbackError, rollbackFailure); assert.equal(outcome.closeError, closeFailure);
      } else assertOrdinaryOutcome(captured!, { commitStarted: true, commitReturned: false, failureObserved: true,
        rollbackFailureObserved: true, closeFailureObserved: true,
        originalError: primary, rollbackError: rollbackFailure, closeError: closeFailure });
      const actual = await independentlyRead(f);
      if (phase === "before") assert.deepEqual(actual, before);
      else { assert.equal(actual.maintenance[0].journal_record_ref, mode === "mechanism" ? f.v.insertedRef.ref : f.v.zeroRef.ref);
        assert.equal(actual.clients.length, mode === "mechanism" ? 1 : 0); }
    } finally { child.mock.restoreAll(); if (writer) await invokeEnd(end, writer); await f.close(); }
  });
});
