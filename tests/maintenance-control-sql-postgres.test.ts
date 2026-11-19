import test from "node:test";
import assert from "node:assert/strict";
import { Client, type QueryResult } from "pg";
import { protocolPostgresAuditFixture as postgresAuditFixture } from "./fixtures/maintenance-source-audit-postgres.ts";
import { controlSeedColumns, controlSqlVector } from "./fixtures/maintenance-control-sql.ts";
import { applyUntrustedControlSql, controlSqlOutcome, resolveUntrustedControlSql } from "../src/server/storage/maintenance/control-sql.ts";
import { createPostgresMaintenanceAdapter } from "../src/server/storage/maintenance/postgres.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import type { SourceLock } from "../src/server/storage/maintenance/types.ts";
const pgTest = process.env.AGENT_STUDIO_PG_TEST_URL ? test : test.skip;
const invokeQuery = (query: typeof Client.prototype.query, client: Client, args: unknown[]) => Reflect.apply(query, client, args) as Promise<QueryResult>;
const invokeEnd = (end: typeof Client.prototype.end, client: Client) => Reflect.apply(end, client, []) as Promise<void>;

async function fixture(encoding: "UTF8" | "LATIN1" = "UTF8") {
  const f = await postgresAuditFixture(encoding);
  try {
    const v = controlSqlVector(await f.adapter.observeSourceClients(), f.store.identity, f.mutex.identity);
    const db = await f.connect(), expected = v.reconstruct(v.capture).expectedMaintenance;
    try {
      // Controlled empty R0 and maintenance seed, not a registered factory or real capture.
      await db.query("DELETE FROM storage_source_clients");
      const names = Object.keys(controlSeedColumns) as (keyof typeof controlSeedColumns)[];
      await db.query(`UPDATE storage_maintenance SET ${names.map((key, index) => `${controlSeedColumns[key]}=$${index + 1}`).join(",")} WHERE singleton=1`, names.map(key => expected[key]));
    } finally { await f.closeClient(db); }
    return { ...f, v };
  } catch (error) { await f.close(); throw error; }
}
const sqlText = (value: unknown) => typeof value === "string" ? value : typeof value === "object" && value !== null && "text" in value ? String(value.text) : "";
const database = (client: Client) => (client as unknown as { connectionParameters: { database: string } }).connectionParameters.database;

pgTest("C3 PostgreSQL first seal and terminal atomically compare every control column", async () => {
  const f = await fixture(), client = await f.connect("c3-fixed-transition-reader");
  try {
    await client.query("UPDATE storage_maintenance SET admission='draining',journal_record_ref=$1,journal_digest=$2,journal_sequence=1",
      [f.v.f.enterRef.ref, f.v.f.enterRef.sha256]);
    await f.adapter.withSourceLock("control", lock => applyUntrustedControlSql(lock, f.v.input(f.v.capture)));
    await f.adapter.withSourceLock("control", lock => applyUntrustedControlSql(lock, f.v.input(f.v.zeroRef)));
    await f.adapter.withSourceLock("control", lock => applyUntrustedControlSql(lock, f.v.input(f.v.intentRef)));
    const pending = await f.adapter.observeSourceClients();
    await f.adapter.withSourceLock("control", async lock => {
      await applyUntrustedControlSql(lock, f.v.input(f.v.terminalRef));
      const outside = (await client.query("SELECT admission,fence_epoch::text,active_migration_id,plan_digest,journal_record_ref FROM storage_maintenance")).rows[0];
      assert.deepEqual(outside, { admission: "sealed", fence_epoch: String(pending.state.fenceEpoch),
        active_migration_id: pending.state.activeMigrationId, plan_digest: pending.state.planDigest, journal_record_ref: pending.state.journalRecordRef });
    });
    const terminal = await f.adapter.observeSourceClients();
    assert.deepEqual(terminal, { ...pending, state: { ...pending.state, admission: "open", fenceEpoch: pending.state.fenceEpoch + 1,
      activeMigrationId: null, planDigest: null, journalRecordRef: f.v.terminalRef.ref, journalDigest: f.v.terminalRef.sha256, journalSequence: 5 } });
  } finally { await f.closeClient(client); await f.close(); }
});

