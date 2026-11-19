import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { protocolSqliteAuditFixture as sqliteAuditFixture } from "./fixtures/maintenance-source-audit.ts";
import { controlSeedColumns, controlSqlVector } from "./fixtures/maintenance-control-sql.ts";
import { applyUntrustedControlSql, controlSqlOutcome, resolveUntrustedControlSql } from "../src/server/storage/maintenance/control-sql.ts";
import type { SourceLock } from "../src/server/storage/maintenance/types.ts";

async function fixture(encoding: "UTF-8" | "UTF-16le" | "UTF-16be" = "UTF-8") {
  const f = await sqliteAuditFixture(false, encoding);
  try {
    const v = controlSqlVector(await f.adapter.observeSourceClients(), f.store.identity, f.mutex.identity);
    const db = new Database(f.file), expected = v.reconstruct(v.capture).expectedMaintenance;
    try {
      const names = Object.keys(controlSeedColumns) as (keyof typeof controlSeedColumns)[];
      // Controlled fixture baseline only: no capture or qualification is claimed by these seed writes.
      db.prepare(`UPDATE storage_maintenance SET ${names.map(key => `${controlSeedColumns[key]}=?`).join(",")} WHERE singleton=1`).run(...names.map(key => expected[key]));
    } finally { db.close(); }
    return { ...f, v };
  } catch (error) { await f.close(); throw error; }
}

test("C3 SQLite ordinary locks preserve a literal undefined primary and both independent cleanup occurrences", async () => {
  const f = await sqliteAuditFixture(false), exec = Database.prototype.exec, close = Database.prototype.close;
  const cleanup = new Error("the same object thrown by two actual cleanup stages");
  const before = await f.adapter.observeSourceClients(); let captured: SourceLock | undefined, rejected = false;
  const stages: string[] = [];
  try { try {
    Database.prototype.exec = function(sql) {
      const result = exec.call(this, sql);
      if (this.name === f.file && !this.readonly && sql === "ROLLBACK") { stages.push("rollback"); throw cleanup; }
      return result;
    };
    Database.prototype.close = function() {
      const source = this.name === f.file && !this.readonly, result = close.call(this);
      if (source) { stages.push("source-close"); throw cleanup; } return result;
    };
    try { await f.adapter.withSourceLock("control", async lock => { captured = lock; throw undefined; }); }
    catch (error) { rejected = true; assert.equal(error, undefined); }
    assert(rejected); assert.deepEqual(stages, ["rollback", "source-close"]);
    const outcome = controlSqlOutcome(captured!);
    assert.equal(outcome.failureObserved, true); assert.equal(outcome.originalError, undefined);
    assert.equal(outcome.rollbackFailureObserved, true); assert.equal(outcome.rollbackError, cleanup);
    assert.equal(outcome.closeFailureObserved, true); assert.equal(outcome.closeError, cleanup);
    assert.equal(outcome.commitReturned, false); assert.equal(outcome.localSourceHandleClosed, true);
    assert.deepEqual(outcome.cleanupEvents, [
      { stage: "rollback-failure", error: cleanup }, { stage: "close-failure", error: cleanup },
    ], "one object does not collapse two actual native cleanup calls");
  } finally { Database.prototype.exec = exec; Database.prototype.close = close; }
    assert.deepEqual(await f.adapter.observeSourceClients(), before);
  } finally { await f.close(); }
});

