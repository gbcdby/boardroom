import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { Client } from "pg";
import { stageSnapshotReady } from "../src/server/storage/maintenance/snapshot-ready.ts";
import { assertFrozenSourceUnchanged, verifySnapshotClosure } from "../src/server/storage/maintenance/journal.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { parseVerification } from "../src/server/storage/maintenance/parse.ts";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { buildDatabaseManifests } from "../src/server/storage/maintenance/manifests.ts";
import { controlSqlOutcome } from "../src/server/storage/maintenance/control-sql.ts";
import { snapshotReadyFixture } from "./fixtures/maintenance-snapshot-ready.ts";
import type { ArtifactRef, SourceLock, SourceObservation } from "../src/server/storage/maintenance/types.ts";

const nativeTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;
const pgTest = process.env.AGENT_STUDIO_PG_TEST_URL ? test : test.skip;
const artifacts = async (root: string) => (await readdir(root, { recursive: true })).sort();
function inconsistentClientTable(observed: SourceObservation): SourceObservation {
  const manifests = observed.manifests;
  return { ...observed, manifests: buildDatabaseManifests(manifests.dialect, manifests.schema,
    manifests.tables.map(table => table.name === "storage_source_clients" ? { ...table, digest: "f".repeat(64) } : table), manifests.controlRows) };
}

for (const kind of ["sqlite", "postgres"] as const) for (const point of ["after-CAS", "ready-retry"] as const)
  (kind === "sqlite" ? nativeTest : pgTest)(`#245 R ${kind}: complete source-client table binding at ${point}`, async () => {
    const f = await snapshotReadyFixture(kind);
    try {
      const input = await f.prepare();
      if (point === "ready-retry") await f.run(lock => stageSnapshotReady(f.store, lock, f.mutex, input, f.request));
      const before = (await f.observe()).state;
      let anchored = false, changed = false;
      // An inconsistent returned native table is the only fault. No archive or source row is rewritten.
      await assert.rejects(f.run(lock => stageSnapshotReady(f.store, { ...lock,
        anchor: async value => { await lock.anchor(value); anchored = true; },
        observe: async () => {
          const observed = await lock.observe();
          if (point === "ready-retry" || anchored) { changed = true; return inconsistentClientTable(observed); }
          return observed;
        },
      }, f.mutex, input, f.request)), error => error instanceof MaintenanceFailure && error.code === "source_changed");
      assert.equal(changed, true); assert.equal(anchored, point === "after-CAS");
      assert.deepEqual((await f.observe()).state, before, "failed staging rolls back; a rejected retry leaves the committed anchor alone");
    } finally { await f.close(); }
  });