pgTest("C3 PostgreSQL resolution rejects a sibling lacking the exact attempted step", async () => {
  const f = await fixture(); let attempted: SourceLock | undefined;
  try {
    await assert.rejects(f.adapter.withSourceLock("control", async lock => {
      attempted = lock; await applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef)); throw new Error("controlled rollback");
    }));
    await f.adapter.withSourceLock("control", lock => applyUntrustedControlSql(lock, f.v.input(f.v.zeroRef)));
    await f.mutex.release();
    assert.equal((await resolveUntrustedControlSql(f.adapter, attempted!, f.v.input(f.v.zeroRef))).classification, "unknown");
  } finally { await f.close(); }
});

pgTest("A12-C PostgreSQL full row and anchor commit atomically while an independent reader sees the old view", async () => {
  const f = await fixture(), query = Client.prototype.query, outside = await f.connect("mechanism-independent-reader");
  let captured: SourceLock | undefined, sampled = false;
  try {
    Client.prototype.query = async function (this: Client, ...args: unknown[]) {
      const value = await invokeQuery(query, this, args);
      if (database(this) === f.database && sqlText(args[0]).startsWith("INSERT INTO storage_source_clients")) {
        const old = await outside.query("SELECT (SELECT count(*)::text FROM storage_source_clients) AS count,journal_record_ref FROM storage_maintenance");
        assert.equal(old.rows[0].count, "0"); assert.equal(old.rows[0].journal_record_ref, f.v.capture.ref); sampled = true;
      }
      return value;
    } as typeof query;
    const view = await f.adapter.withSourceLock("control", async lock => {
      captured = lock; const value = await applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef));
      assert.equal(controlSqlOutcome(lock).status, "unknown");
      await assert.rejects(lock.readSourceClientAudit(f.reference), { code: "maintenance_lost" });
      return value;
    });
    assert(sampled, "actual independent snapshot taken after the in-transaction INSERT");
    assert.equal(controlSqlOutcome(captured!).status, "source-transaction-completed");
    assert.deepEqual(await f.adapter.observeSourceClients(), view.observation);
    const committed = await outside.query("SELECT (SELECT count(*)::text FROM storage_source_clients) AS count,journal_record_ref FROM storage_maintenance");
    assert.equal(committed.rows[0].count, "1"); assert.equal(committed.rows[0].journal_record_ref, f.v.insertedRef.ref);
  } finally { Client.prototype.query = query; await f.closeClient(outside); await f.close(); }
});

pgTest("A12-C PostgreSQL fixed updates preserve complete LATIN1 rows and empty takeover advances only four columns", async () => {
  const f = await fixture("LATIN1");
  try {
    await f.adapter.withSourceLock("control", lock => applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef)));
    await f.adapter.withSourceLock("control", lock => applyUntrustedControlSql(lock, f.v.input(f.v.updatedRef)));
    await f.adapter.withSourceLock("control", lock => applyUntrustedControlSql(lock, f.v.input(f.v.endedRef)));
    assert.deepEqual((await f.adapter.observeSourceClients()).rows, [f.v.endedRow]);
  } finally { await f.close(); }
  const g = await fixture();
  try {
    const before = await g.adapter.observeSourceClients();
    await g.adapter.withSourceLock("control", lock => applyUntrustedControlSql(lock, g.v.input(g.v.zeroRef)));
    const after = await g.adapter.observeSourceClients();
    assert.deepEqual(after.rows, before.rows); assert.equal(after.state.ownerGeneration, 8);
    for (const key of Object.keys(before.state) as (keyof typeof before.state)[])
      if (!["ownerGeneration", "journalRecordRef", "journalDigest", "journalSequence"].includes(key)) assert.deepEqual(after.state[key], before.state[key]);
  } finally { await g.close(); }
});