test("C3 SQLite first seal and cancellation use complete fixed control transitions", async () => {
  const f = await fixture();
  try {
    const db = new Database(f.file);
    try { db.prepare("UPDATE storage_maintenance SET admission='draining',journal_record_ref=?,journal_digest=?,journal_sequence=1")
      .run(f.v.f.enterRef.ref, f.v.f.enterRef.sha256); }
    finally { db.close(); }
    const before = await f.adapter.observeSourceClients();
    await f.adapter.withSourceLock("control", lock => applyUntrustedControlSql(lock, f.v.input(f.v.capture)));
    const sealed = await f.adapter.observeSourceClients();
    assert.equal(sealed.state.admission, "sealed"); assert.equal(sealed.state.ownerGeneration, before.state.ownerGeneration);
    assert.deepEqual(sealed.rows, before.rows);
    await f.adapter.withSourceLock("control", lock => applyUntrustedControlSql(lock, f.v.input(f.v.zeroRef)));
    await f.adapter.withSourceLock("control", lock => applyUntrustedControlSql(lock, f.v.input(f.v.intentRef)));
    const pending = await f.adapter.observeSourceClients(); let terminalLock: SourceLock | undefined;
    await f.adapter.withSourceLock("control", async lock => { terminalLock = lock; return applyUntrustedControlSql(lock, f.v.input(f.v.terminalRef)); });
    const terminal = await f.adapter.observeSourceClients();
    assert.deepEqual(terminal, { ...pending, state: { ...pending.state, admission: "open", fenceEpoch: pending.state.fenceEpoch + 1,
      activeMigrationId: null, planDigest: null, journalRecordRef: f.v.terminalRef.ref, journalDigest: f.v.terminalRef.sha256, journalSequence: 5 } });
    assert.equal(controlSqlOutcome(terminalLock!).status, "source-transaction-completed");
  } finally { await f.close(); }
});

test("C3 SQLite unknown resolution cannot mistake a sibling of the attempted step for its successor", async () => {
  const f = await fixture(); let attempted: SourceLock | undefined;
  const primary = new Error("intentional rollback before the attempted registration commits");
  try {
    await assert.rejects(f.adapter.withSourceLock("control", async lock => {
      attempted = lock; await applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef)); throw primary;
    }), error => error === primary);
    await f.adapter.withSourceLock("control", lock => applyUntrustedControlSql(lock, f.v.input(f.v.zeroRef)));
    await f.mutex.release();
    assert.equal((await resolveUntrustedControlSql(f.adapter, attempted!, f.v.input(f.v.zeroRef))).classification, "unknown",
      "the current legal branch shares the before anchor but does not contain this attempted step");
  } finally { await f.close(); }
});

test("A12-C SQLite fixed INSERT and exact anchor share the real source transaction", async () => {
  const f = await fixture(); let captured: SourceLock | undefined;
  try {
    const local = await f.adapter.withSourceLock("control", async lock => {
      captured = lock;
      const view = await applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef));
      assert.equal(controlSqlOutcome(lock).status, "unknown", "transaction-local after is not committed");
      assert.equal(view.observation.rows.length, 1);
      assert.deepEqual(view.observation.rows[0], f.v.row);
      await assert.rejects(lock.readSourceClientAudit(f.reference), { code: "maintenance_lost" }, "write invalidates the old facts source");
      return view;
    });
    assert.equal(controlSqlOutcome(captured!).status, "source-transaction-completed");
    assert.deepEqual(await f.adapter.observeSourceClients(), local.observation);
    assert.equal(local.observation.state.journalRecordRef, f.v.insertedRef.ref);
  } finally { await f.close(); }
});