for (const kind of ["sqlite", "postgres"] as const) (kind === "sqlite" ? nativeTest : pgTest)(
  `#152 R ${kind}: actual D/V then durable R/Jr and native CAS commit; exact retry is read-only`, async t => {
    const f = await snapshotReadyFixture(kind);
    let input!: { bundle: ArtifactRef; publication: ArtifactRef; verification: ArtifactRef };
    try {
      const windows: string[] = [], withSourceLock = f.adapter.withSourceLock.bind(f.adapter);
      t.mock.method(f.adapter, "withSourceLock", <T>(mode: "control" | "snapshot", consume: (lock: SourceLock) => Promise<T>): Promise<T> => {
        windows.push(mode); return withSourceLock(mode, consume);
      });
      input = await f.prepare();
      const snapshotLock = f.snapshotLock; assert(snapshotLock);
      await assert.rejects(snapshotLock.assertHeld(), { code: "maintenance_lost" });
      const staged = await f.run(async lock => {
        assert.notStrictEqual(lock, snapshotLock, "the R/Jr callback borrows a new actual native lock");
        const result = await stageSnapshotReady(f.store, lock, f.mutex, input, f.request);
        assert.deepEqual(Object.keys(result).sort(), ["journal", "receipt", "ref"]);
        const closure = await verifySnapshotClosure(f.store, result.journal);
        assert.deepEqual(closure.receiptRef, result.receipt);
        assert.deepEqual(closure.receipt.capture.journal, f.capture.reference);
        assert.deepEqual(closure.receipt.bundle, input.bundle); assert.deepEqual(closure.receipt.publication, input.publication);
        assert.deepEqual(closure.receipt.verification, input.verification);
        const head = closure.chain.nodes.at(-1)!;
        assert.equal(head.record.event, "ready"); assert.equal(head.record.phase, "snapshot_ready");
        assert.deepEqual(head.record.previous, f.capture.reference); assert.equal(head.record.sequence, f.capture.record.sequence + 1);
        assert.equal(head.record.ownerGeneration, f.capture.record.ownerGeneration); assert.equal(head.record.fenceEpoch, f.capture.record.fenceEpoch);
        assertFrozenSourceUnchanged(await lock.observe(), closure.manifests, closure.chain);
        return result;
      });
      assert.deepEqual(windows, ["snapshot", "control"], "D/V must close its snapshot before R/Jr enters a fresh control window");
      const [control] = await f.query("SELECT admission,journal_record_ref,journal_digest,journal_sequence,owner_generation FROM storage_maintenance");
      assert.equal(control!.admission, "sealed"); assert.equal(control!.journal_record_ref, staged.journal.ref);
      assert.equal(control!.journal_digest, staged.journal.sha256); assert.equal(Number(control!.journal_sequence), staged.ref.journalSequence);
      assert.equal(Number(control!.owner_generation), f.capture.record.ownerGeneration);
      const committed = await f.observe(), beforeNames = await artifacts(f.store.root);
      const again = await f.run(async lock => {
        t.mock.method(lock, "anchor", async () => { assert.fail("same request must not replay anchor SQL"); });
        t.mock.method(f.store, "putJson", async () => { assert.fail("same request must not publish new artifacts"); });
        return stageSnapshotReady(f.store, lock, f.mutex, input, f.request);
      });
      assert.deepEqual(again, staged); assert.deepEqual((await f.observe()).state, committed.state);
      assert.deepEqual(await artifacts(f.store.root), beforeNames); t.mock.restoreAll();
      await assert.rejects(f.run(lock => stageSnapshotReady(f.store, lock, f.mutex, input,
        { ...f.request, expectedJournalDigest: staged.journal.sha256 })), error => error instanceof MaintenanceFailure && error.code === "request_conflict");
      await assert.rejects(f.run(lock => stageSnapshotReady(f.store, lock, f.mutex, { ...input, verification: f.filesRef },
        f.request)), error => error instanceof MaintenanceFailure && error.code === "request_conflict");
      assert.deepEqual((await f.observe()).state, committed.state);
    } finally { t.mock.restoreAll(); await f.close(); }
  });

nativeTest("#152 R: fixed request, plan, source and V/B/U bindings reject before receipt or CAS", async t => {
  const f = await snapshotReadyFixture();
  try {
    const input = await f.prepare();
    const value = parseVerification(await f.store.readJson(input.verification, "verification"));
    const wrongV = await f.store.putJson("verification", { ...value, publication: input.bundle });
    for (const fault of ["source", "plan", "phase", "head", "role", "verification", "key"] as const) await t.test(fault, async () => {
      const before = await artifacts(f.store.root); let anchors = 0;
      const request = { ...f.request }, refs = { ...input };
      if (fault === "source") request.expectedSource = { ...request.expectedSource, identityDigest: "f".repeat(64) };
      if (fault === "plan") request.plan = { ...request.plan, planDigest: "f".repeat(64) };
      if (fault === "phase") request.expectedPhase = "planned";
      if (fault === "head") request.expectedJournalDigest = "f".repeat(64);
      if (fault === "role") refs.bundle = refs.publication;
      if (fault === "verification") refs.verification = wrongV;
      if (fault === "key") request.requestId = f.capture.record.requestId;
      const expected = fault === "source" ? "source_changed" : fault === "plan" ? "plan_stale"
        : ["phase", "head"].includes(fault) ? "phase_conflict" : fault === "key" ? "request_conflict" : "snapshot_invalid";
      try {
        await assert.rejects(f.run(async lock => {
          const anchor = lock.anchor.bind(lock);
          t.mock.method(lock, "anchor", async (...args: Parameters<typeof anchor>) => { anchors++; return anchor(...args); });
          return stageSnapshotReady(f.store, lock, f.mutex, refs, request);
        }), error => error instanceof MaintenanceFailure && error.code === expected);
        assert.equal(anchors, 0); assert.deepEqual(await artifacts(f.store.root), before);
        assert.deepEqual((await f.observe()).state, f.sealed.state);
      } finally { t.mock.restoreAll(); }
    });
  } finally { t.mock.restoreAll(); await f.close(); }
});