pgTest("A12-C PostgreSQL row, constraint, anchor and after failures cannot leave a half commit", async t => {
  for (const phase of ["before-row", "after-row", "constraint", "row-count", "after-anchor", "after-mismatch", "swallowed", "row-and-close"] as const) await t.test(phase, async () => {
    const f = await fixture(), query = Client.prototype.query, end = Client.prototype.end, before = await f.adapter.observeSourceClients();
    const failure = Object.assign(new Error(`controlled ${phase}`), { code: "EIO" });
    const closeFailure = Object.assign(new Error("separate close failure"), { code: "EPIPE" });
    let invoked = false, captured: SourceLock | undefined, writer: Client | undefined;
    try {
      if (phase === "row-and-close") Client.prototype.end = async function (this: Client) { await invokeEnd(end, this); if (this === writer) throw closeFailure; } as typeof end;
      Client.prototype.query = async function (this: Client, ...args: unknown[]) {
        const sql = sqlText(args[0]), insert = sql.startsWith("INSERT INTO storage_source_clients"), anchor = sql.startsWith("UPDATE storage_maintenance SET owner_generation=");
        if (database(this) !== f.database || !(phase === "after-anchor" || phase === "after-mismatch" ? anchor : insert)) return invokeQuery(query, this, args);
        invoked = true; writer = this;
        if (phase === "before-row") throw failure;
        const result = await invokeQuery(query, this, args);
        if (phase === "constraint") return invokeQuery(query, this, args); // Real SQL duplicate key aborts this actual transaction.
        if (phase === "row-count") return { ...result, rowCount: 0 };
        if (phase === "after-mismatch") { await invokeQuery(query, this, ["UPDATE storage_source_clients SET build_id='changed after fixed write'"]); return result; }
        throw failure;
      } as typeof query;
      await assert.rejects(f.adapter.withSourceLock("control", async lock => {
        captured = lock;
        if (phase === "swallowed") { await assert.rejects(applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef)), error => error === failure); return; }
        return applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef));
      }));
      assert(invoked); assert.equal(controlSqlOutcome(captured!).status, "unknown");
      if (phase === "row-and-close") {
        assert.equal(controlSqlOutcome(captured!).originalError, failure); assert.equal(controlSqlOutcome(captured!).closeError, closeFailure);
      }
    } finally { Client.prototype.query = query; Client.prototype.end = end; }
    try {
      assert.deepEqual(await f.adapter.observeSourceClients(), before);
      await f.mutex.release();
      assert.equal((await resolveUntrustedControlSql(f.adapter, captured!)).classification, "observed-uncommitted");
    } finally { await f.close(); }
  });
});