test("A12-C SQLite preserves UTF16 bytes through the fixed two-time UPDATE and zero-change takeover", async t => {
  for (const encoding of ["UTF-16le", "UTF-16be"] as const) await t.test(encoding, async () => {
    const f = await fixture(encoding);
    try {
      await f.adapter.withSourceLock("control", lock => applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef)));
      await f.adapter.withSourceLock("control", lock => applyUntrustedControlSql(lock, f.v.input(f.v.updatedRef)));
      await f.adapter.withSourceLock("control", lock => applyUntrustedControlSql(lock, f.v.input(f.v.endedRef)));
      const actual = await f.adapter.observeSourceClients();
      assert.deepEqual(actual.rows, [f.v.endedRow]); assert.equal(actual.textEncoding.name, encoding);
      for (const key of Object.keys(f.v.row) as (keyof typeof f.v.row)[]) if (!["last_observed_at", "ended_at"].includes(key)) assert.deepEqual(actual.rows[0]![key], f.v.row[key]);
    } finally { await f.close(); }
  });
  await t.test("no row change still advances only the derived anchor", async () => {
    const f = await fixture();
    try {
      const before = await f.adapter.observeSourceClients();
      await f.adapter.withSourceLock("control", lock => applyUntrustedControlSql(lock, f.v.input(f.v.zeroRef)));
      const after = await f.adapter.observeSourceClients();
      assert.deepEqual(after.rows, before.rows); assert.equal(after.state.ownerGeneration, 8);
      assert.equal(after.state.journalRecordRef, f.v.zeroRef.ref);
      for (const key of Object.keys(before.state) as (keyof typeof before.state)[])
        if (!["ownerGeneration", "journalRecordRef", "journalDigest", "journalSequence"].includes(key)) assert.deepEqual(after.state[key], before.state[key]);
    } finally { await f.close(); }
  });
});

test("A12-C SQLite failures before rows, after rows, after anchor and after validation roll back together", async t => {
  for (const phase of ["before-row", "after-row", "after-anchor", "after-mismatch", "constraint", "row-count", "swallowed", "row-and-close"] as const) await t.test(phase, async () => {
    const f = await fixture(), original = Database.prototype.prepare, close = Database.prototype.close;
    const failure = Object.assign(new Error(`controlled ${phase}`), { code: "EIO" });
    const closeFailure = Object.assign(new Error("separate close failure"), { code: "EPIPE" });
    let invoked = false, captured: SourceLock | undefined;
    const before = await f.adapter.observeSourceClients();
    try {
      if (phase === "row-and-close") Database.prototype.close = function () {
        const target = this.name === f.file && !this.readonly; const result = close.call(this);
        if (target) throw closeFailure; return result;
      };
      Database.prototype.prepare = function (this: Database.Database, sql: string) {
        const prepare = (text: string) => Reflect.apply(original, this, [text]) as Database.Statement<unknown[]>;
        const statement = prepare(sql);
        const insert = sql.startsWith("INSERT INTO storage_source_clients"), anchor = sql.startsWith("UPDATE storage_maintenance SET owner_generation=");
        if (this.name !== f.file || this.readonly || !(phase === "after-anchor" || phase === "after-mismatch" ? anchor : insert)) return statement;
        return new Proxy(statement, { get(target, key) {
          if (key !== "run") return Reflect.get(target, key, target);
          return (...args: unknown[]) => {
            invoked = true;
            if (phase === "before-row") throw failure;
            const result = target.run(...args);
            if (phase === "constraint") return target.run(...args); // Real duplicate primary-key failure in the same transaction.
            if (phase === "row-count") return { ...result, changes: 0 };
            if (phase === "after-mismatch") { prepare("UPDATE storage_source_clients SET build_id='changed after fixed write'").run(); return result; }
            throw failure;
          };
        } });
      } as typeof original;
      await assert.rejects(f.adapter.withSourceLock("control", async lock => {
        captured = lock;
        if (phase === "swallowed") { await assert.rejects(applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef)), error => error === failure); return; }
        return applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef));
      }));
      assert(invoked, "the intended real SQL stage was reached");
      assert.equal(controlSqlOutcome(captured!).status, "unknown");
      if (phase === "row-and-close") {
        assert.equal(controlSqlOutcome(captured!).originalError, failure); assert.equal(controlSqlOutcome(captured!).closeError, closeFailure);
      }
    } finally { Database.prototype.prepare = original; Database.prototype.close = close; }
    try {
      assert.deepEqual(await f.adapter.observeSourceClients(), before, "neither rows nor anchor partially commit");
      await f.mutex.release();
      assert.equal((await resolveUntrustedControlSql(f.adapter, captured!)).classification, "observed-uncommitted");
    } finally { await f.close(); }
  });
});