nativeTest("#152 R: each actual R/Jr durable publication boundary rejects without selecting its orphan", async t => {
  const f = await snapshotReadyFixture(), open = ArtifactStore.open, put = ArtifactStore.prototype.putJson;
  try {
    const input = await f.prepare();
    for (const kind of ["receipt", "journal"] as const) for (const point of ["temp_written", "file_synced", "renamed", "directory_synced"] as const) {
      await t.test(`${kind}/${point}`, async () => {
        const failure = point === "temp_written" ? undefined : Object.freeze(new Error(`${kind}-${point}`));
        let active: string | undefined, hit = 0, anchors = 0, rejected = false;
        try {
          t.mock.method(ArtifactStore.prototype, "putJson", async function(this: ArtifactStore, ...args: Parameters<typeof put>) {
            active = args[0]; try { return await Reflect.apply(put, this, args); } finally { active = undefined; }
          });
          t.mock.method(ArtifactStore, "open", (...[root, source, options]: Parameters<typeof open>) => open(root, source, { ...options,
            after: async reached => { await options?.after?.(reached); if (active === kind && reached === point) { hit++; throw failure; } },
          }));
          try {
            await f.run(async lock => {
              const anchor = lock.anchor.bind(lock);
              t.mock.method(lock, "anchor", async (...args: Parameters<typeof anchor>) => { anchors++; return anchor(...args); });
              return stageSnapshotReady(f.store, lock, f.mutex, input, { ...f.request, requestId: `failure-${kind}-${point}` });
            });
          } catch (error) { rejected = true; assert.equal(error, failure); }
          assert.equal(rejected, true); assert.equal(hit, 1); assert.equal(anchors, 0);
          t.mock.restoreAll(); assert.deepEqual((await f.observe()).state, f.sealed.state);
        } finally { t.mock.restoreAll(); }
      });
    }
    assert.ok((await artifacts(f.store.root)).some(name => name.endsWith("/receipt.json")), "durable unselected R orphans are retained");
    assert.deepEqual((await f.observe()).state, f.sealed.state);
  } finally { t.mock.restoreAll(); await f.close(); }
});

for (const fault of ["payload", "verification"] as const) nativeTest(`#152 R: ${fault} byte change after Jr publication is caught before CAS`, async t => {
  const f = await snapshotReadyFixture(), put = ArtifactStore.prototype.putJson; let anchors = 0, changed = false;
  try {
    const input = await f.prepare();
    await assert.rejects(f.run(async lock => {
      const anchor = lock.anchor.bind(lock);
      const victim = fault === "verification" ? input.verification : f.files.entries.find(entry => entry.kind === "file")!.payload!;
      t.mock.method(lock, "anchor", async (...args: Parameters<typeof anchor>) => { anchors++; return anchor(...args); });
      t.mock.method(ArtifactStore.prototype, "putJson", async function(this: ArtifactStore, ...args: Parameters<typeof put>) {
        const result = await Reflect.apply(put, this, args);
        if (args[0] === "journal" && (args[1] as { event?: string }).event === "ready") {
          const bytes = await readFile(f.store.pathFor(victim)); bytes[0] = bytes[0]! ^ 1;
          await writeFile(f.store.pathFor(victim), bytes); changed = true;
        }
        return result;
      });
      return stageSnapshotReady(f.store, lock, f.mutex, input, f.request);
    }), error => error instanceof MaintenanceFailure && error.code === "snapshot_invalid");
    assert.equal(changed, true); assert.equal(anchors, 0); t.mock.restoreAll();
    assert.deepEqual((await f.observe()).state, f.sealed.state);
  } finally { t.mock.restoreAll(); await f.close(); }
});