pgTest("A12-C PostgreSQL exact successor classification cannot be replaced with an orphan or a larger sequence", async t => {
  const f = await fixture(); let first: SourceLock | undefined;
  try {
    await f.adapter.withSourceLock("control", async lock => { first = lock; return applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef)); });
    await f.adapter.withSourceLock("control", lock => applyUntrustedControlSql(lock, f.v.input(f.v.updatedRef)));
    await f.mutex.release();
    assert.equal((await resolveUntrustedControlSql(f.adapter, first!)).classification, "unknown");
    assert.equal((await resolveUntrustedControlSql(f.adapter, first!, f.v.input(f.v.zeroRef))).classification, "unknown");
    const resolution = await resolveUntrustedControlSql(f.adapter, first!, f.v.input(f.v.updatedRef));
    if (resolution.classification !== "observed-legal-successor") {
      try {
        const error = "error" in resolution ? resolution.error : undefined;
        const outcome = controlSqlOutcome(first!);
        const oldLock: Record<string, boolean | null> = {};
        for (const key of ["localSourceHandleClosed", "localMutexHandleClosed", "afterValidated", "finalValidated", "commitStarted", "commitReturned",
          "failureObserved", "rollbackFailureObserved", "closeFailureObserved"] as const) oldLock[key] = typeof outcome[key] === "boolean" ? outcome[key]! : null;
        const diagnostic = JSON.stringify({ phase: "legal-successor", classification: resolution.classification,
          reason: "reason" in resolution && ["old-local-handle-exit-unproven", "fresh-observation-or-close-unproven"].includes(resolution.reason) ? resolution.reason : null,
          errorPresent: "error" in resolution,
          errorKind: error instanceof MaintenanceFailure ? "MaintenanceFailure" : error === null ? "null" : typeof error,
          errorCode: error instanceof MaintenanceFailure && /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : null,
          oldLock });
        if (Buffer.byteLength(diagnostic) <= 2048) t.diagnostic(diagnostic);
      } catch { /* Observation must never replace the original classification assertion. */ }
    }
    assert.equal(resolution.classification, "observed-legal-successor");
    const changed = await f.connect();
    try { await changed.query("UPDATE storage_maintenance SET journal_sequence=99"); } finally { await f.closeClient(changed); }
    assert.equal((await resolveUntrustedControlSql(f.adapter, first!, f.v.input(f.v.updatedRef))).classification, "unknown");
  } finally { await f.close(); }
});

pgTest("A12-C PostgreSQL unknown COMMIT or close retains original outcomes until real new locks observe exact state", async t => {
  for (const phase of ["commit-before", "commit-after", "close-before", "close-after"] as const) await t.test(phase, async () => {
    const f = await fixture(), query = Client.prototype.query, end = Client.prototype.end;
    const failure = Object.assign(new Error(`controlled ${phase}`), { code: "EIO" });
    let captured: SourceLock | undefined, writer: Client | undefined, invoked = false;
    try {
      Client.prototype.query = async function (this: Client, ...args: unknown[]) {
        const sql = sqlText(args[0]);
        if (database(this) === f.database && sql.startsWith("INSERT INTO storage_source_clients")) writer = this;
        if (this === writer && sql === "COMMIT" && phase.startsWith("commit")) {
          invoked = true; if (phase === "commit-before") throw failure;
          await invokeQuery(query, this, args); throw failure;
        }
        return invokeQuery(query, this, args);
      } as typeof query;
      Client.prototype.end = async function (this: Client) {
        if (this === writer && phase.startsWith("close")) {
          invoked = true; if (phase === "close-before") throw failure;
          await invokeEnd(end, this); throw failure;
        }
        return invokeEnd(end, this);
      } as typeof end;
      await assert.rejects(f.adapter.withSourceLock("control", async lock => { captured = lock; return applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef)); }));
      assert(invoked);
    } finally { Client.prototype.query = query; Client.prototype.end = end; }
    try {
      const outcome = controlSqlOutcome(captured!); assert.equal(outcome.status, "unknown");
      assert.equal(phase.startsWith("close") ? outcome.closeError : outcome.originalError, failure);
      assert.equal((await resolveUntrustedControlSql(f.adapter, captured!)).classification, "unknown", "old mutex still held");
      if (phase === "close-before") await invokeEnd(end, writer!); // Owned native cleanup; never retry SQL.
      await f.mutex.release();
      const fresh = await createPostgresMaintenanceAdapter(f.descriptor, undefined);
      try { assert.equal((await resolveUntrustedControlSql(fresh, captured!)).classification, phase === "commit-before" ? "observed-uncommitted" : "observed-committed"); }
      finally { await fresh.close(); }
    } finally { await f.close(); }
  });
});