test("A12-C SQLite resolution requires the exact complete legal successor and refuses a larger damaged anchor", async () => {
  const f = await fixture(); let first: SourceLock | undefined;
  try {
    await f.adapter.withSourceLock("control", async lock => { first = lock; return applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef)); });
    await f.adapter.withSourceLock("control", lock => applyUntrustedControlSql(lock, f.v.input(f.v.updatedRef)));
    await f.mutex.release();
    assert.equal((await resolveUntrustedControlSql(f.adapter, first!)).classification, "unknown", "no full current chain supplied");
    assert.equal((await resolveUntrustedControlSql(f.adapter, first!, f.v.input(f.v.zeroRef))).classification, "unknown", "an available orphan is not the DB head");
    assert.equal((await resolveUntrustedControlSql(f.adapter, first!, f.v.input(f.v.updatedRef))).classification, "observed-legal-successor");
    const db = new Database(f.file);
    try { db.prepare("UPDATE storage_maintenance SET journal_sequence=99").run(); } finally { db.close(); }
    assert.equal((await resolveUntrustedControlSql(f.adapter, first!, f.v.input(f.v.updatedRef))).classification, "unknown");
  } finally { await f.close(); }
});

test("A12-C SQLite unknown COMMIT and close never imply rollback or allow unproven old-handle reuse", async t => {
  for (const phase of ["commit-before", "commit-after", "close-before", "close-after"] as const) await t.test(phase, async () => {
    const f = await fixture(), exec = Database.prototype.exec, close = Database.prototype.close;
    const failure = Object.assign(new Error(`controlled ${phase}`), { code: "EIO" });
    let invoked = false, captured: SourceLock | undefined, held: Database.Database | undefined;
    try {
      Database.prototype.exec = function (sql) {
        if (this.name === f.file && !this.readonly && sql === "COMMIT" && phase.startsWith("commit")) {
          invoked = true; if (phase === "commit-before") throw failure;
          exec.call(this, sql); throw failure;
        }
        return exec.call(this, sql);
      };
      Database.prototype.close = function () {
        if (this.name === f.file && !this.readonly && phase.startsWith("close")) {
          held = this; invoked = true; if (phase === "close-before") throw failure;
          close.call(this); throw failure;
        }
        return close.call(this);
      };
      await assert.rejects(f.adapter.withSourceLock("control", async lock => { captured = lock; return applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef)); }), error => error === failure);
      assert(invoked);
    } finally { Database.prototype.exec = exec; Database.prototype.close = close; }
    try {
      const outcome = controlSqlOutcome(captured!); assert.equal(outcome.status, "unknown");
      assert.equal(phase.startsWith("close") ? outcome.closeError : outcome.originalError, failure);
      let acquisitions = 0; const acquire = f.adapter.acquireMutex.bind(f.adapter);
      f.adapter.acquireMutex = async (...args) => { acquisitions++; return acquire(...args); };
      assert.equal((await resolveUntrustedControlSql(f.adapter, captured!)).classification, "unknown");
      assert.equal(acquisitions, 0, "no new critical section while the old mutex or source handle is still held");
      if (held?.open) close.call(held); // Owned test cleanup, no SQL retry.
      await f.mutex.release();
      const resolution = await resolveUntrustedControlSql(f.adapter, captured!);
      assert.equal(resolution.classification, phase === "commit-before" ? "observed-uncommitted" : "observed-committed");
      assert.equal(acquisitions, 1);
    } finally { if (held?.open) close.call(held); await f.close(); }
  });
});