for (const fault of ["source-roster", "mutex"] as const) nativeTest(`#152 R: actual ${fault} change after R blocks ready CAS`, async t => {
  const f = await snapshotReadyFixture(), put = ArtifactStore.prototype.putJson, prepare = Database.prototype.prepare;
  let held: Database.Database | undefined, changed = false, anchors = 0;
  try {
    const input = await f.prepare();
    await assert.rejects(f.run(async lock => {
      const anchor = lock.anchor.bind(lock);
      t.mock.method(lock, "anchor", async (...args: Parameters<typeof anchor>) => { anchors++; return anchor(...args); });
      t.mock.method(Database.prototype, "prepare", function(this: Database.Database, sql: string) {
        if (this.name === f.file && this.inTransaction && !this.readonly) held = this;
        return prepare.call(this, sql);
      });
      t.mock.method(ArtifactStore.prototype, "putJson", async function(this: ArtifactStore, ...args: Parameters<typeof put>) {
        const result = await Reflect.apply(put, this, args);
        if (args[0] === "receipt") {
          if (fault === "mutex") await f.mutex.release();
          else {
            assert(held?.inTransaction);
            assert.equal(held.prepare("UPDATE storage_source_clients SET last_observed_at=last_observed_at || 'changed'").run().changes, 1);
          }
          changed = true;
        }
        return result;
      });
      return stageSnapshotReady(f.store, lock, f.mutex, input, f.request);
    }), error => error instanceof MaintenanceFailure && error.code === (fault === "mutex" ? "maintenance_lost" : "source_changed"));
    assert.equal(changed, true); assert.equal(anchors, 0); t.mock.restoreAll();
    assert.deepEqual((await f.observe()).state, f.sealed.state);
    assert.deepEqual((await f.observe()).manifests, f.sealed.manifests, "the failed transaction does not retain the injected roster change");
  } finally { t.mock.restoreAll(); await f.close(); }
});

for (const after of [false, true]) nativeTest(`#152 R: CAS ${after ? "response" : "dispatch"} failure rolls back and orphan cannot imply ready`, async t => {
  const f = await snapshotReadyFixture(), failure = Object.freeze(new Error("ready-anchor-failure"));
  let input!: { bundle: ArtifactRef; publication: ArtifactRef; verification: ArtifactRef }, calls = 0;
  try {
    input = await f.prepare();
    await assert.rejects(f.run(async lock => {
      const anchor = lock.anchor.bind(lock);
      t.mock.method(lock, "anchor", async (...args: Parameters<typeof anchor>) => { calls++; if (after) await anchor(...args); throw failure; });
      return stageSnapshotReady(f.store, lock, f.mutex, input, f.request);
    }), error => error === failure);
    assert.equal(calls, 1); t.mock.restoreAll();
    assert.deepEqual((await f.observe()).state, f.sealed.state);
    assert.ok((await artifacts(f.store.root)).some(name => name.endsWith("/receipt.json")));
    const staged = await f.run(async lock => {
      const anchor = lock.anchor.bind(lock);
      t.mock.method(lock, "anchor", async (...args: Parameters<typeof anchor>) => { calls++; return anchor(...args); });
      return stageSnapshotReady(f.store, lock, f.mutex, input, f.request);
    });
    assert.equal(calls, 2, "only the explicit second invocation can attempt a new anchor");
    assert.equal((await f.observe()).state.journalDigest, staged.journal.sha256);
  } finally { t.mock.restoreAll(); await f.close(); }
});