pgTest("A12-C PostgreSQL local close is insufficient while a real server source lock blocks the fresh domain", async () => {
  const f = await fixture(); let captured: SourceLock | undefined;
  try {
    await f.adapter.withSourceLock("control", async lock => { captured = lock; return applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef)); });
    await f.mutex.release();
    const held = await f.connect("mechanism-server-lock-control");
    try {
      await held.query("BEGIN"); await held.query("LOCK TABLE storage_maintenance IN SHARE ROW EXCLUSIVE MODE NOWAIT");
      const fresh = await createPostgresMaintenanceAdapter(f.descriptor, undefined);
      try { assert.equal((await resolveUntrustedControlSql(fresh, captured!)).classification, "unknown"); }
      finally { await fresh.close(); }
      await held.query("ROLLBACK");
    } finally { await f.closeClient(held); }
  } finally { await f.close(); }
});


pgTest("A12-C PostgreSQL final boundary rejects swallowed extra anchors and late raw writes", async t => {
  for (const drift of ["anchor", "raw-row", "ordinary-anchor"] as const) await t.test(drift, async () => {
    const f = await fixture(), query = Client.prototype.query; let writer: Client | undefined, anchorRejected = false;
    const before = await f.adapter.observeSourceClients();
    try {
      Client.prototype.query = async function (this: Client, ...args: unknown[]) {
        if (database(this) === f.database && sqlText(args[0]).startsWith("INSERT INTO storage_source_clients")) writer = this;
        return invokeQuery(query, this, args);
      } as typeof query;
      const work = f.adapter.withSourceLock("control", async lock => {
        const state = drift === "ordinary-anchor" ? before.state : (await applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef))).observation.state;
        if (drift === "raw-row") { assert(writer); await invokeQuery(query, writer, ["UPDATE storage_source_clients SET build_id='late raw drift'"]); return; }
        const anchor = lock.anchor({ expected: state, admission: state.admission, fenceEpoch: state.fenceEpoch,
          ownerGeneration: drift === "ordinary-anchor" ? state.ownerGeneration + 1 : state.ownerGeneration,
          activeMigrationId: state.activeMigrationId, planDigest: state.planDigest, controlRootIdentity: f.store.identity as never,
          mutexIdentity: f.mutex.identity, journal: drift === "ordinary-anchor" ? f.v.zeroRef : f.v.updatedRef, journalSequence: state.journalSequence + 1 });
        if (drift === "anchor") { try { await anchor; } catch { anchorRejected = true; } } else await anchor;
      });
      if (drift === "ordinary-anchor") { await work; assert.equal((await f.adapter.observeSourceClients()).state.journalRecordRef, f.v.zeroRef.ref); }
      else { await assert.rejects(work); if (drift === "anchor") assert(anchorRejected); assert.deepEqual(await f.adapter.observeSourceClients(), before); }
    } finally { Client.prototype.query = query; await f.close(); }
  });
});

pgTest("A12-C PostgreSQL unfinished calls retire before callback failure rollback", async () => {
  const f = await fixture(); let pending: Promise<unknown> | undefined, captured: SourceLock | undefined;
  const failure = new Error("callback stopped before mechanism completion"), before = await f.adapter.observeSourceClients();
  try {
    await assert.rejects(f.adapter.withSourceLock("control", async lock => {
      captured = lock; pending = applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef)).catch(error => error);
      throw failure;
    }));
    await pending; assert.deepEqual(await f.adapter.observeSourceClients(), before);
    assert.equal(controlSqlOutcome(captured!).originalError, failure);
    await assert.rejects(applyUntrustedControlSql(captured!, f.v.input(f.v.insertedRef)));
  } finally { await f.close(); }
});