test("A12-C SQLite full before/CAS mismatch and malformed changes cannot write", async () => {
  const f = await fixture();
  try {
    const db = new Database(f.file);
    try { db.prepare("UPDATE storage_maintenance SET owner_generation=8").run(); } finally { db.close(); }
    const before = await f.adapter.observeSourceClients();
    await assert.rejects(f.adapter.withSourceLock("control", lock => applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef))), { code: "source_changed" });
    assert.deepEqual(await f.adapter.observeSourceClients(), before);
    const bad = structuredClone(f.v.inserted) as any;
    bad.controlProof.changes[0].extraColumn = "forbidden";
    const badHead = f.v.f.pack("journal", bad);
    await assert.rejects(f.adapter.withSourceLock("control", lock => applyUntrustedControlSql(lock, f.v.input(badHead))), { code: "journal_invalid" });
    assert.deepEqual(await f.adapter.observeSourceClients(), before);
  } finally { await f.close(); }
});

test("A12-C SQLite a close rejection with undefined is still unknown", async () => {
  const f = await fixture(), close = Database.prototype.close; let captured: SourceLock | undefined, rejected = false;
  try {
    Database.prototype.close = function () {
      const target = this.name === f.file && !this.readonly; const result = close.call(this);
      if (target) throw undefined;
      return result;
    };
    try { await f.adapter.withSourceLock("control", async lock => { captured = lock; return applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef)); }); }
    catch (error) { rejected = true; assert.equal(error, undefined); }
    assert(rejected);
    assert.equal(controlSqlOutcome(captured!).status, "unknown");
    assert.equal(controlSqlOutcome(captured!).closeFailureObserved, true);
    assert.equal(controlSqlOutcome(captured!).closeError, undefined);
  } finally { Database.prototype.close = close; await f.close(); }
});


test("A12-C SQLite final boundary rejects a swallowed extra anchor but retains ordinary anchor behavior", async () => {
  for (const mechanism of [true, false]) {
    const f = await fixture(); let captured: SourceLock | undefined, anchorRejected = false;
    const before = await f.adapter.observeSourceClients();
    try {
      const work = f.adapter.withSourceLock("control", async lock => {
        captured = lock;
        const state = mechanism ? (await applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef))).observation.state : before.state;
        const anchor = lock.anchor({ expected: state, admission: state.admission, fenceEpoch: state.fenceEpoch,
          ownerGeneration: mechanism ? state.ownerGeneration : state.ownerGeneration + 1,
          activeMigrationId: state.activeMigrationId, planDigest: state.planDigest, controlRootIdentity: f.store.identity as never,
          mutexIdentity: f.mutex.identity, journal: mechanism ? f.v.updatedRef : f.v.zeroRef, journalSequence: state.journalSequence + 1 });
        if (mechanism) { try { await anchor; } catch { anchorRejected = true; } } else await anchor;
      });
      if (mechanism) { await assert.rejects(work); assert(anchorRejected); assert.deepEqual(await f.adapter.observeSourceClients(), before); assert.equal(controlSqlOutcome(captured!).status, "unknown"); }
      else { await work; assert.equal((await f.adapter.observeSourceClients()).state.journalRecordRef, f.v.zeroRef.ref); }
    } finally { await f.close(); }
  }
});

test("A12-C SQLite final boundary rereads complete rows, maintenance and schema after the callback", async t => {
  for (const drift of ["raw-row", "maintenance", "schema"] as const) await t.test(drift, async () => {
    const f = await fixture(), prepare = Database.prototype.prepare; let writer: Database.Database | undefined;
    const before = await f.adapter.observeSourceClients();
    try {
      Database.prototype.prepare = function (this: Database.Database, sql: string) {
        if (this.name === f.file && !this.readonly && sql.startsWith("INSERT INTO storage_source_clients")) writer = this;
        return Reflect.apply(prepare, this, [sql]);
      } as typeof prepare;
      await assert.rejects(f.adapter.withSourceLock("control", async lock => {
        await applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef)); assert(writer?.inTransaction);
        // A controlled internal late writer, on the actual owned transaction; never an exposed product handle.
        writer.exec(drift === "raw-row" ? "UPDATE storage_source_clients SET build_id='late raw drift'"
          : drift === "maintenance" ? "UPDATE storage_maintenance SET database_instance_id='late maintenance drift'"
          : "CREATE INDEX late_control_index ON storage_source_clients(build_id)");
      }));
      assert.deepEqual(await f.adapter.observeSourceClients(), before);
    } finally { Database.prototype.prepare = prepare; await f.close(); }
  });
});