for (const event of ["takeover", "cancel_intent"] as const) nativeTest(`#152 R: ${event} after capture cannot consume the old D/V as a first ready step`, async () => {
  const f = await snapshotReadyFixture();
  try {
    const input = await f.prepare();
    await f.run(async lock => {
      const observed = await lock.observe();
      const record = { ...f.capture.record, event, sequence: f.capture.record.sequence + 1, previous: f.capture.reference,
        ownerGeneration: observed.state.ownerGeneration + (event === "takeover" ? 1 : 0),
        requestId: `fixture-${event}`, requestDigest: digestJson({ event }), frozen: null, sourceClients: null };
      const journal = await f.store.putJson("journal", record);
      await lock.anchor({ expected: observed.state, admission: "sealed", fenceEpoch: observed.state.fenceEpoch,
        ownerGeneration: record.ownerGeneration, activeMigrationId: observed.state.activeMigrationId, planDigest: observed.state.planDigest,
        controlRootIdentity: { ...f.store.identity }, mutexIdentity: f.mutex.identity, journal, journalSequence: record.sequence });
    });
    const before = await f.observe(), names = await artifacts(f.store.root);
    await assert.rejects(f.run(lock => stageSnapshotReady(f.store, lock, f.mutex, input, f.request)),
      error => error instanceof MaintenanceFailure && error.code === "phase_conflict");
    assert.deepEqual((await f.observe()).state, before.state); assert.deepEqual(await artifacts(f.store.root), names);
  } finally { await f.close(); }
});