pgTest("A12-C PostgreSQL preserves facts-close retirement without retiring pure-mechanism factories", async t => {
  for (const factsUsed of [true, false]) await t.test(`factsUsed=${factsUsed}`, async t => {
    const f = await postgresAuditFixture(), query = Client.prototype.query, end = Client.prototype.end;
    const failure = Object.assign(new Error("actual source end completed then EIO"), { code: "EIO" });
    let writer: Client | undefined, captured: SourceLock | undefined, injected = false;
    try {
      const initial = await f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference));
      const v = controlSqlVector(await f.adapter.observeSourceClients(), f.store.identity, f.mutex.identity);
      const db = await f.connect(); let originalState: Record<string, unknown>, originalRows: Record<string, unknown>[];
      try {
        originalState = (await db.query("SELECT * FROM storage_maintenance")).rows[0];
        originalRows = (await db.query("SELECT * FROM storage_source_clients")).rows;
        const expected = v.reconstruct(v.capture).expectedMaintenance, keys = Object.keys(controlSeedColumns) as (keyof typeof controlSeedColumns)[];
        await db.query("DELETE FROM storage_source_clients");
        await db.query(`UPDATE storage_maintenance SET ${keys.map((key, index) => `${controlSeedColumns[key]}=$${index + 1}`).join(",")} WHERE singleton=1`, keys.map(key => expected[key]));
      } finally { await f.closeClient(db); }
      Client.prototype.query = async function (this: Client, ...args: unknown[]) {
        if (database(this) === f.database && sqlText(args[0]).startsWith("UPDATE storage_maintenance SET owner_generation=")) writer = this;
        return invokeQuery(query, this, args);
      } as typeof query;
      Client.prototype.end = async function (this: Client) {
        await invokeEnd(end, this);
        if (this === writer && !injected) { injected = true; throw failure; }
      } as typeof end;
      await assert.rejects(f.adapter.withSourceLock("control", async lock => {
        captured = lock;
        if (factsUsed) await assert.rejects(lock.withSourceClientFacts(f.reference, async () => {}), { code: "plan_stale" });
        return applyUntrustedControlSql(lock, v.input(v.zeroRef));
      }), error => error === failure);
      Client.prototype.query = query; Client.prototype.end = end; assert(injected);
      assert.equal(controlSqlOutcome(captured!).closeError, failure); assert.equal(controlSqlOutcome(captured!).status, "unknown");
      const restore = await f.connect();
      try {
        const keys = Object.keys(originalState!);
        await restore.query(`UPDATE storage_maintenance SET ${keys.map((key, index) => `${key}=$${index + 1}`).join(",")} WHERE singleton=1`, keys.map(key => originalState![key]));
        for (const row of originalRows!) { const fields = Object.keys(row); await restore.query(`INSERT INTO storage_source_clients (${fields.join(",")}) VALUES (${fields.map((_, index) => `$${index + 1}`).join(",")})`, fields.map(key => row[key])); }
      } finally { await f.closeClient(restore); }
      const next = f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference));
      if (factsUsed) { await assert.rejects(next, { code: "maintenance_lost" }); await assert.rejects(f.mutex.assertHeld(), { code: "maintenance_lost" }); }
      else { assert.equal((await next).facts.actor.actorId, initial.facts.actor.actorId); await f.mutex.assertHeld(); }
      // The facts-close injection invalidates the adapter. Its natural heartbeat
      // may already retain that expected loss; release must preserve it while
      // still closing the native mutex. Pure-mechanism and other close errors fail.
      let releaseOutcome = "released";
      try { await f.mutex.release(); }
      catch (error) {
        if (!factsUsed) throw error;
        assert(error instanceof MaintenanceFailure);
        assert.equal(error.code, "maintenance_lost");
        assert.equal(error.message, new MaintenanceFailure("maintenance_lost").message);
        releaseOutcome = "expected-monitor-loss";
      }
      t.diagnostic(`factsUsed=${factsUsed}; source-end injection confirmed; mutex release: ${releaseOutcome}`);
      if (factsUsed) await assert.rejects(f.adapter.observe(), { code: "maintenance_lost" });
    } finally { Client.prototype.query = query; Client.prototype.end = end; await f.close(); }
  });
});