test("A12-C SQLite unfinished calls retire inside the old transaction before rollback", async () => {
  const f = await fixture(); let pending: Promise<unknown> | undefined, captured: SourceLock | undefined;
  const failure = new Error("callback failed while the fixed mechanism was still running"), before = await f.adapter.observeSourceClients();
  try {
    await assert.rejects(f.adapter.withSourceLock("control", async lock => {
      captured = lock; pending = applyUntrustedControlSql(lock, f.v.input(f.v.insertedRef)).catch(error => error);
      throw failure;
    }), error => error === failure);
    await pending;
    assert.deepEqual(await f.adapter.observeSourceClients(), before);
    assert.equal(controlSqlOutcome(captured!).originalError, failure);
    await assert.rejects(applyUntrustedControlSql(captured!, f.v.input(f.v.insertedRef)));
  } finally { await f.close(); }
});


test("A12-C SQLite preserves facts-close retirement without retiring pure-mechanism factories", async t => {
  for (const factsUsed of [true, false]) await t.test(`factsUsed=${factsUsed}`, async () => {
    const f = await sqliteAuditFixture(false), close = Database.prototype.close;
    const failure = Object.assign(new Error("actual source close completed then EIO"), { code: "EIO" });
    let captured: SourceLock | undefined, injected = false;
    try {
      const initial = await f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference));
      const v = controlSqlVector(await f.adapter.observeSourceClients(), f.store.identity, f.mutex.identity);
      const db = new Database(f.file), originalState = db.prepare("SELECT * FROM storage_maintenance").get() as Record<string, unknown>;
      try {
        const expected = v.reconstruct(v.capture).expectedMaintenance, keys = Object.keys(controlSeedColumns) as (keyof typeof controlSeedColumns)[];
        db.prepare(`UPDATE storage_maintenance SET ${keys.map(key => `${controlSeedColumns[key]}=?`).join(",")} WHERE singleton=1`).run(...keys.map(key => expected[key]));
      } finally { db.close(); }
      Database.prototype.close = function () {
        const target = this.name === f.file && !this.readonly && !injected; const result = close.call(this);
        if (target) { injected = true; throw failure; } return result;
      };
      await assert.rejects(f.adapter.withSourceLock("control", async lock => {
        captured = lock;
        if (factsUsed) await assert.rejects(lock.withSourceClientFacts(f.reference, async () => {}), { code: "plan_stale" });
        return applyUntrustedControlSql(lock, v.input(v.zeroRef));
      }), error => error === failure);
      Database.prototype.close = close; assert(injected);
      assert.equal(controlSqlOutcome(captured!).closeError, failure); assert.equal(controlSqlOutcome(captured!).status, "unknown");
      const restore = new Database(f.file);
      try { const keys = Object.keys(originalState); restore.prepare(`UPDATE storage_maintenance SET ${keys.map(key => `${key}=?`).join(",")} WHERE singleton=1`).run(...keys.map(key => originalState[key])); }
      finally { restore.close(); }
      await f.mutex.assertHeld(); // Original SQLite failure retires this factory, not an unrelated domain lease.
      const next = f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference));
      if (factsUsed) await assert.rejects(next, { code: "maintenance_lost" });
      else assert.equal((await next).facts.actor.actorId, initial.facts.actor.actorId);
    } finally { Database.prototype.close = close; await f.close(); }
  });
});