for (const kind of ["sqlite", "postgres"] as const) (kind === "sqlite" ? nativeTest : pgTest)(
  `#152 R ${kind}: transaction-local ready never hides actual outer COMMIT or source close failure`, async t => {
    for (const point of ["commit-before", "commit-after", "close-before", "close-after"] as const) await t.test(point, async child => {
      const f = await snapshotReadyFixture(kind), exec = Database.prototype.exec, prepare = Database.prototype.prepare, close = Database.prototype.close;
      const query = Client.prototype.query, end = Client.prototype.end;
      const failure = point === "close-after" ? undefined : new MaintenanceFailure("maintenance_lost", point);
      let sqliteWriter: Database.Database | undefined, pgWriter: Client | undefined, sourceLock: SourceLock | undefined;
      let input!: Awaited<ReturnType<typeof f.prepare>>, staged: Awaited<ReturnType<typeof stageSnapshotReady>> | undefined;
      let anchors = 0, injections = 0, sourceCommits = 0, closeAttempts = 0, closeReturns = 0, rejected = false, rejection: unknown;
      try {
        input = await f.prepare();
        assert(f.snapshotLock);
        await assert.rejects(f.snapshotLock.assertHeld(), { code: "maintenance_lost" });
        try {
          await f.run(async lock => {
            sourceLock = lock;
            assert.notStrictEqual(lock, f.snapshotLock);
            // Start only after the actual D/V snapshot transaction and close have finished.
            // The selected writer is the real native R/Jr anchor session, not a fresh schema reader.
            if (kind === "sqlite") {
              child.mock.method(Database.prototype, "prepare", function(this: Database.Database, sql: string) {
                if (this.name === f.file && sql.startsWith("UPDATE storage_maintenance SET admission=")) { sqliteWriter = this; anchors++; }
                return prepare.call(this, sql);
              });
              child.mock.method(Database.prototype, "exec", function(this: Database.Database, sql: string) {
                if (this === sqliteWriter && sql === "COMMIT") {
                  sourceCommits++;
                  if (point === "commit-before") { injections++; throw failure; }
                }
                const result = exec.call(this, sql);
                if (this === sqliteWriter && sql === "COMMIT" && point === "commit-after") { injections++; throw failure; }
                return result;
              });
              child.mock.method(Database.prototype, "close", function(this: Database.Database) {
                if (this === sqliteWriter) {
                  closeAttempts++;
                  if (point === "close-before") { injections++; throw failure; }
                }
                const result = close.call(this);
                if (this === sqliteWriter) {
                  closeReturns++;
                  if (point === "close-after") { injections++; throw failure; }
                }
                return result;
              });
            } else {
              child.mock.method(Client.prototype, "query", async function(this: Client, ...args: unknown[]) {
                const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | null)?.text ?? "";
                const database = (this as unknown as { connectionParameters: { database: string } }).connectionParameters.database;
                if (database === f.database && sql.startsWith("UPDATE storage_maintenance SET admission=")) { pgWriter = this; anchors++; }
                if (this === pgWriter && sql === "COMMIT") {
                  sourceCommits++;
                  if (point === "commit-before") { injections++; throw failure; }
                }
                const result = await Reflect.apply(query, this, args);
                if (this === pgWriter && sql === "COMMIT" && point === "commit-after") { injections++; throw failure; }
                return result;
              } as typeof query);
              child.mock.method(Client.prototype, "end", async function(this: Client) {
                if (this === pgWriter) {
                  closeAttempts++;
                  if (point === "close-before") { injections++; throw failure; }
                }
                await Reflect.apply(end, this, []);
                if (this === pgWriter) {
                  closeReturns++;
                  if (point === "close-after") { injections++; throw failure; }
                }
              } as typeof end);
            }
            staged = await stageSnapshotReady(f.store, lock, f.mutex, input, f.request);
            return staged;
          });
        } catch (error) { rejected = true; rejection = error; }
        assert.equal(rejected, true); assert.equal(rejection, failure);
        assert(staged && sourceLock, "the stage returned, but the caller's real outer operation failed");
        assert.equal(anchors, 1); assert.equal(sourceCommits, 1); assert.equal(injections, 1);
        assert.equal(closeAttempts, 1); assert.equal(closeReturns, point === "close-before" ? 0 : 1);
        const outcome = await controlSqlOutcome(sourceLock);
        assert.equal(outcome.status, "unknown", "ordinary stage facts are not a committed control-SQL certificate");
        assert.equal(outcome.commitStarted, true);
        assert.equal(outcome.commitReturned, point.startsWith("close"));
        assert.equal(outcome.closeFailureObserved, point.startsWith("close"));
        assert.equal(outcome.localSourceHandleClosed, point !== "close-before");
        assert.equal(Object.hasOwn(outcome, "originalError"), false);
        assert.equal(Object.hasOwn(outcome, "closeError"), false);
        await assert.rejects(sourceLock.assertHeld(), { code: "maintenance_lost" });
        child.mock.restoreAll();

        // A fresh independent source read, not the bool above, classifies the actual commit.
        const committed = point !== "commit-before", actual = await f.observe();
        assert.equal(actual.state.journalDigest, committed ? staged.journal.sha256 : f.capture.reference.sha256);
        assert.equal(actual.state.journalSequence, f.sealed.state.journalSequence + (committed ? 1 : 0));
        assert.equal(actual.state.ownerGeneration, f.sealed.state.ownerGeneration);
        assert.equal(actual.state.fenceEpoch, f.sealed.state.fenceEpoch);
        assert.equal(actual.manifests.frozenBusinessManifestDigest, f.sealed.manifests.frozenBusinessManifestDigest);
        const savedArtifacts = await artifacts(f.store.root);
        assert.equal(anchors, 1, "failure never retries an anchor by itself");
        await f.mutex.release(); await f.adapter.close();
        if (kind === "sqlite") assert.equal(sqliteWriter!.open, false, "explicit cleanup closes the retained before-close owner");
        else {
          const pid = (pgWriter as unknown as { processID: number }).processID;
          assert(Number.isSafeInteger(pid) && pid > 0);
          assert.equal((await f.query(`SELECT count(*)::text AS count FROM pg_stat_activity WHERE pid=${pid}`))[0]!.count, "0");
        }

        const fresh = await f.createAdapter();
        try {
          const mutex = await fresh.acquireMutex(f.store.identity, (await fresh.observe()).state);
          try {
            let newAnchors = 0;
            const result = await fresh.withSourceLock("control", async lock => {
              const anchor = lock.anchor.bind(lock);
              child.mock.method(lock, "anchor", async (...args: Parameters<typeof anchor>) => { newAnchors++; return anchor(...args); });
              return stageSnapshotReady(f.store, lock, mutex, input, f.request);
            });
            assert.deepEqual(result, staged);
            assert.equal(newAnchors, committed ? 0 : 1, "only an explicit fresh invocation may finish an uncommitted stage");
            assert.deepEqual(await artifacts(f.store.root), savedArtifacts, "existing exact immutable objects confer no automatic source advancement");
            assert.equal((await f.observe()).state.journalDigest, staged.journal.sha256);
          } finally { await mutex.release(); }
        } finally { await fresh.close(); }
      } finally { child.mock.restoreAll(); await f.close(); }
    });
  });
